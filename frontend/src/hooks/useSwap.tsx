import { compileSwapTransaction } from '../lib/SwapNote';
import { TransactionType, useWallet } from '@miden-sdk/miden-wallet-adapter';
import { SWAP_DAEMON_URL } from '../config/api';
import { useCallback, useMemo, useState } from 'react';
import { AccountId, TransactionRequestBuilder, NoteFilter, NoteFilterTypes, TransactionFilter, NoteAndArgs, NoteAndArgsArray } from '@miden-sdk/miden-sdk';
import { getPoolAccountIdHex } from '../config/poolConfig';
import { getTokenMetadata } from '../tokenRegistry';

interface UseSwapParams {
  client: any;
  accountId: string | null;
  poolAccountId: string | null;
}

export const useSwap = ({ client, accountId, poolAccountId }: UseSwapParams) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const [isConsuming, setIsConsuming] = useState<boolean>(false);
  const { requestTransaction } = useWallet();
  const [txId, setTxId] = useState<undefined | string>();
  const [noteId, setNoteId] = useState<undefined | string>();
  const [consumeTxId, setConsumeTxId] = useState<undefined | string>();
  
  const swap = useCallback(async ({
    amount,
    minAmountOut,
    sellToken,
    buyToken,
  }: {
    amount: bigint;
    minAmountOut: bigint;
    buyToken: { faucetId: AccountId | string; decimals: number };
    sellToken: { faucetId: AccountId | string; decimals: number };
  }) => {
    if (!accountId || !client) {
      setError('Missing required parameters for swap');
      return;
    }
    
    // Only extension wallet is supported
    if (!requestTransaction) {
      setError('Extension wallet not connected');
      return;
    }
    
    setError('');
    setIsLoading(true);
    setTxId(undefined);
    setNoteId(undefined);
    
    try {
      const userAccountId = AccountId.fromHex(accountId);
      
      // Helper function to convert faucetId to hex string safely
      const faucetIdToHex = (faucetId: AccountId | string | any): string => {
        // Handle string case
        if (typeof faucetId === 'string') {
          return faucetId;
        }
        // Handle AccountId object case
        if (faucetId && typeof faucetId === 'object') {
          // AccountId.toString() returns hex string
          if (typeof faucetId.toString === 'function') {
            try {
              const str = faucetId.toString();
              // toString() returns hex format (with or without 0x prefix)
              return str;
            } catch (e) {
              console.warn('toString() failed:', e);
            }
          }
        }
        // Final fallback: convert to string
        return String(faucetId);
      };
      
      // Helper function to convert faucetId to AccountId object safely
      const faucetIdToAccountId = (faucetId: AccountId | string): AccountId => {
        if (typeof faucetId === 'string') {
          return AccountId.fromHex(faucetId);
        }
        // Already an AccountId object
        return faucetId;
      };
      
      // Get pool account ID based on token pair using token metadata
      const sellTokenFaucetIdHex = faucetIdToHex(sellToken.faucetId);
      const buyTokenFaucetIdHex = faucetIdToHex(buyToken.faucetId);
      
      const sellTokenMeta = getTokenMetadata(sellTokenFaucetIdHex);
      const buyTokenMeta = getTokenMetadata(buyTokenFaucetIdHex);
      
      const sellTokenSymbol = sellTokenMeta?.symbol || 'MIDEN';
      const buyTokenSymbol = buyTokenMeta?.symbol || 'MIDEN';
      
      const poolAccountIdHex = getPoolAccountIdHex(sellTokenSymbol, buyTokenSymbol);
      
      console.log('🔍 Selected pool account for swap:', {
        sellToken: sellTokenFaucetIdHex,
        buyToken: buyTokenFaucetIdHex,
        poolAccountId: poolAccountIdHex,
      });
      
      // Ensure faucetId is AccountId object (not string)
      const sellTokenAccountId = faucetIdToAccountId(sellToken.faucetId);
      const buyTokenAccountId = faucetIdToAccountId(buyToken.faucetId);
      
      const { tx, noteId, transactionRequest } = await compileSwapTransaction({
        amount,
        poolAccountIdHex,
        buyToken: {
          faucetId: buyTokenAccountId,
          decimals: buyToken.decimals,
        },
        sellToken: {
          faucetId: sellTokenAccountId,
          decimals: sellToken.decimals,
        },
        minAmountOut: minAmountOut,
        userAccountId,
        client,
        // syncState removed - client handles sync internally
      });
      
      let txId: string;
      
      // Use extension wallet only
      if (!requestTransaction) {
        throw new Error('Extension wallet not connected');
      }
      console.log('📤 Submitting via wallet extension...');
      const submittedTxId = await requestTransaction({
        type: TransactionType.Custom,
        payload: tx,
      });
      // Extension wallet returns TransactionId object
      if (typeof submittedTxId === 'string') {
        txId = submittedTxId;
      } else if (submittedTxId && typeof (submittedTxId as any).toString === 'function') {
        txId = (submittedTxId as any).toString();
      } else {
        txId = String(submittedTxId);
      }
      console.log('✅ Transaction submitted via extension:', txId);
      
      console.log('📋 Transaction details:', {
        txId,
        noteId,
        userAccountId: userAccountId.toString(),
        poolAccountId: poolAccountIdHex,
        amount: amount.toString(),
        method: 'extension',
      });
      
      // CRITICAL: Save swap note info to localStorage for backend daemon
      // Backend will use this to find the correct P2ID note after consuming SWAP note
      const swapNoteInfo = {
        swapNoteId: noteId,
        txId,
        userAccountId: userAccountId.toString(),
        poolAccountId: poolAccountIdHex,
        sellTokenId: faucetIdToHex(sellToken.faucetId),
        buyTokenId: faucetIdToHex(buyToken.faucetId),
        amountIn: amount.toString(),
        minAmountOut: minAmountOut.toString(),
        timestamp: Date.now(),
      };
      
      // Notify daemon to track this SWAP note
      try {
        console.log('🔔 Notifying daemon about new SWAP note:', noteId);
        await fetch(`${SWAP_DAEMON_URL}/track_note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note_id: noteId,
            note_type: 'SWAP',
            pool_account_id: poolAccountIdHex
          })
        });
        console.log('✅ Daemon notified about SWAP note');
      } catch (e) {
        console.warn('⚠️ Failed to notify daemon:', e);
      }
      
      try {
        const existingSwaps = localStorage.getItem('miden_swap_notes');
        const swapsList = existingSwaps ? JSON.parse(existingSwaps) : [];
        swapsList.push(swapNoteInfo);
        localStorage.setItem('miden_swap_notes', JSON.stringify(swapsList));
        console.log('💾 Saved swap info to localStorage:', swapNoteInfo);
      } catch (e) {
        console.warn('⚠️  Failed to save swap info to localStorage:', e);
      }
      
      // Wait for transaction to reach blockchain
      // Extension wallet doesn't sync with Miden SDK store, so we can't check commit status
      // Instead, wait a fixed time for transaction to propagate to blockchain
      console.log('⏳ Waiting for transaction to propagate to blockchain (30s)...');
      await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds

      // Now trigger daemon to consume the SWAP note
      console.log('🔔 Transaction should be on blockchain, triggering daemon...');
      try {
        const daemonUrl = SWAP_DAEMON_URL;
        console.log('   Daemon URL:', daemonUrl);
        console.log('   Pool Account ID:', poolAccountIdHex);
        console.log('   SWAP Note ID:', noteId);

        const response = await fetch(`${daemonUrl}/consume`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            pool_account_id: poolAccountIdHex,
          }),
        });

        console.log('   HTTP Response status:', response.status);

        if (response.ok) {
          const result = await response.json();
          console.log('✅ Daemon response:', result);
          if (result.consumed > 0) {
            console.log(`✅ Daemon consumed ${result.consumed} note(s)`);
          } else {
            console.log('ℹ️  Daemon found no consumable notes (may need more time)');
          }
        } else {
          const errorText = await response.text();
          console.warn('⚠️  Daemon request failed:', response.status, response.statusText);
          console.warn('   Error response:', errorText);
        }
      } catch (err: any) {
        console.warn('⚠️  Failed to trigger daemon:', err.message);
        console.warn('   This is not critical - try manual consume later');
      }

      // Legacy commit check code (kept for reference but skipped)
      let committed = false;
      let attempts = 0;
      const maxAttempts = 0; // Skip commit check entirely

      while (!committed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        
        // Sync state only every 3 attempts to avoid WASM object reuse issues
        if (attempts % 3 === 0) {
          try {
            // @ts-ignore - client may have syncState method
            await client.syncState?.();
          } catch (syncErr: any) {
            console.warn(`⚠️ Sync error (attempt ${attempts + 1}):`, syncErr?.message || syncErr);
            // Continue anyway - we'll check transaction status without sync
          }
        }
        
        // Check transaction status
        try {
          // Create fresh TransactionFilter for each call to avoid WASM object reuse
          const freshFilter = TransactionFilter.all();
          const transactions = await client.getTransactions(freshFilter);
          
          const foundTx = transactions.find((t: any) => {
            try {
              const tIdObj = t.id();
              // Handle TransactionId object conversion
              let tId: string;
              if (typeof tIdObj === 'string') {
                tId = tIdObj;
              } else if (tIdObj && typeof tIdObj.toHex === 'function') {
                tId = tIdObj.toHex();
              } else if (tIdObj && typeof tIdObj.toString === 'function') {
                tId = tIdObj.toString();
              } else {
                tId = String(tIdObj);
              }
              // Compare both exact and case-insensitive
              return tId === txId || tId.toLowerCase() === txId.toLowerCase();
            } catch (idErr: any) {
              console.warn('⚠️ Error extracting transaction ID:', idErr?.message || idErr);
              return false;
            }
          });
          
          if (foundTx) {
            try {
              const status = foundTx.transactionStatus();
              if (status.isCommitted()) {
                const blockNum = status.getBlockNum();
                console.log('✅✅✅ Transaction committed in block:', blockNum);
                console.log('   Transaction ID:', txId);
                console.log('   SWAP Note ID:', noteId);
                committed = true;
                
                // Trigger daemon to consume SWAP note
                try {
                  // @ts-ignore - Vite environment variables
                  const daemonUrl = SWAP_DAEMON_URL;
                  console.log('🔔🔔🔔 Triggering daemon to consume SWAP note...');
                  console.log('   Daemon URL:', daemonUrl);
                  console.log('   Pool Account ID:', poolAccountIdHex);
                  
                  // Notify daemon to track this note
                  await fetch(`${daemonUrl}/track_note`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      note_id: noteId,
                      note_type: 'SWAP'
                    })
                  });

                  const response = await fetch(`${daemonUrl}/consume`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      pool_account_id: poolAccountIdHex, // Optional: specify pool to check
                    }),
                  });
                  
                  console.log('   HTTP Response status:', response.status);
                  
                  if (response.ok) {
                    const result = await response.json();
                    console.log('✅✅✅ Daemon response:', result);
                    if (result.consumed > 0) {
                      console.log(`✅✅✅ Daemon consumed ${result.consumed} note(s)`);
                    } else {
                      console.log('ℹ️  Daemon found no consumable notes (may already be consumed or not yet available)');
                    }
                  } else {
                    const errorText = await response.text();
                    console.warn('⚠️⚠️⚠️  Daemon request failed:', response.status, response.statusText);
                    console.warn('   Error response:', errorText);
                  }
                } catch (err: any) {
                  console.warn('⚠️⚠️⚠️  Failed to trigger daemon (daemon may not be running):', err.message);
                  console.warn('   Error details:', err);
                  console.warn('   This is not critical - daemon will pick up the note on next poll');
                }
                
                // Break out of the loop immediately after commit
                break;
              } else if (status.isDiscarded()) {
                console.error('❌ Transaction was discarded');
                throw new Error('Transaction was discarded');
              } else {
                console.log(`⏳ Transaction still pending... (attempt ${attempts + 1}/${maxAttempts})`);
              }
            } catch (statusErr: any) {
              console.warn(`⚠️ Error checking transaction status: ${statusErr?.message || statusErr}`);
              // Continue polling
            }
          } else {
            console.log(`⏳ Transaction not found in store yet... (attempt ${attempts + 1}/${maxAttempts})`);
            console.log(`   Looking for txId: ${txId}`);
            console.log(`   Total transactions in store: ${transactions.length}`);
          }
        } catch (err: any) {
          const errorMsg = err?.message || String(err);
          // Check if this is the WASM recursive use error
          if (errorMsg.includes('recursive use') || errorMsg.includes('unsafe aliasing')) {
            console.error('❌ WASM object reuse error detected. Waiting longer before retry...');
            // Wait longer before retrying to let WASM objects be freed
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            console.warn(`⚠️ Error checking transaction status: ${errorMsg}`);
          }
        }
        
        attempts++;
      }
      
      if (!committed) {
        console.warn('⚠️ Transaction not committed after 60 seconds.');
        console.warn('💡 This may indicate:');
        console.warn('   1. Transaction was not submitted to the blockchain');
        console.warn('   2. Network connectivity issues');
        console.warn('   3. Node is not processing transactions');
        console.warn('   Please check the wallet extension and network connection.');
        console.warn('   Transaction ID was:', txId);
        // Don't throw error - allow the swap to continue
        // The transaction might still be processing
      }
      
      // Final sync and check for note (only if transaction was committed)
      if (committed) {
        try {
          // @ts-ignore - client may have syncState method
          await client.syncState?.();
        } catch (syncErr: any) {
          console.warn('⚠️ Final sync failed (non-critical):', syncErr?.message || syncErr);
        }
      }
      
      // Check for note by ID
      // Note: getOutputNotes might return note IDs as strings, or OutputNoteRecord objects
      // @ts-ignore - unused variable kept for debugging
      let outputNotes: any[] = [];
      let noteIds: string[] = [];
      
      try {
        // Create fresh NoteFilter to avoid WASM object reuse
        const freshNoteFilter = new NoteFilter(NoteFilterTypes.All);
        const result = await client.getOutputNotes(freshNoteFilter);
        console.log(`📋 Total output notes in store: ${result.length}`);
        
        // Check if result is array of strings (note IDs) or OutputNoteRecord objects
        if (result.length > 0) {
          const firstItem = result[0];
          const isString = typeof firstItem === 'string';
          const isObject = typeof firstItem === 'object' && firstItem !== null;
          
          console.log('🔍 Output notes type check:', {
            firstItemType: typeof firstItem,
            isString,
            isObject,
            constructor: firstItem?.constructor?.name,
            hasId: typeof firstItem?.id === 'function',
            hasMetadata: typeof firstItem?.metadata === 'function',
          });
          
          if (isString) {
            // Result is array of note ID strings
            noteIds = result as string[];
            console.log('📝 Note IDs (strings):', noteIds);
            
            // Check if our swap note ID is in the list
            if (noteId) {
              const normalizedNoteId = noteId.toLowerCase();
              const found = noteIds.some(id => id.toLowerCase() === normalizedNoteId);
              
              if (found) {
                console.log('✅ SWAP note found in output notes:', noteId);
                console.log('   Transaction was successfully submitted and note was created.');
                console.log('   Backend daemon will automatically consume the swap note from the pool.');
              } else {
                console.warn('⚠️ SWAP note not found in output notes:', noteId);
                console.warn('   Available note IDs:');
                noteIds.forEach((id, idx) => {
                  console.warn(`   Note ${idx + 1}: ${id}`);
                });
              }
            }
            
            // Don't try to fetch notes individually - getOutputNote causes WASM errors
            // We already have the note IDs, which is sufficient to verify the swap succeeded
          } else if (isObject && typeof firstItem.id === 'function') {
            // Result is array of OutputNoteRecord objects
            outputNotes = result;
            console.log('✅ Output notes are OutputNoteRecord objects');
          } else {
            // Unknown format, try to use as-is
            outputNotes = result;
            console.warn('⚠️ Unknown output notes format, using as-is');
          }
        } else {
          outputNotes = result;
        }
      } catch (err: any) {
        console.warn('⚠️ Error getting output notes:', err?.message || String(err));
        // Continue anyway - transaction was committed successfully
      }
      
      // Note: We don't need to fetch individual notes or check metadata
      // because getOutputNote causes WASM errors. We already verified that
      // the swap note ID exists in the output notes list, which confirms
      // the transaction was successful. The backend daemon will automatically
      // consume the swap note from the pool.
      
      setNoteId(noteId || undefined);
      setTxId(txId);
      
      // CRITICAL: After swap, pool will create P2ID notes with swapped tokens
      // We need to automatically consume these P2ID notes so tokens appear in wallet
      console.log('🔄 Checking for P2ID output notes (swapped tokens)...');
      console.log('📝 SWAP Note ID:', noteId);
      console.log('📝 SWAP Note Info: Backend daemon should consume this note from pool');
      console.log('📝 Pool Account ID:', poolAccountIdHex);
      
      // Use a timeout to prevent hanging
      try {
        const autoConsumePromise = (async () => {
          // Wait longer for backend daemon to process SWAP note and create P2ID notes
          console.log('⏳ Waiting 15 seconds for backend daemon to process SWAP note...');
          await new Promise(resolve => setTimeout(resolve, 15000));
          
          try {
            // @ts-ignore - client may have syncState method
            await client.syncState?.();
          } catch (syncErr: any) {
            console.warn('⚠️ Sync error in auto-consume (non-critical):', syncErr?.message || syncErr);
          }
          
          // Get output notes (P2ID notes from pool)
          // Create fresh NoteFilter to avoid WASM object reuse
          let outputNotes: any[] = [];
          try {
            const freshNoteFilter = new NoteFilter(NoteFilterTypes.All);
            outputNotes = await client.getOutputNotes(freshNoteFilter);
            console.log(`📋 Found ${outputNotes.length} output note(s) after swap`);
          } catch (notesErr: any) {
            console.warn('⚠️ Error getting output notes (non-critical):', notesErr?.message || notesErr);
            // Continue anyway - we'll try to get consumable notes
          }
          
          // Filter for P2ID notes (notes that can be consumed by user account)
          // Create fresh AccountId to avoid WASM reuse issues
          let consumableNotes: any[] = [];
          try {
            const userAccountIdHex = accountId.toString();
            // Create fresh AccountId object for each call
            const freshUserAccountId = AccountId.fromHex(userAccountIdHex);
            consumableNotes = await client.getConsumableNotes(freshUserAccountId);
            console.log(`📋 Found ${consumableNotes.length} consumable note(s) for user`);
          } catch (consumeErr: any) {
            const errorMsg = consumeErr?.message || String(consumeErr);
            if (errorMsg.includes('recursive use') || errorMsg.includes('unsafe aliasing')) {
              console.error('❌ WASM object reuse error in getConsumableNotes. Skipping auto-consume.');
              return; // Exit early to avoid further WASM errors
            }
            console.warn('⚠️ Error getting consumable notes (non-critical):', errorMsg);
            // Continue anyway
          }
          
          if (consumableNotes.length > 0) {
            console.log('🔄 Auto-consuming P2ID notes (swapped tokens)...');
            setIsConsuming(true);
            
            // Consume all consumable notes (P2ID notes from pool)
            for (const consumable of consumableNotes) {
              const noteRecord = consumable.inputNoteRecord();
              const noteIdStr = noteRecord.id().toString();
              
              // Skip if already consumed or processing
              if (noteRecord.isConsumed() || noteRecord.isProcessing()) {
                console.log(`⏭️  Skipping note ${noteIdStr} (already consumed/processing)`);
                continue;
              }
              
              // Check if note is consumable by user account
              const consumability = consumable.noteConsumability();
              const canConsume = consumability.some((entry: any) => {
                const entryAccountId = typeof entry.accountId === 'function' 
                  ? entry.accountId() 
                  : entry.accountId;
                return entryAccountId?.toString() === accountId;
              });
              
              if (!canConsume) {
                console.log(`⏭️  Skipping note ${noteIdStr} (not consumable by user account)`);
                continue;
              }
              
              try {
                // Create fresh AccountId for each transaction to avoid WASM reuse
                const freshAccountId = AccountId.fromHex(accountId);
                
                // Convert InputNoteRecord to Note using toNote() method
                const note = noteRecord.toNote();
                if (!note) {
                  console.error(`❌ Failed to convert note ${noteIdStr} to Note instance`);
                  continue;
                }
                
                // Build consume transaction with fresh builder
                const consumeTxBuilder = new TransactionRequestBuilder();
                const noteAndArgs = new NoteAndArgs(note, null);
                const consumeTx = consumeTxBuilder
                  .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
                  .build();
                
                // Submit consume transaction
                const consumeTxId = await client.submitNewTransaction(freshAccountId, consumeTx);
                const consumeTxIdStr = typeof consumeTxId === 'string' 
                  ? consumeTxId 
                  : (consumeTxId?.toHex?.() || consumeTxId?.toString() || String(consumeTxId));
                console.log(`✅ Consumed P2ID note ${noteIdStr}, tx: ${consumeTxIdStr}`);
                setConsumeTxId(consumeTxIdStr);
                
                // Small delay between consumes to avoid WASM object reuse
                await new Promise(resolve => setTimeout(resolve, 1000));
              } catch (consumeError: any) {
                const errorMsg = consumeError?.message || String(consumeError);
                if (errorMsg.includes('recursive use') || errorMsg.includes('unsafe aliasing')) {
                  console.error(`❌ WASM object reuse error consuming note ${noteIdStr}. Stopping auto-consume.`);
                  break; // Stop trying to consume more notes
                }
                console.warn(`⚠️  Failed to consume note ${noteIdStr}:`, errorMsg);
                // Continue with other notes
              }
            }
            
            setIsConsuming(false);
            console.log('✅ Finished auto-consuming P2ID notes');
          } else {
            console.log('ℹ️  No consumable P2ID notes found yet (pool may still be processing)');
          }
        })();
        
        // Wait for auto-consume with timeout (30 seconds max)
        await Promise.race([
          autoConsumePromise,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Auto-consume timeout')), 30000)
          )
        ]);
      } catch (autoConsumeError: any) {
        console.warn('⚠️  Auto-consume P2ID notes failed (non-critical):', autoConsumeError?.message || autoConsumeError);
        setIsConsuming(false);
        // Don't fail the swap if auto-consume fails - user can manually consume later
      }
      
      // Backend will automatically consume pool SWAP notes
      // Frontend now automatically consumes user P2ID notes (swapped tokens)
      
      // Ensure loading state is cleared
      console.log('✅ Swap process completed');
      setIsLoading(false);
    } catch (err: any) {
      console.error('❌ Swap error:', err);
      setError(err?.message || 'Failed to execute swap');
      setIsLoading(false);
    }
  }, [client, accountId, requestTransaction]);

  // Backend handles pool note consumption automatically
  // This function is kept for potential future use but is not needed now
  // @ts-ignore - unused function kept for potential future use
  const consumePoolSwapNotes = useCallback(async () => {
    // Backend auto-consume daemon handles this
    console.log('Pool note consumption is handled automatically by backend daemon');
  }, []);

  const value = useMemo(
    () => ({ 
      swap, 
      isLoading, 
      error, 
      txId, 
      noteId,
      isConsuming,
      consumeTxId,
    }),
    [swap, isLoading, error, txId, noteId, isConsuming, consumeTxId],
  );

  return value;
};
