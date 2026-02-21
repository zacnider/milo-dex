import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '@miden-sdk/miden-wallet-adapter';
import { useRemoveLiquidity } from '../hooks/useRemoveLiquidity';
import { getTokenBySymbol, getTokenMetadata } from '../tokenRegistry';
import { getPoolAccountIdHex, POOLS } from '../config/poolConfig';
import { toast } from 'react-toastify';
import { LIQUIDITY_DAEMON_URL } from '../config/api';

interface PortfolioPageProps {
  client: any;
  accountId: string | null;
  account: any;
  poolReserves: Record<string, { reserveA: bigint; reserveB: bigint }>;
  userBalances: Record<string, bigint>;
}

interface LiquidityModalProps {
  pool: typeof POOLS[0];
  lpBalance: bigint;
  poolReserves: Record<string, { reserveA: bigint; reserveB: bigint }>;
  onClose: () => void;
  client: any;
  accountId: string | null;
}

function LiquidityModal({ pool, lpBalance, poolReserves, onClose, client, accountId }: LiquidityModalProps) {
  const [withdrawPercent, setWithdrawPercent] = useState<number>(100);
  const [slippage, setSlippage] = useState<number>(0.5);

  const poolAccountIdHex = getPoolAccountIdHex(pool.tokenA, pool.tokenB);

  const { removeLiquidity, isLoading: isRemoveLoading } = useRemoveLiquidity({
    client,
    accountId,
    poolAccountId: poolAccountIdHex,
  });

  const reserves = poolReserves[pool.pair];
  const totalLiquidity = reserves ? reserves.reserveA + reserves.reserveB : BigInt(0);

  // Calculate estimated output based on withdraw percentage
  const getEstimatedOutput = () => {
    if (!reserves || totalLiquidity === BigInt(0) || lpBalance <= BigInt(0)) return { tokenAOut: BigInt(0), tokenBOut: BigInt(0) };
    const lpAmount = (lpBalance * BigInt(withdrawPercent)) / BigInt(100);
    const tokenAOut = (lpAmount * reserves.reserveA) / totalLiquidity;
    const tokenBOut = (lpAmount * reserves.reserveB) / totalLiquidity;
    return { tokenAOut, tokenBOut };
  };

  const handleRemove = useCallback(async () => {
    if (!reserves || totalLiquidity === BigInt(0)) {
      toast.error('Pool has no reserves');
      return;
    }

    if (lpBalance <= BigInt(0)) {
      toast.error('You have no deposits in this pool');
      return;
    }

    const lpAmount = (lpBalance * BigInt(withdrawPercent)) / BigInt(100);

    const { tokenAOut, tokenBOut } = getEstimatedOutput();
    const minTokenAOut = (tokenAOut * BigInt(10000 - Math.floor(slippage * 100))) / BigInt(10000);
    const minTokenBOut = (tokenBOut * BigInt(10000 - Math.floor(slippage * 100))) / BigInt(10000);

    try {
      toast.info('Requesting withdrawal from pool...');
      await removeLiquidity({
        lpAmount,
        minTokenAOut,
        minTokenBOut,
        tokenA: pool.tokenA,
        tokenB: pool.tokenB,
      });
      toast.success('Withdrawal completed! Tokens will arrive shortly.');
      onClose();
    } catch (error: any) {
      toast.error(`Failed to remove liquidity: ${error?.message || 'Unknown error'}`);
    }
  }, [lpBalance, totalLiquidity, withdrawPercent, slippage, reserves, pool, removeLiquidity, onClose]);

  const { tokenAOut, tokenBOut } = getEstimatedOutput();
  const tokenAMeta = getTokenBySymbol(pool.tokenA);
  const tokenBMeta = getTokenBySymbol(pool.tokenB);
  const formatBal = (amount: bigint, decimals: number): string => {
    if (amount === BigInt(0)) return '0';
    const divisor = BigInt(10 ** decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    if (fraction === BigInt(0)) return whole.toString();
    const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fractionStr ? `${whole}.${fractionStr}` : whole.toString();
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.8)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: '#1a1a1a',
        borderRadius: '12px',
        padding: '2rem',
        maxWidth: '500px',
        width: '90%',
        border: '2px solid #ff6b35',
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0, color: '#ff6b35' }}>
            Remove Liquidity - {pool.pair}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#999',
              fontSize: '1.5rem',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>

        {/* Pool Reserves Info */}
        {reserves && (
          <div style={{ marginBottom: '1rem', padding: '1rem', background: '#2d2d2d', borderRadius: '8px' }}>
            <div style={{ color: '#999', fontSize: '0.9rem', marginBottom: '0.5rem' }}>Pool Reserves</div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#fff' }}>{pool.tokenA}: {formatBal(reserves.reserveA, tokenAMeta?.decimals ?? 0)}</span>
              <span style={{ color: '#fff' }}>{pool.tokenB}: {formatBal(reserves.reserveB, tokenBMeta?.decimals ?? 0)}</span>
            </div>
          </div>
        )}

        {/* Withdraw Percentage */}
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: '#999' }}>
            Withdraw Amount: {withdrawPercent}%
          </label>
          <input
            type="range"
            min="1"
            max="100"
            value={withdrawPercent}
            onChange={(e) => setWithdrawPercent(parseInt(e.target.value))}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => setWithdrawPercent(pct)}
                style={{
                  flex: 1,
                  padding: '0.5rem',
                  background: withdrawPercent === pct ? '#ff6b35' : '#2d2d2d',
                  color: withdrawPercent === pct ? '#000' : '#fff',
                  border: '1px solid #444',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: withdrawPercent === pct ? 'bold' : 'normal',
                }}
              >
                {pct === 100 ? 'MAX' : `${pct}%`}
              </button>
            ))}
          </div>
        </div>

        {/* Estimated Output */}
        <div style={{ marginBottom: '1rem', padding: '1rem', background: '#0d1117', borderRadius: '8px', border: '1px solid #238636' }}>
          <div style={{ color: '#4ade80', fontWeight: '600', marginBottom: '0.5rem' }}>
            Estimated Output:
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9aa4b2', marginBottom: '0.25rem' }}>
            <span>{pool.tokenA}:</span>
            <span style={{ color: '#fff' }}>~{formatBal(tokenAOut, tokenAMeta?.decimals ?? 0)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9aa4b2' }}>
            <span>{pool.tokenB}:</span>
            <span style={{ color: '#fff' }}>~{formatBal(tokenBOut, tokenBMeta?.decimals ?? 0)}</span>
          </div>
        </div>

        {/* Slippage */}
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: '#999', fontSize: '0.9rem' }}>
            Slippage Tolerance (%)
          </label>
          <input
            type="number"
            value={slippage}
            onChange={(e) => setSlippage(parseFloat(e.target.value) || 0.5)}
            min="0"
            max="100"
            step="0.1"
            style={{
              width: '100%',
              padding: '0.5rem',
              background: '#2d2d2d',
              border: '1px solid #444',
              borderRadius: '8px',
              color: '#fff',
            }}
          />
        </div>

        <button
          onClick={handleRemove}
          disabled={isRemoveLoading || totalLiquidity === BigInt(0)}
          style={{
            width: '100%',
            padding: '1rem',
            background: isRemoveLoading || totalLiquidity === BigInt(0)
              ? '#444'
              : 'linear-gradient(135deg, #dc3545, #c82333)',
            color: isRemoveLoading || totalLiquidity === BigInt(0) ? '#999' : '#fff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '1rem',
            fontWeight: 'bold',
            cursor: isRemoveLoading || totalLiquidity === BigInt(0) ? 'not-allowed' : 'pointer',
          }}
        >
          {isRemoveLoading ? 'Removing Liquidity...' : `Remove ${withdrawPercent}% Liquidity`}
        </button>
      </div>
    </div>
  );
}

export default function Portfolio({ client, accountId, account, poolReserves, userBalances }: PortfolioPageProps) {
  const { connected } = useWallet();
  const [selectedPool, setSelectedPool] = useState<typeof POOLS[0] | null>(null);
  const [lpBalances, setLpBalances] = useState<Record<string, bigint>>({});
  const [tokenNotes, setTokenNotes] = useState<Record<string, {
    balance: bigint;
    pending: number;
    consumable: number;
    consumed: number;
  }>>({});

  // Helper function to resolve token metadata from faucet ID
  const resolveTokenMeta = (faucetIdObj: any, amountStr?: string) => {
    let faucetId = faucetIdObj.toString();
    if (!faucetId.startsWith('0x') && faucetId.length > 0) {
      faucetId = `0x${faucetId}`;
    }
    let registry = getTokenMetadata(faucetId);
    if (!registry && faucetId.startsWith('0x')) {
      registry = getTokenMetadata(faucetId.slice(2));
    }
    if (registry) {
      return { symbol: registry.symbol, decimals: registry.decimals };
    }
    if (typeof faucetIdObj.isNetwork === 'function' && faucetIdObj.isNetwork()) {
      return { symbol: 'MIDEN', decimals: 6 };
    }
    if (amountStr) {
      try {
        const amount = BigInt(amountStr);
        if (amount % 1_000_000n === 0n && amount % 100_000_000n !== 0n) {
          return { symbol: 'MIDEN', decimals: 6 };
        }
      } catch {}
    }
    return { symbol: 'Unknown', decimals: null };
  };

  // Fetch notes for each token
  useEffect(() => {
    if (!client || !accountId || !account || !connected) {
      setTokenNotes({});
      return;
    }

    let isMounted = true;
    let intervalId: NodeJS.Timeout | null = null;

    const fetchTokenNotes = async () => {
      try {
        // Skip sync if too many notes (to avoid errors)
        try {
          await client.syncState();
        } catch (syncError: any) {
          const errorMsg = syncError?.message || String(syncError);
          if (errorMsg.includes('too many note IDs')) {
            console.warn('⚠️ Too many notes, skipping sync in fetchTokenNotes');
          }
        }
        
        const { AccountId, NoteFilter, NoteFilterTypes } = await import('@miden-sdk/miden-sdk');
        const accountIdObj = AccountId.fromHex(accountId);
        const accountObj = await client.getAccount(accountIdObj);
        if (!accountObj) {
          // Initialize with zero balances if account not found
          const notesByToken: Record<string, {
            balance: bigint;
            pending: number;
            consumable: number;
            consumed: number;
          }> = {};
          const tokens = ['MILO', 'MELO', 'MUSDC', 'MIDEN'];
          tokens.forEach(symbol => {
            const token = getTokenBySymbol(symbol);
            if (token) {
              notesByToken[symbol] = {
                balance: userBalances[token.faucetId.toLowerCase()] || BigInt(0),
                pending: 0,
                consumable: 0,
                consumed: 0,
              };
            } else if (symbol === 'MIDEN') {
              const midenToken = getTokenBySymbol('MIDEN');
              let midenBalance = BigInt(0);
              if (midenToken) {
                midenBalance = userBalances[midenToken.faucetId.toLowerCase()] || BigInt(0);
              }
              notesByToken[symbol] = {
                balance: midenBalance,
                pending: 0,
                consumable: 0,
                consumed: 0,
              };
            }
          });
          if (isMounted) {
            setTokenNotes(notesByToken);
          }
          return;
        }

        const incoming = await client.getConsumableNotes(accountObj.id());
        const pending = await client.getInputNotes(new NoteFilter(NoteFilterTypes.Processing));
        const spent = await client.getInputNotes(new NoteFilter(NoteFilterTypes.Consumed));

        const notesByToken: Record<string, {
          balance: bigint;
          pending: number;
          consumable: number;
          consumed: number;
        }> = {};

        // Initialize all tokens
        const tokens = ['MILO', 'MELO', 'MUSDC', 'MIDEN'];
        tokens.forEach(symbol => {
          const token = getTokenBySymbol(symbol);
          if (token) {
            notesByToken[symbol] = {
              balance: userBalances[token.faucetId.toLowerCase()] || BigInt(0),
              pending: 0,
              consumable: 0,
              consumed: 0,
            };
          } else if (symbol === 'MIDEN') {
            // MIDEN might not be in tokenRegistry, handle separately
            const midenToken = getTokenBySymbol('MIDEN');
            let midenBalance = BigInt(0);
            if (midenToken) {
              midenBalance = userBalances[midenToken.faucetId.toLowerCase()] || BigInt(0);
            } else {
              // Fallback: try to find any MIDEN balance in userBalances
              for (const [key, balance] of Object.entries(userBalances)) {
                const tokenMeta = getTokenMetadata(key);
                if (tokenMeta && tokenMeta.symbol === 'MIDEN') {
                  midenBalance = balance;
                  break;
                }
              }
            }
            notesByToken[symbol] = {
              balance: midenBalance,
              pending: 0,
              consumable: 0,
              consumed: 0,
            };
          }
        });

        // Count notes by token
        const countNotes = (notes: any[], type: 'consumable' | 'pending' | 'consumed') => {
          notes.forEach((rec: any) => {
            let details;
            if (type === 'consumable') {
              details = rec.inputNoteRecord().details();
            } else {
              details = rec.details();
            }
            const assets = details.assets().fungibleAssets();
            if (assets.length > 0) {
              const meta = resolveTokenMeta(assets[0].faucetId(), assets[0].amount().toString());
              if (meta.symbol && notesByToken[meta.symbol]) {
                if (type === 'consumable') {
                  notesByToken[meta.symbol].consumable++;
                } else if (type === 'pending') {
                  notesByToken[meta.symbol].pending++;
                } else {
                  notesByToken[meta.symbol].consumed++;
                }
              }
            }
          });
        };

        countNotes(incoming, 'consumable');
        countNotes(pending, 'pending');
        countNotes(spent, 'consumed');

        if (isMounted) {
          setTokenNotes(notesByToken);
        }
      } catch (error) {
        console.error('Error fetching token notes:', error);
        // Initialize with zero balances on error
        const notesByToken: Record<string, {
          balance: bigint;
          pending: number;
          consumable: number;
          consumed: number;
        }> = {};
        const tokens = ['MILO', 'MELO', 'MUSDC', 'MIDEN'];
        tokens.forEach(symbol => {
          const token = getTokenBySymbol(symbol);
          if (token) {
            notesByToken[symbol] = {
              balance: userBalances[token.faucetId.toLowerCase()] || BigInt(0),
              pending: 0,
              consumable: 0,
              consumed: 0,
            };
          } else if (symbol === 'MIDEN') {
            const midenToken = getTokenBySymbol('MIDEN');
            let midenBalance = BigInt(0);
            if (midenToken) {
              midenBalance = userBalances[midenToken.faucetId.toLowerCase()] || BigInt(0);
            }
            notesByToken[symbol] = {
              balance: midenBalance,
              pending: 0,
              consumable: 0,
              consumed: 0,
            };
          }
        });
        if (isMounted) {
          setTokenNotes(notesByToken);
        }
      }
    };

    fetchTokenNotes();
    intervalId = setInterval(fetchTokenNotes, 15000);
    
    return () => {
      isMounted = false;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [client, accountId, account, connected, userBalances]);

  // Fetch user deposits from daemon
  useEffect(() => {
    if (!accountId || !connected) {
      setLpBalances({});
      return;
    }

    const fetchUserDeposits = async () => {
      try {
        const response = await fetch(`${LIQUIDITY_DAEMON_URL}/user_deposits?user_id=${accountId}`);
        if (response.ok) {
          const data = await response.json();
          const deposits: Record<string, bigint> = {};
          for (const dep of data.deposits || []) {
            // Match pool_account_id to pool pair
            for (const pool of POOLS) {
              const poolHex = getPoolAccountIdHex(pool.tokenA, pool.tokenB);
              if (dep.pool_account_id === poolHex) {
                deposits[pool.pair] = BigInt(dep.total_deposited || 0);
              }
            }
          }
          setLpBalances(deposits);
        }
      } catch {
        // Daemon may not be running, silently ignore
      }
    };

    fetchUserDeposits();
    const interval = setInterval(fetchUserDeposits, 15000);
    return () => clearInterval(interval);
  }, [accountId, connected]);

  const formatBalance = (balance: bigint, decimals: number): string => {
    if (balance === BigInt(0)) return '0';
    const divisor = BigInt(10 ** decimals);
    const whole = balance / divisor;
    const fraction = balance % divisor;
    if (fraction === BigInt(0)) return whole.toString();
    const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fractionStr ? `${whole}.${fractionStr}` : whole.toString();
  };

  const getTokenBalance = (symbol: string): bigint => {
    const token = getTokenBySymbol(symbol);
    if (!token && symbol !== 'MIDEN') return BigInt(0);
    
    if (symbol === 'MIDEN') {
      // MIDEN is the native token, get from userBalances (already summed in App.tsx)
      const midenToken = getTokenBySymbol('MIDEN');
      if (midenToken) {
        const balance = userBalances[midenToken.faucetId.toLowerCase()] || BigInt(0);
        console.log(`🔍 MIDEN balance check: faucetId=${midenToken.faucetId.toLowerCase()}, balance=${balance.toString()}`);
        return balance;
      }
      return BigInt(0);
    }
    
    // For MILO, MELO, MUSDC: check both primary and legacy IDs and sum them
    // (App.tsx stores balances under their actual IDs, so we need to sum them here)
    if (!token) return BigInt(0);
    
    let totalBalance = BigInt(0);
    
    // Check primary ID
    const primaryBalance = userBalances[token.faucetId.toLowerCase()] || BigInt(0);
    totalBalance += primaryBalance;
    
    // Check legacy IDs
    if (token.legacyFaucetIds) {
      for (const legacyId of token.legacyFaucetIds) {
        const legacyBalance = userBalances[legacyId.toLowerCase()] || BigInt(0);
        totalBalance += legacyBalance;
        if (legacyBalance > BigInt(0)) {
          console.log(`🔍 ${symbol} legacy balance: ${legacyId.toLowerCase()}, balance=${legacyBalance.toString()}`);
        }
      }
    }
    
    console.log(`🔍 ${symbol} balance check: primary=${token.faucetId.toLowerCase()}, primaryBalance=${primaryBalance.toString()}, totalBalance=${totalBalance.toString()}, userBalances keys:`, Object.keys(userBalances));
    return totalBalance;
  };

  const tokens = ['MILO', 'MELO', 'MUSDC', 'MIDEN'];
  // Show all pools that have reserves (liquidity)
  const poolsWithLiquidity = POOLS.filter(pool => {
    const reserves = poolReserves[pool.pair];
    if (reserves && (reserves.reserveA > BigInt(0) || reserves.reserveB > BigInt(0))) {
      return true;
    }
    const lpBalance = lpBalances[pool.pair] || BigInt(0);
    return lpBalance > BigInt(0);
  });

  const handleTrade = (symbol: string) => {
    const pool = POOLS.find(p => p.tokenA === symbol || p.tokenB === symbol);
    if (pool) {
      window.location.hash = 'trade';
      setTimeout(() => {
        const event = new CustomEvent('selectMarket', { detail: pool.pair });
        window.dispatchEvent(event);
      }, 100);
    } else {
      window.location.hash = 'trade';
    }
  };

  const handleAddLiquidity = (symbol: string) => {
    const pool = POOLS.find(p => p.tokenA === symbol || p.tokenB === symbol);
    if (pool) {
      window.location.hash = 'pools';
      setTimeout(() => {
        const event = new CustomEvent('selectPool', { detail: pool.pair });
        window.dispatchEvent(event);
      }, 100);
    } else {
      window.location.hash = 'pools';
    }
  };

  return (
    <div className="portfolio-page" style={{
      padding: '2rem',
      maxWidth: '1400px',
      margin: '0 auto',
    }}>
      <h1 style={{ margin: '0 0 2rem 0', color: '#ff6b35' }}>Portfolio</h1>

      {/* Tokens Section - Wide Layout */}
      <div style={{
        background: '#1a1a1a',
        borderRadius: '12px',
        padding: '2rem',
        marginBottom: '2rem',
        border: '1px solid #333',
      }}>
        <h2 style={{ margin: '0 0 1.5rem 0', color: '#ff6b35' }}>Your Tokens</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {tokens.map((symbol) => {
            const token = getTokenBySymbol(symbol);
            if (!token && symbol !== 'MIDEN') return null;
            
            const balance = getTokenBalance(symbol);
            const decimals = token?.decimals ?? 0;
            const formatted = formatBalance(balance, decimals);
            const notes = tokenNotes[symbol] || {
              balance: BigInt(0),
              pending: 0,
              consumable: 0,
              consumed: 0,
            };
            const showButtons = symbol === 'MILO' || symbol === 'MELO';
            
            return (
              <div
                key={symbol}
                style={{
                  background: '#2d2d2d',
                  border: '1px solid #444',
                  borderRadius: '8px',
                  padding: '1.5rem',
                  display: 'grid',
                  gridTemplateColumns: showButtons ? '150px 1fr auto auto' : '150px 1fr auto',
                  gap: '2rem',
                  alignItems: 'center',
                  transition: 'all 0.3s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#ff6b35';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = '#444';
                }}
              >
                {/* Token Symbol */}
                <div>
                  <div style={{ color: '#ff6b35', fontWeight: 'bold', fontSize: '1.5rem', marginBottom: '0.25rem' }}>
                    {symbol}
                  </div>
                  <div style={{ color: '#999', fontSize: '0.85rem' }}>
                    Balance: {formatted}
                  </div>
                </div>

                {/* Note Statistics */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
                  <div>
                    <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Balance</div>
                    <div style={{ color: '#51cf66', fontSize: '1rem', fontWeight: 'bold' }}>
                      {formatted}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Pending</div>
                    <div style={{ color: '#ffd43b', fontSize: '1rem', fontWeight: 'bold' }}>
                      {notes.pending}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Consumable</div>
                    <div style={{ color: '#4dabf7', fontSize: '1rem', fontWeight: 'bold' }}>
                      {notes.consumable}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: '#999', fontSize: '0.8rem', marginBottom: '0.25rem' }}>Consumed</div>
                    <div style={{ color: '#868e96', fontSize: '1rem', fontWeight: 'bold' }}>
                      {notes.consumed}
                    </div>
                  </div>
                </div>

                {/* Action Buttons - Only for MILO and MELO */}
                {showButtons && (
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTrade(symbol);
                      }}
                      style={{
                        padding: '0.5rem 1rem',
                        background: '#ff6b35',
                        color: '#000',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '0.9rem',
                      }}
                    >
                      Trade
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddLiquidity(symbol);
                      }}
                      style={{
                        padding: '0.5rem 1rem',
                        background: '#2d2d2d',
                        color: '#ff6b35',
                        border: '1px solid #ff6b35',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        fontSize: '0.9rem',
                      }}
                    >
                      Add Liquidity
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Liquidity Pools Section */}
      {poolsWithLiquidity.length > 0 && (
        <div style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          padding: '2rem',
          border: '1px solid #333',
        }}>
          <h2 style={{ margin: '0 0 1.5rem 0', color: '#ff6b35' }}>Your Liquidity Pools</h2>
          <div style={{ display: 'grid', gap: '1rem' }}>
            {poolsWithLiquidity.map((pool) => {
              const lpBalance = lpBalances[pool.pair] || BigInt(0);
              const reserves = poolReserves[pool.pair];
              
              return (
                <div
                  key={pool.pair}
                  style={{
                    background: '#2d2d2d',
                    border: '1px solid #444',
                    borderRadius: '8px',
                    padding: '1.5rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <div style={{ color: '#ff6b35', fontWeight: 'bold', fontSize: '1.2rem', marginBottom: '0.5rem' }}>
                      {pool.pair}
                    </div>
                    <div style={{ color: '#999', fontSize: '0.9rem' }}>
                      My Deposits: {formatBalance(lpBalance, getTokenBySymbol(pool.tokenA)?.decimals ?? 0)}
                    </div>
                    {reserves && (
                      <div style={{ color: '#999', fontSize: '0.9rem', marginTop: '0.25rem' }}>
                        Reserves: {(() => {
                          const tokenA = getTokenBySymbol(pool.tokenA);
                          const tokenB = getTokenBySymbol(pool.tokenB);
                          if (!tokenA || !tokenB) return '';
                          return `${formatBalance(reserves.reserveA, tokenA.decimals ?? 0)} / ${formatBalance(reserves.reserveB, tokenB.decimals ?? 0)}`;
                        })()}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button
                      onClick={() => {
                        window.location.hash = 'pools';
                        setTimeout(() => {
                          const event = new CustomEvent('selectPool', { detail: pool.pair });
                          window.dispatchEvent(event);
                        }, 100);
                      }}
                      style={{
                        padding: '0.5rem 1rem',
                        background: '#ff6b35',
                        color: '#000',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                      }}
                    >
                      Add More
                    </button>
                    <button
                      onClick={() => setSelectedPool(pool)}
                      style={{
                        padding: '0.5rem 1rem',
                        background: '#2d2d2d',
                        color: '#dc3545',
                        border: '1px solid #dc3545',
                        borderRadius: '6px',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                      }}
                    >
                      Remove Liquidity
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {poolsWithLiquidity.length === 0 && (
        <div style={{
          background: '#1a1a1a',
          borderRadius: '12px',
          padding: '2rem',
          textAlign: 'center',
          border: '1px solid #333',
        }}>
          <p style={{ color: '#999', margin: 0 }}>You don't have any liquidity positions yet.</p>
          <button
            onClick={() => window.location.hash = 'pools'}
            style={{
              marginTop: '1rem',
              padding: '0.75rem 2rem',
              background: '#ff6b35',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            Add Liquidity
          </button>
        </div>
      )}

      {selectedPool && (
        <LiquidityModal
          pool={selectedPool}
          lpBalance={lpBalances[selectedPool.pair] || BigInt(0)}
          poolReserves={poolReserves}
          onClose={() => setSelectedPool(null)}
          client={client}
          accountId={accountId}
        />
      )}
    </div>
  );
}
