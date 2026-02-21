import { useState, useCallback, useEffect, useMemo } from 'react';
import { useWallet } from '@miden-sdk/miden-wallet-adapter';
import { useLiquidity } from '../hooks/useLiquidity';
import { usePoolStats } from '../hooks/usePoolStats';
import { getTokenBySymbol, getTokenMetadata } from '../tokenRegistry';
import { AccountId } from '@miden-sdk/miden-sdk';
import { getPoolAccountIdHex, getDefaultPoolAccountIdHex } from '../config/poolConfig';
import { toast } from 'react-toastify';
import { LIQUIDITY_DAEMON_URL } from '../config/api';

interface PoolsProps {
  client: any;
  accountId: string | null;
  poolReserves: Record<string, { reserveA: bigint; reserveB: bigint }>;
  userBalances: Record<string, bigint>;
}

interface PoolInfo {
  pair: string;
  tokenA: string;
  tokenB: string;
  tokenAFaucetId: string;
  tokenBFaucetId: string;
  reserveA: bigint;
  reserveB: bigint;
  totalLiquidity: bigint;
  myLiquidity: bigint;
}

const getPoolsConfig = (): PoolInfo[] => {
  const miloToken = getTokenBySymbol('MILO');
  const meloToken = getTokenBySymbol('MELO');
  const musdcToken = getTokenBySymbol('MUSDC');
  
  return [
    {
      pair: 'MILO/MUSDC',
      tokenA: 'MILO',
      tokenB: 'MUSDC',
      tokenAFaucetId: miloToken?.faucetId || '',
      tokenBFaucetId: musdcToken?.faucetId || '',
      reserveA: BigInt(0),
      reserveB: BigInt(0),
      totalLiquidity: BigInt(0),
      myLiquidity: BigInt(0),
    },
    {
      pair: 'MELO/MUSDC',
      tokenA: 'MELO',
      tokenB: 'MUSDC',
      tokenAFaucetId: meloToken?.faucetId || '',
      tokenBFaucetId: musdcToken?.faucetId || '',
      reserveA: BigInt(0),
      reserveB: BigInt(0),
      totalLiquidity: BigInt(0),
      myLiquidity: BigInt(0),
    },
  ];
};

// @ts-ignore - unused function kept for potential future use
const formatAmount = (amount: string, decimals: number | null) => {
  if (decimals == null || !amount) {
    return amount || '0';
  }
  // Remove any negative sign and ensure positive number
  const raw = amount.replace(/^-/, '');
  if (!raw || raw === '0') return '0';
  
  // Pad with zeros if needed
  const padded = raw.padStart(decimals + 1, '0');
  if (padded.length <= decimals) {
    return '0';
  }
  
  const integer = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
};

// Helper function to get balance from account for a specific faucet ID
// Returns balance for the exact faucet ID provided (no summing across IDs)
const getBalance = async (
  client: any,
  accountId: string | null,
  faucetId: string,
): Promise<bigint> => {
  if (!client || !accountId || !faucetId) return BigInt(0);
  try {
    await client.syncState();
    const account = await client.getAccount(AccountId.fromHex(accountId));
    if (!account) return BigInt(0);
    
    const vault = account.vault();
    const faucetIdObj = AccountId.fromHex(faucetId);
    
    // Try getBalance first
    let balance = vault.getBalance(faucetIdObj) || BigInt(0);
    
    // If balance is 0, check fungibleAssets (for legacy IDs)
    if (balance === BigInt(0)) {
      const fungibleAssets = vault.fungibleAssets();
      for (const asset of fungibleAssets) {
        const assetFaucetIdHex = asset.faucetId().toString().toLowerCase();
        if (assetFaucetIdHex === faucetId.toLowerCase()) {
          balance = BigInt(asset.amount());
          break;
        }
      }
    }
    
    return balance;
  } catch (error) {
    console.error('Error getting balance:', error);
    return BigInt(0);
  }
};

// Format bigint with decimals
const formatBalance = (balance: bigint, decimals: number): string => {
  if (balance === BigInt(0)) return '0';
  const divisor = BigInt(10 ** decimals);
  const whole = balance / divisor;
  const fraction = balance % divisor;
  if (fraction === BigInt(0)) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  if (!fractionStr) return whole.toString();
  return `${whole}.${fractionStr}`;
};

export default function Pools({ client, accountId, poolReserves, userBalances }: PoolsProps) {
  const { connected } = useWallet();
  const initialPools = getPoolsConfig();
  const [pools, setPools] = useState<PoolInfo[]>(initialPools);
  const [selectedPool, setSelectedPool] = useState<PoolInfo | null>(initialPools[0] || null);
  
  // Get pool account ID hex for selected pool (or default to MILOA/MUSDT)
  const poolAccountIdHex = useMemo(() => {
    if (selectedPool) {
      return getPoolAccountIdHex(selectedPool.tokenA, selectedPool.tokenB);
    }
    return getDefaultPoolAccountIdHex(); // Default
  }, [selectedPool]);
  
  // Convert to AccountId when needed for SDK calls
  const poolAccountIdHexObj = useMemo(() => {
    return AccountId.fromHex(poolAccountIdHex);
  }, [poolAccountIdHex]);

  const { addLiquidity, consumeDepositNotes, isLoading, error, txId, noteId } = useLiquidity({
    client,
    accountId,
    poolAccountId: poolAccountIdHex,
  });


  const { poolAPYs, getAPYForPool, formatAPY, formatVolume } = usePoolStats();

  const [amountA, setAmountA] = useState<string>('');
  const [amountB, setAmountB] = useState<string>('');
  const [slippage, setSlippage] = useState<number>(0.5);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  const [userDeposits, setUserDeposits] = useState<Record<string, { total_deposited: number; deposit_count: number }>>({});
  const [autoCalculateB, setAutoCalculateB] = useState<boolean>(true); // Toggle for auto-calculating amountB

  // Fetch user deposits from daemon
  useEffect(() => {
    if (!accountId || !connected) {
      setUserDeposits({});
      return;
    }

    const fetchUserDeposits = async () => {
      try {
        const response = await fetch(`${LIQUIDITY_DAEMON_URL}/user_deposits?user_id=${accountId}`);
        if (response.ok) {
          const data = await response.json();
          const deposits: Record<string, { total_deposited: number; deposit_count: number }> = {};
          for (const dep of data.deposits || []) {
            deposits[dep.pool_account_id] = {
              total_deposited: dep.total_deposited,
              deposit_count: dep.deposit_count,
            };
          }
          setUserDeposits(deposits);
        }
      } catch {
        // Daemon may not be running, silently ignore
      }
    };

    fetchUserDeposits();
    const interval = setInterval(fetchUserDeposits, 15000);
    return () => clearInterval(interval);
  }, [accountId, connected]);
  
  // Use userBalances from props
  useEffect(() => {
    setBalances(userBalances);
  }, [userBalances]);

  // Use poolReserves from props
  useEffect(() => {
    const poolsConfig = getPoolsConfig();
    const updatedPools: PoolInfo[] = poolsConfig.map(pool => {
      const reserves = poolReserves[pool.pair];
      if (reserves) {
        return {
          ...pool,
          reserveA: reserves.reserveA,
          reserveB: reserves.reserveB,
          totalLiquidity: reserves.reserveA + reserves.reserveB,
        };
      }
      return pool;
    });
    
    setPools(updatedPools);
    
    // Update selectedPool if it exists, but only update reserves, don't replace the whole object
    // This prevents infinite loops while keeping the selected pool in sync
    if (selectedPool) {
      const updatedSelected = updatedPools.find(p => p.pair === selectedPool.pair);
      if (updatedSelected && (
        updatedSelected.reserveA !== selectedPool.reserveA ||
        updatedSelected.reserveB !== selectedPool.reserveB ||
        updatedSelected.totalLiquidity !== selectedPool.totalLiquidity
      )) {
        setSelectedPool(updatedSelected);
      }
    } else if (updatedPools.length > 0) {
      // Set first pool as selected if none selected
      setSelectedPool(updatedPools[0]);
    }
  }, [poolReserves]); // Removed selectedPool from dependencies to prevent infinite loop
  
  // Helper function to calculate token price in USD (1 MIDEN = 1 USD)
  const calculateTokenPriceUSD = useCallback((pool: PoolInfo): number => {
    if (pool.tokenB === 'MIDEN' && pool.reserveA > BigInt(0) && pool.reserveB > BigInt(0)) {
      const tokenA = getTokenMetadata(pool.tokenAFaucetId);
      const tokenB = getTokenMetadata(pool.tokenBFaucetId);
      if (!tokenA || !tokenB) return 0;
      
      // Convert reserves to human-readable amounts
      const reserveA = Number(pool.reserveA) / (10 ** (tokenA.decimals ?? 0));
      const reserveB = Number(pool.reserveB) / (10 ** (tokenB.decimals ?? 0));
      
      // Price = (MIDEN reserve / Token reserve) * 1 USD
      // Since 1 MIDEN = 1 USD, token price = reserveB / reserveA
      return reserveB / reserveA;
    }
    return 0;
  }, []);

  // Helper function to calculate amountB from amountA (only used when autoCalculateB is true)
  const calculateAmountB = useCallback((amountAValue: string) => {
    if (!selectedPool || !amountAValue) return '';
    
    const tokenA = getTokenMetadata(selectedPool.tokenAFaucetId);
    const tokenB = getTokenMetadata(selectedPool.tokenBFaucetId);
    if (!tokenA || !tokenB) return '';
    
    try {
      const amountABigInt = BigInt(
        Math.floor(parseFloat(amountAValue) * 10 ** (tokenA.decimals ?? 0)),
      );
      
      // Calculate based on pool ratio (if reserves exist)
      let amountBBigInt: bigint;
      if (selectedPool.reserveA > BigInt(0) && selectedPool.reserveB > BigInt(0)) {
        // Use pool ratio: maintain the same price ratio
        // amountB = amountA * (reserveB / reserveA)
        amountBBigInt = (amountABigInt * selectedPool.reserveB) / selectedPool.reserveA;
      } else {
        // First deposit: Calculate based on 1 MIDEN = 1 USD pricing
        // If tokenA is MILOA/MILOB, we need to determine its USD value
        // For now, use 1:1 ratio adjusted for decimals (will be improved with oracle)
        const decimalsDiff = (tokenA.decimals ?? 0) - (tokenB.decimals ?? 0);
        if (decimalsDiff > 0) {
          amountBBigInt = amountABigInt / BigInt(10 ** decimalsDiff);
        } else if (decimalsDiff < 0) {
          amountBBigInt = amountABigInt * BigInt(10 ** Math.abs(decimalsDiff));
        } else {
          amountBBigInt = amountABigInt;
        }
      }
      
      const tokenBDecimals = tokenB.decimals ?? 0;
      return formatBalance(amountBBigInt, tokenBDecimals);
    } catch (error) {
      console.error('Error calculating amountB:', error);
      return '';
    }
  }, [selectedPool]);
  
  // Helper function to calculate amountA from amountB (only used when autoCalculateA is true)
  const calculateAmountA = useCallback((amountBValue: string) => {
    if (!selectedPool || !amountBValue) return '';
    
    const tokenA = getTokenMetadata(selectedPool.tokenAFaucetId);
    const tokenB = getTokenMetadata(selectedPool.tokenBFaucetId);
    if (!tokenA || !tokenB) return '';
    
    try {
      const amountBBigInt = BigInt(
        Math.floor(parseFloat(amountBValue) * 10 ** (tokenB.decimals ?? 0)),
      );
      
      // Calculate based on pool ratio (if reserves exist)
      let amountABigInt: bigint;
      if (selectedPool.reserveA > BigInt(0) && selectedPool.reserveB > BigInt(0)) {
        // Use pool ratio: maintain the same price ratio
        // amountA = amountB * (reserveA / reserveB)
        amountABigInt = (amountBBigInt * selectedPool.reserveA) / selectedPool.reserveB;
      } else {
        // First deposit: Calculate based on 1 MIDEN = 1 USD pricing
        const decimalsDiff = (tokenA.decimals ?? 0) - (tokenB.decimals ?? 0);
        if (decimalsDiff > 0) {
          amountABigInt = amountBBigInt * BigInt(10 ** decimalsDiff);
        } else if (decimalsDiff < 0) {
          amountABigInt = amountBBigInt / BigInt(10 ** Math.abs(decimalsDiff));
        } else {
          amountABigInt = amountBBigInt;
        }
      }
      
      const tokenADecimals = tokenA.decimals ?? 0;
      return formatBalance(amountABigInt, tokenADecimals);
    } catch (error) {
      console.error('Error calculating amountA:', error);
      return '';
    }
  }, [selectedPool]);
  
  // Reset amounts when pool changes
  useEffect(() => {
    setAmountA('');
    setAmountB('');
    setAutoCalculateB(true);
  }, [selectedPool]);

  const handleAddLiquidity = useCallback(
    async (_pool: PoolInfo) => {
      if (!amountA || !amountB || !selectedPool) {
        toast.error('Please enter amounts for both tokens');
        return;
      }

      const tokenAMeta = getTokenMetadata(selectedPool.tokenAFaucetId);
      const tokenBMeta = getTokenMetadata(selectedPool.tokenBFaucetId);
      if (!tokenAMeta || !tokenBMeta) {
        toast.error('Token metadata not found');
        return;
      }

      const decimalsA = tokenAMeta.decimals ?? 0;
      const decimalsB = tokenBMeta.decimals ?? 0;
      const amountABigInt = BigInt(Math.floor(parseFloat(amountA) * 10 ** decimalsA));
      const amountBBigInt = BigInt(Math.floor(parseFloat(amountB) * 10 ** decimalsB));

      // Check balances for both tokens
      let tokenAFaucetId = selectedPool.tokenAFaucetId;
      let tokenBFaucetId = selectedPool.tokenBFaucetId;
      if (selectedPool.tokenA === 'MIDEN') tokenAFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
      if (selectedPool.tokenB === 'MIDEN') tokenBFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';

      const balanceA = await getBalance(client, accountId, tokenAFaucetId);
      const balanceB = await getBalance(client, accountId, tokenBFaucetId);

      if (amountABigInt > balanceA) {
        toast.error(`Insufficient ${selectedPool.tokenA} balance. You have ${formatBalance(balanceA, decimalsA)}`);
        return;
      }
      if (amountBBigInt > balanceB) {
        toast.error(`Insufficient ${selectedPool.tokenB} balance. You have ${formatBalance(balanceB, decimalsB)}`);
        return;
      }
      if (amountABigInt <= BigInt(0) || amountBBigInt <= BigInt(0)) {
        toast.error('Both amounts must be greater than 0');
        return;
      }

      try {
        // Step 1: Deposit tokenA
        toast.info(`🔄 Step 1/2: Depositing ${selectedPool.tokenA}...`);
        const minLpAmountOutA = (amountABigInt * BigInt(10000 - slippage * 100)) / BigInt(10000);
        await addLiquidity({
          token: selectedPool.tokenA,
          amount: amountABigInt,
          minLpAmountOut: minLpAmountOutA,
        });
        toast.success(`✅ ${selectedPool.tokenA} deposited!`);

        // Wait before second deposit
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Step 2: Deposit tokenB
        toast.info(`🔄 Step 2/2: Depositing ${selectedPool.tokenB}...`);
        const minLpAmountOutB = (amountBBigInt * BigInt(10000 - slippage * 100)) / BigInt(10000);
        await addLiquidity({
          token: selectedPool.tokenB,
          amount: amountBBigInt,
          minLpAmountOut: minLpAmountOutB,
        });
        toast.success('✅ Both tokens deposited! Liquidity added successfully.');

        setAmountA('');
        setAmountB('');

        // Auto-consume DEPOSIT notes
        if (poolAccountIdHex && consumeDepositNotes) {
          setTimeout(async () => {
            try {
              toast.info('🔄 Auto-consuming DEPOSIT notes...');
              await consumeDepositNotes(poolAccountIdHex);
              toast.success('✅ DEPOSIT notes consumed!');
            } catch (err: any) {
              console.error('❌ Auto-consume failed:', err);
              toast.warning('⚠️ Auto-consume failed. Use manual consume button.');
            }
          }, 8000);
        }
      } catch (err) {
        console.error('Failed to add liquidity:', err);
        const errorMessage = err instanceof Error ? err.message : String(err);
        toast.error(`❌ Failed to add liquidity: ${errorMessage}`);
      }
    },
    [amountA, amountB, selectedPool, slippage, addLiquidity, client, accountId, poolAccountIdHex, consumeDepositNotes],
  );
  
  // Get balance for a token (check both primary and legacy IDs)
  const getTokenBalance = (symbol: string, faucetId: string): bigint => {
    const token = getTokenBySymbol(symbol);
    if (!token) return BigInt(0);
    
    let totalBalance = BigInt(0);
    
    // Check primary ID
    const primaryBalance = userBalances[faucetId.toLowerCase()] || BigInt(0);
    totalBalance += primaryBalance;
    
    // Check legacy IDs
    if (token.legacyFaucetIds) {
      for (const legacyId of token.legacyFaucetIds) {
        const legacyBalance = userBalances[legacyId.toLowerCase()] || BigInt(0);
        totalBalance += legacyBalance;
      }
    }
    
    return totalBalance;
  };
  
  // Get formatted balance for display
  const getFormattedBalance = (symbol: string, faucetId: string, decimals: number): string => {
    const balance = getTokenBalance(symbol, faucetId);
    return formatBalance(balance, decimals);
  };
  
  // Get user deposit for a pool from daemon
  const getUserDeposit = (pool: PoolInfo): number => {
    const poolHex = getPoolAccountIdHex(pool.tokenA, pool.tokenB);
    return userDeposits[poolHex]?.total_deposited || 0;
  };
  

  return (
    <div className="pools-page">
      <div className="pools-container">
        <h2>Liquidity Pools</h2>
        <p className="pools-description">
          Add liquidity to pools and earn fees. Select a pool to add liquidity.
        </p>

        <div className="pools-list">
          {pools.length === 0 && (
            <div className="no-pools">No pools available. Loading...</div>
          )}
          {pools.map((pool) => {
            const tokenA = getTokenMetadata(pool.tokenAFaucetId);
            const tokenB = getTokenMetadata(pool.tokenBFaucetId);
            const poolAPY = getAPYForPool(pool.pair);
            return (
              <div
                key={pool.pair}
                className={`pool-card ${selectedPool?.pair === pool.pair ? 'selected' : ''}`}
                onClick={() => {
                  setSelectedPool(pool);
                  setAmountA('');
                  setAmountB('');
                }}
              >
                <div className="pool-header">
                  <h3>{pool.pair}</h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {poolAPY && (
                      <span style={{
                        background: 'linear-gradient(135deg, #4ade80, #22c55e)',
                        color: '#000',
                        padding: '4px 10px',
                        borderRadius: '12px',
                        fontSize: '0.85rem',
                        fontWeight: 'bold'
                      }}>
                        APY: {formatAPY(poolAPY.apy)}
                      </span>
                    )}
                    <span className="pool-status">Active</span>
                  </div>
                </div>
                <div className="pool-stats">
                  {/* APY and Volume Stats */}
                  {poolAPY && (
                    <>
                      <div className="stat">
                        <span className="stat-label">24h Volume</span>
                        <span className="stat-value" style={{ color: '#60a5fa' }}>
                          {formatVolume(poolAPY.volume_24h)}
                        </span>
                      </div>
                      <div className="stat">
                        <span className="stat-label">24h Fees</span>
                        <span className="stat-value" style={{ color: '#4ade80' }}>
                          {formatVolume(poolAPY.fees_24h)}
                        </span>
                      </div>
                      <div className="stat">
                        <span className="stat-label">24h Trades</span>
                        <span className="stat-value">
                          {poolAPY.trades_24h}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="stat">
                    <span className="stat-label">Total Liquidity</span>
                    <span className="stat-value">
                      {formatBalance(pool.totalLiquidity, tokenA?.decimals ?? 0)}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Reserve {pool.tokenA}</span>
                    <span className="stat-value">
                      {formatBalance(pool.reserveA, tokenA?.decimals ?? 0)}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Reserve {pool.tokenB}</span>
                    <span className="stat-value">
                      {formatBalance(pool.reserveB, tokenB?.decimals ?? 0)}
                    </span>
                  </div>
                  {connected && getUserDeposit(pool) > 0 && (
                    <div className="stat">
                      <span className="stat-label">My Deposits</span>
                      <span className="stat-value" style={{ color: '#4ade80' }}>
                        {formatBalance(BigInt(getUserDeposit(pool)), tokenA?.decimals ?? 0)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {selectedPool && !connected && (
          <div className="liquidity-form" style={{ textAlign: 'center', padding: '2rem' }}>
            <h3>Add Liquidity to {selectedPool.pair}</h3>
            <p style={{ color: '#999', marginBottom: '1rem' }}>
              Connect your wallet to add or remove liquidity.
            </p>
          </div>
        )}

        {selectedPool && connected && (() => {
          const tokenA = getTokenMetadata(selectedPool.tokenAFaucetId);
          const tokenB = getTokenMetadata(selectedPool.tokenBFaucetId);
          
          // IMPORTANT: MILOA/MILOB use PRIMARY IDs, MIDEN uses LEGACY ID
          let tokenAFaucetId = selectedPool.tokenAFaucetId; // Primary for MILOA/MILOB
          let tokenBFaucetId = selectedPool.tokenBFaucetId; // Primary for MILOA/MILOB
          
          if (selectedPool.tokenA === 'MIDEN') {
            tokenAFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
          }
          
          if (selectedPool.tokenB === 'MIDEN') {
            tokenBFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
          }
          
          // Display balances using correct IDs
          const balanceA = getFormattedBalance(selectedPool.tokenA, tokenAFaucetId, tokenA?.decimals ?? 0);
          const balanceB = getFormattedBalance(selectedPool.tokenB, tokenBFaucetId, tokenB?.decimals ?? 0);
          
          return (
            <div className="liquidity-form">
              <h3>Add Liquidity to {selectedPool.pair}</h3>
              
              <div className="info-text" style={{
                marginBottom: '1rem',
                padding: '0.75rem',
                background: '#1a1a1a',
                borderRadius: '6px',
                color: '#999',
                fontSize: '0.9rem'
              }}>
                💡 <strong>Dual Token Deposit:</strong> Enter {selectedPool.tokenA} amount. {selectedPool.tokenB} will be auto-calculated based on the pool ratio.
              </div>
              
              {/* Token A Input */}
              <div className="form-group">
                <div className="form-group-header">
                  <label>Amount ({selectedPool.tokenA})</label>
                  <span className="balance-text">
                    Balance: {balanceA}
                  </span>
                </div>
                <div className="input-container">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amountA}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '' || (!isNaN(parseFloat(value)) && parseFloat(value) >= 0)) {
                        setAmountA(value);
                        // Auto-calculate amountB based on pool ratio
                        if (value && selectedPool && autoCalculateB) {
                          const calculatedB = calculateAmountB(value);
                          if (calculatedB) {
                            setAmountB(calculatedB);
                          }
                        }
                      }
                    }}
                    placeholder="0.0"
                  />
                  {(() => {
                    // IMPORTANT: MILOA/MILOB use PRIMARY IDs, MIDEN uses LEGACY ID
                    let tokenAFaucetId = selectedPool.tokenAFaucetId; // Primary for MILOA/MILOB
                    if (selectedPool.tokenA === 'MIDEN') {
                      tokenAFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
                    }
                    
                    return (
                      <div className="percentage-buttons">
                        {[25, 50, 75, 100].map((percent) => {
                          const tokenA = getTokenMetadata(selectedPool.tokenAFaucetId);
                          const balanceABigInt = getTokenBalance(selectedPool.tokenA, tokenAFaucetId);
                          const decimals = tokenA?.decimals ?? 0;
                          const percentAmount = (balanceABigInt * BigInt(percent)) / BigInt(100);
                          const percentFormatted = formatBalance(percentAmount, decimals);
                        
                        return (
                          <button
                            key={percent}
                            className="percentage-button"
                            onClick={() => {
                              setAmountA(percentFormatted);
                              setAutoCalculateB(true);
                              // Auto-calculate amountB for all pool states
                              const calculatedB = calculateAmountB(percentFormatted);
                              if (calculatedB) {
                                setAmountB(calculatedB);
                              }
                            }}
                          >
                            {percent === 100 ? 'MAX' : `${percent}%`}
                          </button>
                        );
                      })}
                      </div>
                    );
                  })()}
                </div>
              </div>
              
              {/* Plus Icon for Liquidity */}
              <div className="exchange-icon" style={{
                fontSize: '1.5rem',
                fontWeight: 'bold',
                color: '#4CAF50'
              }}>+</div>

              {/* Token B Input */}
              <div className="form-group">
                <div className="form-group-header">
                  <label>Amount ({selectedPool.tokenB})</label>
                  <span className="balance-text">
                    Balance: {balanceB}
                  </span>
                </div>
                <div className="input-container">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={amountB}
                    placeholder="0.0"
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === '' || (!isNaN(parseFloat(value)) && parseFloat(value) >= 0)) {
                        setAmountB(value);
                        setAutoCalculateB(false);
                        // Reverse-calculate amountA if pool has reserves
                        if (value && selectedPool && selectedPool.reserveA > BigInt(0) && selectedPool.reserveB > BigInt(0)) {
                          const calculatedA = calculateAmountA(value);
                          if (calculatedA) setAmountA(calculatedA);
                        }
                      }
                    }}
                  />
                </div>
              </div>

              {/* LP Tokens Calculation */}
              {amountA && parseFloat(amountA) > 0 && (() => {
                try {
                  const tokenA = getTokenMetadata(selectedPool.tokenAFaucetId);
                  if (!tokenA) return null;

                  const amountABigInt = BigInt(Math.floor(parseFloat(amountA) * 10 ** (tokenA.decimals ?? 0)));
                  let estimatedLPTokens: bigint;

                  if (selectedPool.reserveA > BigInt(0) && selectedPool.reserveB > BigInt(0)) {
                    // Existing pool: LP tokens proportional to deposit
                    // For single-sided deposit, LP = (amountA / reserveA) * totalLP
                    // Simplified: LP ≈ amountA (assuming 1:1 for estimation)
                    estimatedLPTokens = amountABigInt;
                  } else {
                    // First deposit: 1:1 ratio
                    estimatedLPTokens = amountABigInt;
                  }

                  return (
                    <div className="lp-tokens-info" style={{
                      marginTop: '1rem',
                      padding: '1rem',
                      background: '#1a4d1a',
                      borderRadius: '8px',
                      border: '1px solid #4CAF50'
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}>
                        <span style={{ color: '#4CAF50', fontWeight: '600' }}>
                          💰 You will receive LP tokens:
                        </span>
                        <span style={{
                          color: '#fff',
                          fontSize: '1.1rem',
                          fontWeight: 'bold'
                        }}>
                          ~{formatBalance(estimatedLPTokens, tokenA.decimals ?? 0)} LP
                        </span>
                      </div>
                    </div>
                  );
                } catch (error) {
                  console.error('Error calculating LP tokens:', error);
                  return null;
                }
              })()}
              
              
              <div className="form-group">
                <label>Max Slippage (%)</label>
                <input
                  type="number"
                  value={slippage}
                  onChange={(e) => setSlippage(parseFloat(e.target.value) || 0.5)}
                  min="0"
                  max="100"
                  step="0.1"
                />
              </div>
              {error && <div className="error-message">{error}</div>}
              {txId && (
                <div className="success-message">
                  ✅ Transaction submitted! Tx: {typeof txId === 'string' ? txId.slice(0, 16) : JSON.stringify(txId).slice(0, 16)}...
                </div>
              )}
              {noteId && (
                <div className="info-message">
                  📝 Note ID: {noteId.slice(0, 16)}...
                </div>
              )}
              
              {/* Consume Notes Section - Show after liquidity is added */}
              {noteId && (
                <div className="consume-notes-section" style={{ 
                  marginTop: '1.5rem', 
                  padding: '1rem', 
                  background: '#1a1a1a', 
                  borderRadius: '8px',
                  border: '1px solid #333'
                }}>
                  <h4 style={{ margin: '0 0 0.75rem 0', color: '#fff' }}>Consume DEPOSIT Notes</h4>
                  <p style={{ margin: '0 0 1rem 0', color: '#999', fontSize: '0.9rem' }}>
                    After adding liquidity, DEPOSIT notes need to be consumed by the pool account to add tokens to the pool.
                  </p>
                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <button
                      className="secondary-button"
                      onClick={async () => {
                        try {
                          // Auto consume after 5 seconds (wait for transaction to commit)
                          setTimeout(async () => {
                            if (poolAccountIdHex && consumeDepositNotes) {
                              await consumeDepositNotes(poolAccountIdHex);
                              alert('DEPOSIT notes consumed automatically!');
                            }
                          }, 5000);
                          alert('Auto-consume scheduled in 5 seconds...');
                        } catch (err: any) {
                          alert(`Failed to auto-consume: ${err?.message || 'Unknown error'}`);
                        }
                      }}
                      disabled={isLoading || !poolAccountIdHex}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        background: '#4CAF50',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: (isLoading || !poolAccountIdHex) ? 'not-allowed' : 'pointer',
                        fontWeight: '600',
                        opacity: (isLoading || !poolAccountIdHex) ? 0.6 : 1,
                      }}
                    >
                      Auto Consume (5s)
                    </button>
                    <button
                      className="secondary-button"
                      onClick={async () => {
                        try {
                          if (poolAccountIdHex && consumeDepositNotes) {
                            toast.info('🔄 Consuming DEPOSIT notes...');
                            await consumeDepositNotes(poolAccountIdHex);
                            toast.success('✅ DEPOSIT notes consumed manually!');
                          } else {
                            toast.error('❌ Pool account ID not available');
                          }
                        } catch (err: any) {
                          toast.error(`❌ Failed to consume: ${err?.message || 'Unknown error'}`);
                        }
                      }}
                      disabled={isLoading || !poolAccountIdHex}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        background: '#2196F3',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        cursor: (isLoading || !poolAccountIdHex) ? 'not-allowed' : 'pointer',
                        fontWeight: '600',
                        opacity: (isLoading || !poolAccountIdHex) ? 0.6 : 1,
                      }}
                    >
                      Manual Consume
                    </button>
                  </div>
                </div>
              )}

              <button
                className="primary-button"
                onClick={() => handleAddLiquidity(selectedPool)}
                disabled={
                  !connected ||
                  isLoading ||
                  !amountA ||
                  parseFloat(amountA) <= 0 ||
                  !amountB ||
                  parseFloat(amountB) <= 0
                }
              >
                {isLoading
                  ? 'Adding Liquidity...'
                  : !connected
                  ? 'Connect Wallet'
                  : 'Add Liquidity'}
              </button>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
