import { useState, useEffect, useCallback } from 'react';
import { TransactionType, useWallet, CustomTransaction } from '@miden-sdk/miden-wallet-adapter';
import { getTokenBySymbol, TOKEN_LIST } from '../tokenRegistry';
import { requestTokens } from '../faucetClient';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { AccountId, TransactionRequestBuilder, NoteAndArgs, NoteAndArgsArray } from '@miden-sdk/miden-sdk';

interface FaucetPageProps {
  client: any;
  accountId: string | null;
  account: any;
}

const FAUCET_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TOKENS_PER_DAY = 10; // 10 tokens per day per token type
const OWNER_WALLET = 'mtst1az0fde3kww8ujyzw62uhrycucup8zpqg';
const ADMIN_ACCOUNT_ID = '0x9e96e636738fc9104ed2b971931cc7';

interface FaucetClaim {
  token: string;
  timestamp: number;
  amount: number;
}

function getStoredClaims(): FaucetClaim[] {
  try {
    const stored = localStorage.getItem('miloFaucetClaims');
    if (!stored) return [];
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

function saveClaim(token: string, amount: number) {
  const claims = getStoredClaims();
  claims.push({
    token,
    timestamp: Date.now(),
    amount,
  });
  // Sadece son 24 saat içindeki claim'leri sakla
  const cutoff = Date.now() - FAUCET_COOLDOWN_MS;
  const filtered = claims.filter(c => c.timestamp > cutoff);
  localStorage.setItem('miloFaucetClaims', JSON.stringify(filtered));
}

function getRemainingClaims(token: string, currentAccountId?: string | null): number {
  // Admin has unlimited claims
  if (currentAccountId && currentAccountId.toLowerCase() === ADMIN_ACCOUNT_ID.toLowerCase()) {
    return 999999;
  }
  const claims = getStoredClaims();
  const cutoff = Date.now() - FAUCET_COOLDOWN_MS;
  const tokenClaims = claims
    .filter(c => c.token === token && c.timestamp > cutoff)
    .reduce((sum, c) => sum + c.amount, 0);
  return Math.max(0, MAX_TOKENS_PER_DAY - tokenClaims);
}

function getTimeUntilNextClaim(token: string): number | null {
  const claims = getStoredClaims();
  const tokenClaims = claims
    .filter(c => c.token === token)
    .sort((a, b) => b.timestamp - a.timestamp);
  
  if (tokenClaims.length === 0) return null;
  
  const lastClaim = tokenClaims[0];
  const timeSinceLastClaim = Date.now() - lastClaim.timestamp;
  
  if (timeSinceLastClaim >= FAUCET_COOLDOWN_MS) {
    return null; // Cooldown expired
  }
  
  return FAUCET_COOLDOWN_MS - timeSinceLastClaim;
}

function formatTimeRemaining(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export default function Faucet({ client, accountId, account }: FaucetPageProps) {
  const { connected, address, requestTransaction } = useWallet();
  const [claiming, setClaiming] = useState<string | null>(null);
  const [consuming, setConsuming] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<Record<string, number | null>>({
    MILO: null,
    MELO: null,
    MUSDC: null,
  });
  const [claimPending, setClaimPending] = useState<{symbol: string, timestamp: number} | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeRemaining({
        MILO: getTimeUntilNextClaim('MILO'),
        MELO: getTimeUntilNextClaim('MELO'),
        MUSDC: getTimeUntilNextClaim('MUSDC'),
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const handleConsumeNotes = useCallback(async () => {
    if (!client || !accountId || !requestTransaction) {
      toast.error('Wallet not connected or extension not available');
      return;
    }

    setConsuming(true);
    try {
      toast.info('Syncing state and fetching consumable notes...');

      await client.syncState();

      const accountIdObj = AccountId.fromHex(accountId);
      const consumableNotes = await client.getConsumableNotes(accountIdObj);

      if (consumableNotes.length === 0) {
        toast.info('No consumable notes found');
        setConsuming(false);
        return;
      }

      toast.info(`Found ${consumableNotes.length} consumable note(s). Consuming via extension wallet...`);

      // Consume notes one by one via extension wallet
      let consumedCount = 0;
      let failedCount = 0;

      for (const consumable of consumableNotes) {
        try {
          const noteRecord = consumable.inputNoteRecord();
          const noteIdStr = noteRecord.id().toString();

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

          if (!canConsume) {
            continue;
          }

          // Convert InputNoteRecord to Note
          let note;
          try {
            if (typeof noteRecord.toNote === 'function') {
              note = noteRecord.toNote();
            } else if (typeof noteRecord.toInputNote === 'function') {
              const inputNote = noteRecord.toInputNote();
              if (inputNote && typeof inputNote.note === 'function') {
                note = inputNote.note();
              } else if (inputNote && inputNote.note) {
                note = inputNote.note;
              } else {
                throw new Error('Could not extract note from InputNote');
              }
            } else {
              throw new Error('Neither toNote() nor toInputNote() methods available');
            }

            if (!note) {
              console.error(`❌ Failed to convert note ${noteIdStr} to Note instance`);
              failedCount++;
              continue;
            }
          } catch (toNoteError: any) {
            console.error(`❌ Failed to convert note ${noteIdStr}:`, toNoteError);
            failedCount++;
            continue;
          }

          // Build consume transaction
          const consumeTxBuilder = new TransactionRequestBuilder();
          const noteAndArgs = new NoteAndArgs(note, null);
          const transactionRequest = consumeTxBuilder
            .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
            .build();

          // Create CustomTransaction payload with proper format
          const customTxPayload = new CustomTransaction(
            address || accountId,
            address || accountId,
            transactionRequest,
            [noteIdStr],
            undefined
          );

          // Submit via extension wallet
          try {
            const txId = await requestTransaction({
              type: TransactionType.Custom,
              payload: customTxPayload,
            });

            const txIdStr = typeof txId === 'string'
              ? txId
              : (typeof (txId as any)?.toString === 'function' ? (txId as any).toString() : String(txId));

            if (txIdStr) {
              consumedCount++;
              console.log(`✅ Consumed note ${noteIdStr}, tx: ${txIdStr}`);

              // Small delay between consumes
              await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
              failedCount++;
              console.error(`❌ Failed to consume note ${noteIdStr}`);
            }
          } catch (txError: any) {
            console.error(`❌ Extension wallet rejected transaction for note ${noteIdStr}:`, txError);
            failedCount++;
          }
        } catch (error: any) {
          console.error(`Error consuming note:`, error);
          failedCount++;
        }
      }

      if (consumedCount > 0) {
        toast.success(`✅ Successfully consumed ${consumedCount} note(s)!`);
      }
      if (failedCount > 0) {
        toast.warning(`⚠️ Failed to consume ${failedCount} note(s)`);
      }
      if (consumedCount === 0 && failedCount === 0) {
        toast.info('No notes were consumed');
      }

      await client.syncState();
    } catch (error: any) {
      console.error('Consume notes error:', error);
      toast.error(`Failed to consume notes: ${error?.message || 'Unknown error'}`);
    } finally {
      setConsuming(false);
    }
  }, [client, accountId, requestTransaction]);

  const handleClaim = useCallback(async (tokenSymbol: string) => {
    if (!connected || !address) {
      toast.error('Please connect your wallet first');
      return;
    }

    // Admin wallet has no limits
    const isOwner = address === OWNER_WALLET || (accountId && accountId.toLowerCase() === ADMIN_ACCOUNT_ID.toLowerCase());

    // Check limits only for non-owner wallets
    if (!isOwner) {
      const remaining = getRemainingClaims(tokenSymbol, accountId);
      if (remaining <= 0) {
        const timeLeft = getTimeUntilNextClaim(tokenSymbol);
        if (timeLeft) {
          toast.error(`Daily limit reached. Try again in ${formatTimeRemaining(timeLeft)}`);
        } else {
          toast.error('Daily limit reached. Try again later.');
        }
        return;
      }
    }

    const token = getTokenBySymbol(tokenSymbol);
    if (!token || !token.faucetApiUrl) {
      toast.error(`${tokenSymbol} faucet not available`);
      return;
    }

    setClaiming(tokenSymbol);

    try {
      // Owner wallet can claim large amounts, others limited to 10 tokens
      const isOwner = address === OWNER_WALLET;

      const amount = isOwner
        ? (tokenSymbol === 'MILO' ? 100_000
           : tokenSymbol === 'MELO' ? 100_000
           : tokenSymbol === 'MUSDC' ? 180_000
           : 10)
        : 10;

      const decimals = token.decimals ?? 0;
      const amountBaseUnits = Math.round(amount * 10 ** decimals);
      console.log(`🔢 Faucet claim calculation: ${amount} tokens × 10^${decimals} = ${amountBaseUnits} base units (${isOwner ? 'Owner' : 'User'})`);

      // Faucet requires hex account ID, convert bech32 if needed
      let faucetAccountId = accountId || '';
      if (!faucetAccountId && address) {
        try {
          const { Address } = await import('@miden-sdk/miden-sdk');
          const addrObj = Address.fromBech32(address);
          faucetAccountId = addrObj.accountId().toString();
        } catch {
          faucetAccountId = address;
        }
      }

      console.log(`📞 Calling requestTokens for ${tokenSymbol}...`);
      console.log(`   API URL: ${token.faucetApiUrl}`);
      console.log(`   Account (hex): ${faucetAccountId}`);
      console.log(`   Amount: ${amountBaseUnits}`);

      const result = await requestTokens({
        apiUrl: token.faucetApiUrl,
        accountId: faucetAccountId,
        amount: amountBaseUnits.toString(),
        isPrivate: false,
        tokenSymbol: tokenSymbol,
      });

      console.log(`✅ requestTokens completed for ${tokenSymbol}:`, result);

      // Mark claim as pending for auto-sync
      setClaimPending({ symbol: tokenSymbol, timestamp: Date.now() });

      // Save claim to localStorage only for non-owner wallets
      if (!isOwner) {
        saveClaim(tokenSymbol, amount);
      }

      // Show success toast immediately
      toast.success(
        `✅ ${tokenSymbol} claimed successfully! Transaction: ${result.tx_id.slice(0, 16)}...`
      );

      // Try to sync, but don't fail if CORS/network issues occur
      try {
        // Wait 10 seconds for blockchain to process
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Try to sync state to make notes consumable
        if (client) {
          try {
            await client.syncState();
            toast.info(`🔔 Your ${tokenSymbol} tokens are now ready to consume! Refresh page if needed.`);
          } catch (syncError: any) {
            // Sync failed - user needs to refresh manually
            console.warn('⚠️ Sync failed after claim:', syncError?.message);
            toast.info(
              `🔔 ${tokenSymbol} claimed! Note created but sync failed. ` +
              `Please wait 30 seconds then REFRESH THE PAGE and click "Consume Notes".`,
              { autoClose: 10000 }
            );
          }
        }
      } catch (waitError) {
        // Continue even if wait fails
        toast.info(
          `✅ ${tokenSymbol} claimed! Please wait 30 seconds, refresh page, and consume notes.`,
          { autoClose: 10000 }
        );
      }

    } catch (error: any) {
      console.error('❌ Faucet claim error:', error);
      console.error('Error details:', {
        message: error?.message,
        stack: error?.stack,
        cause: error?.cause
      });
      toast.error(`Failed to claim ${tokenSymbol}: ${error?.message || 'Unknown error'}`);
    } finally {
      setClaiming(null);
    }
  }, [connected, address, accountId, client, account]);

  const tokens = TOKEN_LIST.map(t => ({ symbol: t.symbol, color: t.color, logo: t.logo }));

  return (
    <div className="faucet-page" style={{
      padding: '2rem',
      maxWidth: '1400px',
      margin: '0 auto',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 'calc(100vh - 4rem)',
    }}>
      <h1 style={{ margin: '0 0 2rem 0', color: '#ff6b35', textAlign: 'center' }}>Token Faucet</h1>

      {!connected && (
        <div style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          padding: '1.5rem',
          marginBottom: '2rem',
          border: '1px solid #ff6b35',
          textAlign: 'center',
        }}>
          <p style={{ margin: 0, color: '#ff6b35', fontSize: '1.1rem' }}>
            ⚠️ Please connect your wallet to claim tokens
          </p>
        </div>
      )}

      {/* Tokens Section - Centered in middle */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: '3rem',
      }}>
        <div style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          padding: '2rem',
          width: '100%',
          maxWidth: '1000px',
          border: '1px solid #333',
        }}>
          <h2 style={{ margin: '0 0 1.5rem 0', color: '#ff6b35', textAlign: 'center' }}>Claim Tokens</h2>
          <p style={{ margin: '0 0 1.5rem 0', color: '#999', fontSize: '0.9rem', textAlign: 'center' }}>
            Get free test tokens. Claim up to 10 tokens per day for each token.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {tokens.map(({ symbol, color }) => {
              const isExternal = symbol === 'MIDEN';
              if (isExternal) {
                return (
                  <div
                    key={symbol}
                    style={{
                      background: '#2d2d2d',
                      border: '1px solid #444',
                      borderRadius: '8px',
                      padding: '1.5rem',
                      display: 'grid',
                      gridTemplateColumns: '150px 1fr auto',
                      gap: '2rem',
                      alignItems: 'center',
                      transition: 'all 0.3s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = color;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = '#444';
                    }}
                  >
                    <div>
                      <div style={{ color: color, fontWeight: 'bold', fontSize: '1.5rem', marginBottom: '0.25rem' }}>
                        {symbol}
                      </div>
                      <div style={{ color: '#999', fontSize: '0.85rem' }}>
                        Official Faucet
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
                      <div>
                        <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Source</div>
                        <div style={{ color: '#fff', fontSize: '1rem', fontWeight: 'bold' }}>
                          Official Miden Testnet
                        </div>
                      </div>
                      <div>
                        <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Access</div>
                        <div style={{ color: '#51cf66', fontSize: '1rem', fontWeight: 'bold' }}>
                          External Link
                        </div>
                      </div>
                    </div>
                    <a
                      href="https://faucet.testnet.miden.io/"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: '0.5rem 1rem',
                        background: color,
                        color: '#000',
                        borderRadius: '6px',
                        textDecoration: 'none',
                        fontWeight: 'bold',
                        fontSize: '0.9rem',
                        transition: 'all 0.3s ease',
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = '#ff8c5a';
                        e.currentTarget.style.transform = 'scale(1.05)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = color;
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                    >
                      Open Faucet →
                    </a>
                  </div>
                );
              }

              const isOwner = address === OWNER_WALLET || (accountId && accountId.toLowerCase() === ADMIN_ACCOUNT_ID.toLowerCase());

              const remaining = getRemainingClaims(symbol, accountId);
              const timeLeft = timeRemaining[symbol];
              const canClaim = isOwner ? connected : (remaining > 0 && !timeLeft && connected);
              
              return (
                <div
                  key={symbol}
                  style={{
                    background: '#2d2d2d',
                    border: '1px solid #444',
                    borderRadius: '8px',
                    padding: '1.5rem',
                    display: 'grid',
                    gridTemplateColumns: '150px 1fr auto',
                    gap: '2rem',
                    alignItems: 'center',
                    transition: 'all 0.3s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = color;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = '#444';
                  }}
                >
                  {/* Token Symbol */}
                  <div>
                    <div style={{ color: color, fontWeight: 'bold', fontSize: '1.5rem', marginBottom: '0.25rem' }}>
                      {symbol}
                    </div>
                    <div style={{ color: '#999', fontSize: '0.85rem' }}>
                      {isOwner ? (
                        <span style={{ color: '#51cf66' }}>
                          Unlimited Access
                        </span>
                      ) : remaining > 0 ? (
                        <span style={{ color: '#51cf66' }}>
                          {remaining} remaining
                        </span>
                      ) : timeLeft ? (
                        <span style={{ color: '#ff6b35' }}>
                          Cooldown active
                        </span>
                      ) : (
                        <span style={{ color: '#ff6b6b' }}>Limit reached</span>
                      )}
                    </div>
                  </div>

                  {/* Status Info */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
                    <div>
                      <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Daily Limit</div>
                      <div style={{ color: '#fff', fontSize: '1rem', fontWeight: 'bold' }}>
                        {isOwner ? 'Unlimited' : `${MAX_TOKENS_PER_DAY} tokens`}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Remaining</div>
                      <div style={{ color: canClaim ? '#51cf66' : '#999', fontSize: '1rem', fontWeight: 'bold' }}>
                        {isOwner ? '∞' : remaining}
                      </div>
                    </div>
                    <div>
                      <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Status</div>
                      <div style={{ 
                        color: canClaim ? '#51cf66' : timeLeft ? '#ff6b35' : '#ff6b6b', 
                        fontSize: '1rem', 
                        fontWeight: 'bold' 
                      }}>
                        {canClaim ? 'Ready' : timeLeft ? `Wait ${formatTimeRemaining(timeLeft)}` : 'Limit Reached'}
                      </div>
                    </div>
                  </div>

                  {/* Claim Button */}
                  <button
                    onClick={() => handleClaim(symbol)}
                    disabled={!canClaim || claiming === symbol}
                    style={{
                      padding: '0.5rem 1rem',
                      background: canClaim ? color : '#444',
                      color: canClaim ? '#000' : '#999',
                      border: 'none',
                      borderRadius: '6px',
                      fontSize: '0.9rem',
                      fontWeight: 'bold',
                      cursor: canClaim ? 'pointer' : 'not-allowed',
                      transition: 'all 0.3s ease',
                      opacity: claiming === symbol ? 0.7 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {claiming === symbol ? 'Claiming...' :
                      isOwner ? (
                        symbol === 'MILO' ? `Claim 10K ${symbol}` :
                        symbol === 'MELO' ? `Claim 10K ${symbol}` :
                        symbol === 'MUSDC' ? `Claim 10K ${symbol}` :
                        `Claim 10 ${symbol}`
                      ) : `Claim 10 ${symbol}`
                    }
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Consume All Notes Button - Centered at bottom */}
      {connected && client && accountId && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          marginTop: 'auto',
          paddingTop: '2rem',
        }}>
          <button
            onClick={handleConsumeNotes}
            disabled={consuming || !requestTransaction}
            style={{
              padding: '1rem 3rem',
              background: consuming || !requestTransaction ? '#444' : '#ff6b35',
              color: consuming || !requestTransaction ? '#999' : '#000',
              border: 'none',
              borderRadius: '8px',
              fontSize: '1.1rem',
              fontWeight: 'bold',
              cursor: consuming || !requestTransaction ? 'not-allowed' : 'pointer',
              transition: 'all 0.3s ease',
              minWidth: '250px',
            }}
            onMouseEnter={(e) => {
              if (!consuming && requestTransaction) {
                e.currentTarget.style.background = '#ff8c5a';
                e.currentTarget.style.transform = 'scale(1.05)';
              }
            }}
            onMouseLeave={(e) => {
              if (!consuming && requestTransaction) {
                e.currentTarget.style.background = '#ff6b35';
                e.currentTarget.style.transform = 'scale(1)';
              }
            }}
          >
            {consuming ? 'Consuming Notes...' : !requestTransaction ? 'Extension Wallet Not Connected' : 'Consume All Notes'}
          </button>
        </div>
      )}
    </div>
  );
}
