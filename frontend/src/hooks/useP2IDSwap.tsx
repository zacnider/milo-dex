import { createP2IDSwapTransaction, storeSwapInfo, clearOldSwapInfo } from '../lib/P2IDSwap';
import { TransactionType, useWallet, CustomTransaction } from '@miden-sdk/miden-wallet-adapter';
import { SWAP_DAEMON_URL } from '../config/api';
import { useCallback, useMemo, useState } from 'react';
import { AccountId, TransactionRequestBuilder, NoteAndArgs, NoteAndArgsArray, NoteType } from '@miden-sdk/miden-sdk';
import { getPoolAccountIdHex } from '../config/poolConfig';
import { getTokenMetadata } from '../tokenRegistry';

interface UseP2IDSwapParams {
  client: any;
  accountId: string | null;
  poolAccountId: string | null;
}

export const useP2IDSwap = ({ client, accountId, poolAccountId }: UseP2IDSwapParams) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const { requestTransaction } = useWallet();
  const [txId, setTxId] = useState<undefined | string>();
  const [noteId, setNoteId] = useState<undefined | string>();

  const swap = useCallback(async ({
    amount,
    minAmountOut,
    sellToken,
    buyToken,
    isPrivate,
  }: {
    amount: bigint;
    minAmountOut: bigint;
    buyToken: { faucetId: AccountId | string; decimals: number };
    sellToken: { faucetId: AccountId | string; decimals: number };
    isPrivate?: boolean;
  }) => {
    if (!accountId || !client) {
      setError('Missing required parameters for swap');
      return;
    }

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

      // Helper to convert faucetId to hex
      const faucetIdToHex = (faucetId: AccountId | string | any): string => {
        if (typeof faucetId === 'string') return faucetId;
        if (faucetId && typeof faucetId === 'object') {
          if (typeof faucetId.toString === 'function') {
            try {
              return faucetId.toString();
            } catch (e) {
              console.warn('toString() failed:', e);
            }
          }
        }
        return String(faucetId);
      };

      // Helper to convert faucetId to AccountId
      const faucetIdToAccountId = (faucetId: AccountId | string): AccountId => {
        if (typeof faucetId === 'string') {
          return AccountId.fromHex(faucetId);
        }
        return faucetId;
      };

      // Get pool account ID based on token pair
      const sellTokenFaucetIdHex = faucetIdToHex(sellToken.faucetId);
      const buyTokenFaucetIdHex = faucetIdToHex(buyToken.faucetId);

      const sellTokenMeta = getTokenMetadata(sellTokenFaucetIdHex);
      const buyTokenMeta = getTokenMetadata(buyTokenFaucetIdHex);

      const sellTokenSymbol = sellTokenMeta?.symbol || 'MIDEN';
      const buyTokenSymbol = buyTokenMeta?.symbol || 'MIDEN';

      const poolAccountIdHex = getPoolAccountIdHex(sellTokenSymbol, buyTokenSymbol);

      console.log('🔍 Selected pool account for P2ID swap:', {
        sellToken: sellTokenFaucetIdHex,
        buyToken: buyTokenFaucetIdHex,
        poolAccountId: poolAccountIdHex,
      });

      // Clear old swap info
      clearOldSwapInfo();

      // Create P2ID swap transaction
      const { tx, noteId, swapInfo } = await createP2IDSwapTransaction({
        amount,
        poolAccountIdHex,
        buyToken: {
          faucetId: faucetIdToAccountId(buyToken.faucetId),
          decimals: buyToken.decimals,
        },
        sellToken: {
          faucetId: faucetIdToAccountId(sellToken.faucetId),
          decimals: sellToken.decimals,
        },
        minAmountOut,
        userAccountId,
        client,
        noteType: isPrivate ? NoteType.Private : NoteType.Public,
      });

      // Store swap info for daemon
      storeSwapInfo(swapInfo);

      // Submit via Extension Wallet
      console.log('📤 Submitting P2ID swap via wallet extension...');
      const submittedTxId = await requestTransaction({
        type: TransactionType.Custom,
        payload: tx,
      });

      let txIdStr: string;
      if (typeof submittedTxId === 'string') {
        txIdStr = submittedTxId;
      } else if (submittedTxId && typeof (submittedTxId as any).toString === 'function') {
        txIdStr = (submittedTxId as any).toString();
      } else {
        txIdStr = String(submittedTxId);
      }

      console.log('✅ P2ID swap transaction submitted:', txIdStr);
      console.log('📋 Note ID:', noteId);

      // Notify daemon about new P2ID swap note
      try {
        console.log('🔔 Notifying daemon about P2ID swap note...');
        await fetch(`${SWAP_DAEMON_URL}/track_note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note_id: noteId,
            note_type: 'P2ID_SWAP',
            pool_account_id: poolAccountIdHex,
            swap_info: swapInfo,
          })
        });
        console.log('✅ Daemon notified');
      } catch (e) {
        console.warn('⚠️ Failed to notify daemon:', e);
      }

      // Wait for auto-poll to pick up and process the swap
      // Propagation ~15s + auto-poll interval ~15s = ~25s total
      console.log('⏳ Waiting for daemon auto-poll to process swap (25s)...');
      await new Promise(resolve => setTimeout(resolve, 25000));
      const daemonProcessed = true; // Trust auto-poll to handle it

      setNoteId(noteId);
      setTxId(txIdStr);

      console.log('✅ P2ID swap process completed');
      console.log('📋 Summary:', {
        txId: txIdStr,
        noteId,
        poolAccountId: poolAccountIdHex,
        amount: amount.toString(),
        minAmountOut: minAmountOut.toString(),
      });

      // Auto-consume: if daemon processed the swap, wait for output note and consume it
      if (daemonProcessed && client && accountId && requestTransaction) {
        try {
          console.log('🔄 Auto-consume: waiting for swap output note to propagate (15s)...');
          await new Promise(resolve => setTimeout(resolve, 15000));

          console.log('🔄 Auto-consume: syncing wallet state...');
          await client.syncState();

          const accountIdObj = AccountId.fromHex(accountId);
          const consumableNotes = await client.getConsumableNotes(accountIdObj);

          if (consumableNotes.length > 0) {
            console.log(`🔄 Auto-consume: found ${consumableNotes.length} consumable note(s)`);
            let autoConsumed = 0;

            for (const consumable of consumableNotes) {
              try {
                const noteRecord = consumable.inputNoteRecord();

                if (noteRecord.isConsumed() || noteRecord.isProcessing()) {
                  continue;
                }

                const consumability = consumable.noteConsumability();
                const canConsume = consumability.some((entry: any) => {
                  const entryAccountId = typeof entry.accountId === 'function'
                    ? entry.accountId()
                    : entry.accountId;
                  return entryAccountId?.toString() === accountId;
                });

                if (!canConsume) continue;

                let note;
                if (typeof noteRecord.toNote === 'function') {
                  note = noteRecord.toNote();
                } else if (typeof noteRecord.toInputNote === 'function') {
                  const inputNote = noteRecord.toInputNote();
                  if (inputNote && typeof inputNote.note === 'function') {
                    note = inputNote.note();
                  } else if (inputNote && inputNote.note) {
                    note = inputNote.note;
                  }
                }

                if (!note) continue;

                const consumeTxBuilder = new TransactionRequestBuilder();
                const noteAndArgs = new NoteAndArgs(note, null);
                const transactionRequest = consumeTxBuilder
                  .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
                  .build();

                const noteIdStr = noteRecord.id().toString();
                const customTxPayload = new CustomTransaction(
                  accountId,
                  accountId,
                  transactionRequest,
                  [noteIdStr],
                  undefined
                );

                const consumeTxId = await requestTransaction({
                  type: TransactionType.Custom,
                  payload: customTxPayload,
                });

                if (consumeTxId) {
                  autoConsumed++;
                  console.log(`✅ Auto-consumed note ${noteIdStr.substring(0, 16)}...`);
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
              } catch (noteErr: any) {
                console.warn('⚠️ Auto-consume note failed:', noteErr.message);
              }
            }

            if (autoConsumed > 0) {
              console.log(`✅ Auto-consumed ${autoConsumed} note(s) - tokens received!`);
              await client.syncState();
            }
          } else {
            console.log('ℹ️ Auto-consume: no consumable notes found yet');
          }
        } catch (autoErr: any) {
          console.warn('⚠️ Auto-consume failed (use manual Consume Notes button):', autoErr.message);
        }
      }

      setIsLoading(false);

    } catch (err: any) {
      console.error('❌ P2ID swap error:', err);
      setError(err?.message || 'Failed to execute P2ID swap');
      setIsLoading(false);
    }
  }, [client, accountId, requestTransaction]);

  // Helper: auto-consume all consumable notes for the user's account
  const autoConsumeNotes = useCallback(async (): Promise<number> => {
    if (!client || !accountId || !requestTransaction) return 0;

    await client.syncState();
    const accountIdObj = AccountId.fromHex(accountId);
    const consumableNotes = await client.getConsumableNotes(accountIdObj);

    if (consumableNotes.length === 0) return 0;

    console.log(`🔄 Auto-consume: found ${consumableNotes.length} consumable note(s)`);
    let autoConsumed = 0;

    for (const consumable of consumableNotes) {
      try {
        const noteRecord = consumable.inputNoteRecord();
        if (noteRecord.isConsumed() || noteRecord.isProcessing()) continue;

        const consumability = consumable.noteConsumability();
        const canConsume = consumability.some((entry: any) => {
          const entryAccountId = typeof entry.accountId === 'function'
            ? entry.accountId() : entry.accountId;
          return entryAccountId?.toString() === accountId;
        });
        if (!canConsume) continue;

        let note;
        if (typeof noteRecord.toNote === 'function') {
          note = noteRecord.toNote();
        } else if (typeof noteRecord.toInputNote === 'function') {
          const inputNote = noteRecord.toInputNote();
          if (inputNote && typeof inputNote.note === 'function') note = inputNote.note();
          else if (inputNote && inputNote.note) note = inputNote.note;
        }
        if (!note) continue;

        const consumeTxBuilder = new TransactionRequestBuilder();
        const noteAndArgs = new NoteAndArgs(note, null);
        const transactionRequest = consumeTxBuilder
          .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
          .build();

        const noteIdStr = noteRecord.id().toString();
        const customTxPayload = new CustomTransaction(
          accountId, accountId, transactionRequest, [noteIdStr], undefined
        );

        const consumeTxId = await requestTransaction({
          type: TransactionType.Custom,
          payload: customTxPayload,
        });

        if (consumeTxId) {
          autoConsumed++;
          console.log(`✅ Auto-consumed note ${noteIdStr.substring(0, 16)}...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (noteErr: any) {
        console.warn('⚠️ Auto-consume note failed:', noteErr.message);
      }
    }

    if (autoConsumed > 0) await client.syncState();
    return autoConsumed;
  }, [client, accountId, requestTransaction]);

  // Multi-hop swap: execute sequential hops (e.g., MILO -> MUSDC -> MELO)
  const multiHopSwap = useCallback(async ({
    amount,
    minFinalAmountOut,
    intermediateAmount,
    sellToken,
    buyToken,
    intermediateToken,
    pool1Hex,
    pool2Hex,
    isPrivate,
  }: {
    amount: bigint;
    minFinalAmountOut: bigint;
    intermediateAmount: bigint;
    sellToken: { faucetId: AccountId | string; decimals: number };
    buyToken: { faucetId: AccountId | string; decimals: number };
    intermediateToken: { faucetId: AccountId | string; decimals: number };
    pool1Hex: string;
    pool2Hex: string;
    isPrivate?: boolean;
  }) => {
    if (!accountId || !client || !requestTransaction) {
      setError('Missing required parameters for multi-hop swap');
      return;
    }

    setError('');
    setIsLoading(true);
    setTxId(undefined);
    setNoteId(undefined);

    try {
      const userAccountId = AccountId.fromHex(accountId);
      const faucetIdToAccountId = (faucetId: AccountId | string): AccountId => {
        if (typeof faucetId === 'string') return AccountId.fromHex(faucetId);
        return faucetId;
      };

      clearOldSwapInfo();

      // ========== HOP 1: sellToken -> intermediateToken ==========
      console.log('🔀 Multi-hop: Starting Hop 1...');

      // Minimum intermediate output (apply half of total slippage)
      const minIntermediateOut = intermediateAmount * BigInt(99) / BigInt(100);

      const hop1Result = await createP2IDSwapTransaction({
        amount,
        poolAccountIdHex: pool1Hex,
        buyToken: {
          faucetId: faucetIdToAccountId(intermediateToken.faucetId),
          decimals: intermediateToken.decimals,
        },
        sellToken: {
          faucetId: faucetIdToAccountId(sellToken.faucetId),
          decimals: sellToken.decimals,
        },
        minAmountOut: minIntermediateOut,
        userAccountId,
        client,
        noteType: isPrivate ? NoteType.Private : NoteType.Public,
      });

      storeSwapInfo(hop1Result.swapInfo);

      // Submit hop 1
      const hop1TxId = await requestTransaction({
        type: TransactionType.Custom,
        payload: hop1Result.tx,
      });
      console.log('✅ Hop 1 TX submitted:', String(hop1TxId));

      // Track hop 1 with daemon
      try {
        await fetch(`${SWAP_DAEMON_URL}/track_note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note_id: hop1Result.noteId,
            note_type: 'P2ID_SWAP',
            pool_account_id: pool1Hex,
            swap_info: hop1Result.swapInfo,
          })
        });
      } catch (e) {
        console.warn('⚠️ Failed to track hop 1:', e);
      }

      // Wait for daemon auto-poll to process hop 1
      console.log('⏳ Hop 1: Waiting for daemon processing (25s)...');
      await new Promise(resolve => setTimeout(resolve, 25000));

      // Auto-consume intermediate token
      console.log('🔄 Hop 1: Consuming intermediate tokens (15s wait)...');
      await new Promise(resolve => setTimeout(resolve, 15000));
      const consumed1 = await autoConsumeNotes();
      console.log(`✅ Hop 1 complete: consumed ${consumed1} note(s)`);

      // ========== HOP 2: intermediateToken -> buyToken ==========
      console.log('🔀 Multi-hop: Starting Hop 2...');

      // Get ACTUAL intermediate token balance after hop 1 consume
      // (daemon may apply different fee than frontend estimate)
      let hop2Amount = intermediateAmount;
      try {
        await client.syncState();
        const userAccId = AccountId.fromHex(accountId);
        const accountData = await client.getAccount(userAccId);
        if (accountData) {
          const intermediateFaucetHex = typeof intermediateToken.faucetId === 'string'
            ? intermediateToken.faucetId.toLowerCase()
            : intermediateToken.faucetId.toString().toLowerCase();
          const vault = accountData.vault();
          const fungibleAssets = vault.fungibleAssets();
          for (const asset of fungibleAssets) {
            const faucetIdObj = asset.faucetId();
            const faucetHex = faucetIdObj.toString().toLowerCase();
            if (faucetHex.includes(intermediateFaucetHex.replace('0x', ''))) {
              const actualBalance = BigInt(asset.amount());
              if (actualBalance > BigInt(0)) {
                console.log(`💰 Actual intermediate balance: ${actualBalance} (estimated: ${intermediateAmount})`);
                // Use actual balance (but cap at estimate + 10% to avoid using pre-existing tokens)
                const maxAmount = intermediateAmount * BigInt(110) / BigInt(100);
                hop2Amount = actualBalance > maxAmount ? maxAmount : actualBalance;
              }
              try { faucetIdObj.free?.(); } catch {}
              break;
            }
            try { faucetIdObj.free?.(); } catch {}
          }
          try { vault.free?.(); } catch {}
          try { (accountData as any).free?.(); } catch {}
        }
      } catch (balanceErr) {
        console.warn('⚠️ Could not read actual balance, using estimate:', balanceErr);
      }
      console.log(`📊 Hop 2 input amount: ${hop2Amount}`);

      const hop2Result = await createP2IDSwapTransaction({
        amount: hop2Amount,
        poolAccountIdHex: pool2Hex,
        buyToken: {
          faucetId: faucetIdToAccountId(buyToken.faucetId),
          decimals: buyToken.decimals,
        },
        sellToken: {
          faucetId: faucetIdToAccountId(intermediateToken.faucetId),
          decimals: intermediateToken.decimals,
        },
        minAmountOut: minFinalAmountOut,
        userAccountId,
        client,
        noteType: isPrivate ? NoteType.Private : NoteType.Public,
      });

      storeSwapInfo(hop2Result.swapInfo);

      // Submit hop 2
      const hop2TxId = await requestTransaction({
        type: TransactionType.Custom,
        payload: hop2Result.tx,
      });
      console.log('✅ Hop 2 TX submitted:', String(hop2TxId));

      // Track hop 2 with daemon
      try {
        await fetch(`${SWAP_DAEMON_URL}/track_note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note_id: hop2Result.noteId,
            note_type: 'P2ID_SWAP',
            pool_account_id: pool2Hex,
            swap_info: hop2Result.swapInfo,
          })
        });
      } catch (e) {
        console.warn('⚠️ Failed to track hop 2:', e);
      }

      // Wait for daemon auto-poll to process hop 2
      console.log('⏳ Hop 2: Waiting for daemon processing (25s)...');
      await new Promise(resolve => setTimeout(resolve, 25000));

      // Auto-consume final token
      console.log('🔄 Hop 2: Consuming final tokens (15s wait)...');
      await new Promise(resolve => setTimeout(resolve, 15000));
      const consumed2 = await autoConsumeNotes();
      console.log(`✅ Hop 2 complete: consumed ${consumed2} note(s)`);

      setNoteId(hop2Result.noteId);
      setTxId(String(hop2TxId));
      setIsLoading(false);

      console.log('✅ Multi-hop swap completed!');

    } catch (err: any) {
      console.error('❌ Multi-hop swap error:', err);
      setError(err?.message || 'Failed to execute multi-hop swap');
      setIsLoading(false);
    }
  }, [client, accountId, requestTransaction, autoConsumeNotes]);

  const value = useMemo(
    () => ({
      swap,
      multiHopSwap,
      isLoading,
      error,
      txId,
      noteId,
    }),
    [swap, multiHopSwap, isLoading, error, txId, noteId],
  );

  return value;
};
