import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { TransactionType, useWallet, CustomTransaction } from '@miden-sdk/miden-wallet-adapter';
import { useP2IDSwap as useSwap } from '../hooks/useP2IDSwap';
import { getTokenBySymbol } from '../tokenRegistry';
import { POOLS, findSwapRoute, estimateMultiHopOutput, getPoolAccountIdHex } from '../config/poolConfig';
import { SWAP_DAEMON_URL } from '../config/api';
import { AccountId, TransactionRequestBuilder, NoteAndArgs, NoteAndArgsArray } from '@miden-sdk/miden-sdk';
import { toast } from 'react-toastify';
import { createChart, ColorType, IChartApi, ISeriesApi, LineSeries, AreaSeries, Time } from 'lightweight-charts';
import { recordTrade } from '../hooks/usePoolStats';

interface TradePageProps {
  client: any;
  accountId: string | null;
  account: any;
  poolReserves: Record<string, { reserveA: bigint; reserveB: bigint }>;
  userBalances: Record<string, bigint>;
}

// Helper function to get markets from pool reserves
const getMarkets = (poolReserves: Record<string, { reserveA: bigint; reserveB: bigint }>) => {
  const markets = [];
  
  // MILO/MUSDC market
  const miloMusdcReserves = poolReserves['MILO/MUSDC'];
  if (miloMusdcReserves && miloMusdcReserves.reserveA > BigInt(0) && miloMusdcReserves.reserveB > BigInt(0)) {
    const reserveA = Number(miloMusdcReserves.reserveA);
    const reserveB = Number(miloMusdcReserves.reserveB);
    const price = reserveB / reserveA;
    const priceFormatted = price.toFixed(8);
    markets.push({
      pair: 'MILO/MUSDC',
      last: priceFormatted,
      change: '+0.0%',
      vol: '0',
    });
  } else {
    markets.push({
      pair: 'MILO/MUSDC',
      last: '0.00000000',
      change: '+0.0%',
      vol: '0',
    });
  }
  
  // MELO/MUSDC market
  const meloMusdcReserves = poolReserves['MELO/MUSDC'];
  if (meloMusdcReserves && meloMusdcReserves.reserveA > BigInt(0) && meloMusdcReserves.reserveB > BigInt(0)) {
    const reserveA = Number(meloMusdcReserves.reserveA);
    const reserveB = Number(meloMusdcReserves.reserveB);
    const price = reserveB / reserveA;
    const priceFormatted = price.toFixed(8);
    markets.push({
      pair: 'MELO/MUSDC',
      last: priceFormatted,
      change: '+0.0%',
      vol: '0',
    });
  } else {
    markets.push({
      pair: 'MELO/MUSDC',
      last: '0.00000000',
      change: '+0.0%',
      vol: '0',
    });
  }

  // MILO/MELO virtual market (multi-hop via MUSDC)
  if (miloMusdcReserves && meloMusdcReserves &&
      miloMusdcReserves.reserveA > BigInt(0) && miloMusdcReserves.reserveB > BigInt(0) &&
      meloMusdcReserves.reserveA > BigInt(0) && meloMusdcReserves.reserveB > BigInt(0)) {
    // Price: MILO -> MUSDC -> MELO
    // MILO/MUSDC price * MUSDC/MELO price = MILO/MELO price
    const miloMusdcPrice = Number(miloMusdcReserves.reserveB) / Number(miloMusdcReserves.reserveA);
    const musdcMeloPrice = Number(meloMusdcReserves.reserveA) / Number(meloMusdcReserves.reserveB);
    const miloMeloPrice = miloMusdcPrice * musdcMeloPrice;
    markets.push({
      pair: 'MILO/MELO',
      last: miloMeloPrice.toFixed(8),
      change: '2-hop',
      vol: '0',
    });
  } else {
    markets.push({
      pair: 'MILO/MELO',
      last: '0.00000000',
      change: '2-hop',
      vol: '0',
    });
  }

  return markets;
};

// Trade history interface
interface TradeHistory {
  time: string;
  timestamp: number;
  pair: string;
  price: string;
  amountIn: string;
  amountOut: string;
  side: 'buy' | 'sell';
  txId: string;
}

// Load trade history from localStorage
const loadTradeHistory = (): TradeHistory[] => {
  try {
    const stored = localStorage.getItem('milo_trade_history');
    if (!stored) return [];
    return JSON.parse(stored);
  } catch {
    return [];
  }
};

// Save trade history to localStorage
const saveTradeHistory = (trades: TradeHistory[]) => {
  try {
    // Keep only last 100 trades
    const recent = trades.slice(-100);
    localStorage.setItem('milo_trade_history', JSON.stringify(recent));
  } catch (e) {
    console.error('Failed to save trade history:', e);
  }
};

export default function Trade({ client, accountId, account, poolReserves, userBalances }: TradePageProps) {
  const { connected, address, requestTransaction } = useWallet();
  const [marketSearch, setMarketSearch] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [activeMarket, setActiveMarket] = useState('MILO/MUSDC');
  const [timeframe, setTimeframe] = useState('1H');
  const [chartTab, setChartTab] = useState<'trades' | 'depth'>('trades');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('market');
  const [privacyMode, setPrivacyMode] = useState<'public' | 'private'>('public');
  const [swapAmountIn, setSwapAmountIn] = useState<string>('');
  const [swapAmountOut, setSwapAmountOut] = useState<string>('');
  const [slippageTolerance, setSlippageTolerance] = useState<number>(0.5);
  const [swapReversed, setSwapReversed] = useState<boolean>(false);
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [limitExpiry, setLimitExpiry] = useState<string>('86400');
  const [limitOrders, setLimitOrders] = useState<any[]>([]);
  const [isLimitLoading, setIsLimitLoading] = useState<boolean>(false);
  const [bottomTab, setBottomTab] = useState<'balances' | 'orders' | 'history' | 'notes'>('balances');
  const [noteTab, setNoteTab] = useState<'incoming' | 'pending' | 'spent'>('incoming');
  const [notes, setNotes] = useState<Record<'incoming' | 'pending' | 'spent', any[]>>({
    incoming: [],
    pending: [],
    spent: [],
  });
  const [refreshing, setRefreshing] = useState(false);
  const [consuming, setConsuming] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<TradeHistory[]>([]);
  const [showMA, setShowMA] = useState(false);

  // Chart refs
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineSeriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const maSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  // Load trade history on mount
  useEffect(() => {
    setTradeHistory(loadTradeHistory());
  }, []);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#111720' },
        textColor: '#9aa4b2',
      },
      grid: {
        vertLines: { color: '#1c232d' },
        horzLines: { color: '#1c232d' },
      },
      width: chartContainerRef.current.clientWidth,
      height: 400,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#2b3440',
      },
      rightPriceScale: {
        borderColor: '#2b3440',
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#4a5568', width: 1, style: 2 },
        horzLine: { color: '#4a5568', width: 1, style: 2 },
      },
    });

    chartRef.current = chart;

    // Create area series for price
    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: '#1f6feb',
      topColor: 'rgba(31, 111, 235, 0.4)',
      bottomColor: 'rgba(31, 111, 235, 0.0)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 6,
        minMove: 0.000001,
      },
    });
    lineSeriesRef.current = areaSeries;

    // Create MA line series
    const maSeries = chart.addSeries(LineSeries, {
      color: '#ff6b35',
      lineWidth: 1,
      priceFormat: {
        type: 'price',
        precision: 6,
        minMove: 0.000001,
      },
    });
    maSeriesRef.current = maSeries;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // Update chart data when trade history or reserves change
  useEffect(() => {
    if (!lineSeriesRef.current || !maSeriesRef.current) return;

    const currentReserves = poolReserves[activeMarket];
    const currentPrice = currentReserves && currentReserves.reserveA > BigInt(0)
      ? Number(currentReserves.reserveB) / Number(currentReserves.reserveA)
      : 0;

    // Get trades for current market
    const marketTrades = tradeHistory
      .filter(t => t.pair === activeMarket)
      .sort((a, b) => a.timestamp - b.timestamp);

    // Build chart data
    let chartData: { time: Time; value: number }[] = [];

    // Add historical trades
    marketTrades.forEach((trade) => {
      chartData.push({
        time: Math.floor(trade.timestamp / 1000) as Time,
        value: parseFloat(trade.price),
      });
    });

    // Add current price if available
    if (currentPrice > 0 && chartData.length === 0) {
      const now = Math.floor(Date.now() / 1000);
      // Create some sample data points for visualization (skip i=0 to avoid duplicate with current price)
      for (let i = 10; i >= 1; i--) {
        chartData.push({
          time: (now - i * 60) as Time,
          value: currentPrice * (1 + (Math.random() - 0.5) * 0.02),
        });
      }
      chartData.push({ time: now as Time, value: currentPrice });
    } else if (currentPrice > 0) {
      const now = Math.floor(Date.now() / 1000);
      // Only add if no existing data point at this timestamp
      const lastTime = chartData.length > 0 ? (chartData[chartData.length - 1].time as number) : 0;
      if (now > lastTime) {
        chartData.push({
          time: now as Time,
          value: currentPrice,
        });
      }
    }

    // Deduplicate by timestamp (keep last value for each timestamp) and sort
    const timeMap = new Map<number, number>();
    chartData.forEach(d => timeMap.set(d.time as number, d.value));
    chartData = Array.from(timeMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time: time as Time, value }));

    // Update price series
    if (chartData.length > 0) {
      lineSeriesRef.current.setData(chartData);

      // Calculate and set MA data if enabled
      if (showMA && chartData.length >= 5) {
        const maData: { time: Time; value: number }[] = [];
        for (let i = 4; i < chartData.length; i++) {
          const sum = chartData.slice(i - 4, i + 1).reduce((acc, d) => acc + d.value, 0);
          maData.push({
            time: chartData[i].time,
            value: sum / 5,
          });
        }
        maSeriesRef.current.setData(maData);
      } else {
        maSeriesRef.current.setData([]);
      }

      // Fit content
      chartRef.current?.timeScale().fitContent();
    }
  }, [tradeHistory, poolReserves, activeMarket, showMA]);

  const selectedPool = useMemo(() => {
    const pool = POOLS.find(p => p.pair === activeMarket);
    if (pool) return pool;
    // Virtual pair (multi-hop): return first pool as fallback
    if (activeMarket === 'MILO/MELO') {
      return { pair: 'MILO/MELO', tokenA: 'MILO', tokenB: 'MELO', poolAccountIdHex: POOLS[0].poolAccountIdHex };
    }
    return undefined;
  }, [activeMarket]);

  const { swap, multiHopSwap, isLoading: isSwapLoading, error: swapError, txId: swapTxId, noteId: swapNoteId } = useSwap({
    client,
    accountId: accountId || null,
    poolAccountId: selectedPool?.poolAccountIdHex || null,
  });

  // Calculate swap amount out based on pool reserves (supports multi-hop)
  useEffect(() => {
    if (!selectedPool || !swapAmountIn || swapAmountIn === '0') {
      setSwapAmountOut('');
      return;
    }

    try {
      const tokenA = getTokenBySymbol(selectedPool.tokenA);
      const tokenB = getTokenBySymbol(selectedPool.tokenB);
      if (!tokenA || !tokenB) return;

      const tokenIn = swapReversed ? tokenB : tokenA;
      const tokenOut = swapReversed ? tokenA : tokenB;
      const amountIn = BigInt(Math.round(parseFloat(swapAmountIn) * 10 ** (tokenIn.decimals ?? 0)));

      // Check for multi-hop route
      const route = findSwapRoute(tokenIn.symbol, tokenOut.symbol);

      if (route && !route.isDirect) {
        // Multi-hop estimation
        const multiHopEstimate = estimateMultiHopOutput(route, amountIn, poolReserves);
        if (multiHopEstimate) {
          const amountOutTokens = Number(multiHopEstimate.estimatedOut) / (10 ** (tokenOut.decimals ?? 0));
          setSwapAmountOut(amountOutTokens.toFixed(8));
        } else {
          setSwapAmountOut('');
        }
      } else {
        // Direct route estimation
        const reserves = poolReserves[activeMarket];
        if (!reserves || reserves.reserveA === BigInt(0) || reserves.reserveB === BigInt(0)) {
          setSwapAmountOut('');
          return;
        }

        const fee = BigInt(1000);
        const reserveIn = swapReversed ? reserves.reserveB : reserves.reserveA;
        const reserveOut = swapReversed ? reserves.reserveA : reserves.reserveB;

        const amountInWithFee = amountIn * (BigInt(1000000) - fee);
        const numerator = Number(amountInWithFee * reserveOut);
        const denominator = Number(reserveIn * BigInt(1000000) + amountInWithFee);
        const amountOutRaw = numerator / denominator;

        const amountOutTokens = amountOutRaw / (10 ** (tokenOut.decimals ?? 0));
        setSwapAmountOut(amountOutTokens.toFixed(8));
      }
    } catch (error) {
      console.error('Error calculating swap amount:', error);
      setSwapAmountOut('');
    }
  }, [swapAmountIn, activeMarket, poolReserves, selectedPool, swapReversed]);

  const filteredMarkets = useMemo(() => {
    const markets = getMarkets(poolReserves);
    const bySearch = markets.filter((market) =>
      market.pair.toLowerCase().includes(marketSearch.toLowerCase())
    );
    if (!favoriteOnly) {
      return bySearch;
    }
    return bySearch.filter((market) => market.pair === 'MILO/MUSDC');
  }, [marketSearch, favoriteOnly, poolReserves]);

  const formatBalance = (balance: bigint, decimals: number): string => {
    if (balance === BigInt(0)) return '0';
    const divisor = BigInt(10 ** decimals);
    const whole = balance / divisor;
    const fraction = balance % divisor;
    if (fraction === BigInt(0)) return whole.toString();
    const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fractionStr ? `${whole}.${fractionStr}` : whole.toString();
  };

  // Get token balance (check both primary and legacy IDs)
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

  // Fetch limit orders from daemon
  const fetchLimitOrders = useCallback(async () => {
    if (!accountId) return;
    try {
      const res = await fetch(`${SWAP_DAEMON_URL}/limit_orders?user_id=${accountId}`);
      if (res.ok) {
        const data = await res.json();
        setLimitOrders(data.orders || []);
      }
    } catch (e) {
      console.warn('Failed to fetch limit orders:', e);
    }
  }, [accountId]);

  // Periodically fetch limit orders
  useEffect(() => {
    if (!accountId) return;
    fetchLimitOrders();
    const interval = setInterval(fetchLimitOrders, 30000);
    return () => clearInterval(interval);
  }, [accountId, fetchLimitOrders]);

  // Handle limit order creation
  const handleLimitOrder = useCallback(async () => {
    if (!swapAmountIn || !activeMarket || !connected || !accountId || !limitPrice) {
      toast.error('Please fill in all limit order fields');
      return;
    }

    const [tokenA, tokenB] = activeMarket.split('/');
    const sellTokenSymbol = swapReversed ? tokenB : tokenA;
    const buyTokenSymbol = swapReversed ? tokenA : tokenB;

    const sellToken = getTokenBySymbol(sellTokenSymbol);
    const buyToken = getTokenBySymbol(buyTokenSymbol);

    if (!sellToken || !buyToken) {
      toast.error(`Token not found: ${sellTokenSymbol} or ${buyTokenSymbol}`);
      return;
    }

    let sellTokenFaucetId = sellToken.faucetId;
    let buyTokenFaucetId = buyToken.faucetId;

    if (sellTokenSymbol === 'MIDEN') {
      sellTokenFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
    }
    if (buyTokenSymbol === 'MIDEN') {
      buyTokenFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
    }

    const sellTokenDecimals = sellToken.decimals ?? 0;
    const buyTokenDecimals = buyToken.decimals ?? 0;
    const amountRaw = BigInt(Math.floor(parseFloat(swapAmountIn) * 10 ** sellTokenDecimals));

    // Check balance
    const userBalance = getTokenBalance(sellTokenSymbol, sellToken.faucetId);
    if (amountRaw > userBalance) {
      toast.error(`Insufficient balance. You have ${formatBalance(userBalance, sellTokenDecimals)} ${sellTokenSymbol}`);
      return;
    }

    // Calculate min amount out from limit price
    const targetPrice = parseFloat(limitPrice);
    const minAmountOutFloat = parseFloat(swapAmountIn) * targetPrice;
    const minAmountOut = BigInt(Math.floor(minAmountOutFloat * 10 ** buyTokenDecimals));

    const poolHex = getPoolAccountIdHex(sellTokenSymbol, buyTokenSymbol);

    setIsLimitLoading(true);

    try {
      // Create the P2ID swap note (same as market order)
      toast.info('Creating limit order note...');

      await swap({
        amount: amountRaw,
        minAmountOut,
        sellToken: {
          faucetId: AccountId.fromHex(sellTokenFaucetId),
          decimals: sellTokenDecimals,
        },
        buyToken: {
          faucetId: AccountId.fromHex(buyTokenFaucetId),
          decimals: buyTokenDecimals,
        },
        isPrivate: privacyMode === 'private',
      });

      // After the swap note is created and tracked, register as limit order
      const swapNoteIdVal = swapNoteId || `limit-${Date.now()}`;

      try {
        const res = await fetch(`${SWAP_DAEMON_URL}/limit_order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note_id: swapNoteIdVal,
            pool_id: poolHex,
            user_account_id: accountId,
            sell_token_id: sellTokenFaucetId,
            buy_token_id: buyTokenFaucetId,
            amount_in: amountRaw.toString(),
            target_price: targetPrice,
            min_amount_out: minAmountOut.toString(),
            expires_in_secs: parseInt(limitExpiry),
            swap_info: {
              noteId: swapNoteIdVal,
              poolAccountId: poolHex,
              sellTokenId: sellTokenFaucetId,
              buyTokenId: buyTokenFaucetId,
              amountIn: amountRaw.toString(),
              minAmountOut: minAmountOut.toString(),
              userAccountId: accountId,
              timestamp: Date.now(),
            },
          }),
        });

        if (res.ok) {
          const data = await res.json();
          toast.success(`Limit order placed! ID: ${data.order_id}`);
          await fetchLimitOrders();
        } else {
          toast.warning('Note submitted but limit order registration failed');
        }
      } catch (e) {
        console.warn('Failed to register limit order with daemon:', e);
        toast.warning('Note submitted but limit order registration failed');
      }

      setSwapAmountIn('');
      setSwapAmountOut('');
      setLimitPrice('');
    } catch (err: any) {
      console.error('Limit order failed:', err);
      toast.error(`Limit order failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsLimitLoading(false);
    }
  }, [swapAmountIn, activeMarket, connected, accountId, limitPrice, limitExpiry, swapReversed,
      privacyMode, swap, swapNoteId, fetchLimitOrders, poolReserves, userBalances]);

  const handleSwap = useCallback(async () => {
    if (orderType === 'limit') {
      await handleLimitOrder();
      return;
    }
    
    if (!swapAmountIn || !activeMarket || !connected || !accountId) {
      toast.error('Please enter amount and ensure wallet is connected');
      return;
    }
    
    const [tokenA, tokenB] = activeMarket.split('/');
    const sellTokenSymbol = swapReversed ? tokenB : tokenA;
    const buyTokenSymbol = swapReversed ? tokenA : tokenB;
    
    const sellToken = getTokenBySymbol(sellTokenSymbol);
    const buyToken = getTokenBySymbol(buyTokenSymbol);
    
    if (!sellToken || !buyToken) {
      toast.error(`Token not found: ${sellTokenSymbol} or ${buyTokenSymbol}`);
      return;
    }
    
    // IMPORTANT: MILOA/MILOB use PRIMARY IDs, MIDEN uses LEGACY ID
    let sellTokenFaucetId = sellToken.faucetId;
    let buyTokenFaucetId = buyToken.faucetId;
    
    if (sellTokenSymbol === 'MIDEN') {
      sellTokenFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
    }
    
    if (buyTokenSymbol === 'MIDEN') {
      buyTokenFaucetId = '0x28ecf29ca19ddb201429b79bb696fb';
    }
    
    // Check balance
    const userBalance = getTokenBalance(sellTokenSymbol, sellToken.faucetId);
    const sellTokenDecimals = sellToken.decimals ?? 0;
    const buyTokenDecimals = buyToken.decimals ?? 0;
    
    // Convert amount to raw (with decimals)
    const amountRaw = BigInt(Math.floor(parseFloat(swapAmountIn) * 10 ** sellTokenDecimals));
    
    if (amountRaw > userBalance) {
      toast.error(`Insufficient balance. You have ${formatBalance(userBalance, sellTokenDecimals)} ${sellTokenSymbol}`);
      return;
    }
    
    // Detect route (direct or multi-hop)
    const route = findSwapRoute(sellTokenSymbol, buyTokenSymbol);

    if (!route) {
      toast.error(`No route found for ${sellTokenSymbol} -> ${buyTokenSymbol}`);
      return;
    }

    // Calculate min amount out using pool reserves
    let estimatedOut: bigint;
    let estimatedOutDisplay: number;
    let intermediateAmount: bigint | undefined;

    if (!route.isDirect) {
      // Multi-hop: estimate via both pools
      const multiHopEstimate = estimateMultiHopOutput(route, amountRaw, poolReserves);
      if (multiHopEstimate) {
        estimatedOut = multiHopEstimate.estimatedOut;
        intermediateAmount = multiHopEstimate.intermediateAmount;
        estimatedOutDisplay = Number(estimatedOut);
      } else {
        estimatedOut = amountRaw;
        estimatedOutDisplay = Number(amountRaw);
        intermediateAmount = amountRaw;
      }
    } else {
      const reserves = poolReserves[activeMarket];
      if (reserves && reserves.reserveA > BigInt(0) && reserves.reserveB > BigInt(0)) {
        const reserveIn = swapReversed ? reserves.reserveB : reserves.reserveA;
        const reserveOut = swapReversed ? reserves.reserveA : reserves.reserveB;

        const fee = BigInt(1000);
        const amountInWithFee = amountRaw * (BigInt(1000000) - fee);

        estimatedOut = (amountInWithFee * reserveOut) / (reserveIn * BigInt(1000000) + amountInWithFee);

        const numerator = Number(amountInWithFee * reserveOut);
        const denominator = Number(reserveIn * BigInt(1000000) + amountInWithFee);
        estimatedOutDisplay = numerator / denominator;
      } else {
        estimatedOut = amountRaw;
        estimatedOutDisplay = Number(amountRaw);
      }
    }

    // Apply slippage tolerance
    const slippageFactor = BigInt(Math.round((100 - slippageTolerance) * 1e6));
    const minAmountOut = (estimatedOut * slippageFactor) / BigInt(1e8);

    try {
      if (!route.isDirect && intermediateAmount) {
        // Multi-hop swap
        const intermediateToken = getTokenBySymbol('MUSDC');
        if (!intermediateToken) {
          toast.error('Intermediate token (MUSDC) not found');
          return;
        }

        toast.info(`Multi-hop swap: ${sellTokenSymbol} -> MUSDC -> ${buyTokenSymbol} (2 hops)`);

        await multiHopSwap({
          amount: amountRaw,
          minFinalAmountOut: minAmountOut,
          intermediateAmount,
          sellToken: {
            faucetId: AccountId.fromHex(sellTokenFaucetId),
            decimals: sellTokenDecimals,
          },
          buyToken: {
            faucetId: AccountId.fromHex(buyTokenFaucetId),
            decimals: buyTokenDecimals,
          },
          intermediateToken: {
            faucetId: AccountId.fromHex(intermediateToken.faucetId),
            decimals: intermediateToken.decimals,
          },
          pool1Hex: route.pools[0],
          pool2Hex: route.pools[1],
          isPrivate: privacyMode === 'private',
        });
      } else {
        // Direct swap
        toast.info('Submitting swap transaction...');

        await swap({
          amount: amountRaw,
          minAmountOut,
          sellToken: {
            faucetId: AccountId.fromHex(sellTokenFaucetId),
            decimals: sellTokenDecimals,
          },
          buyToken: {
            faucetId: AccountId.fromHex(buyTokenFaucetId),
            decimals: buyTokenDecimals,
          },
          isPrivate: privacyMode === 'private',
        });
      }

      // Calculate actual price per token (accounting for decimals)
      const amountInDisplay = Number(amountRaw) / (10 ** sellTokenDecimals);
      const amountOutDisplay = estimatedOutDisplay / (10 ** buyTokenDecimals);
      const pricePerToken = amountOutDisplay / amountInDisplay;

      // Create trade record
      const now = new Date();
      const newTrade: TradeHistory = {
        time: now.toLocaleTimeString('en-US', { hour12: false }),
        timestamp: now.getTime(),
        pair: activeMarket,
        price: pricePerToken.toFixed(8),
        amountIn: swapAmountIn,
        amountOut: amountOutDisplay.toFixed(6),
        side: swapReversed ? 'sell' : 'buy',
        txId: 'pending', // Will be updated when tx confirms
      };

      // Update trade history
      const updatedHistory = [...tradeHistory, newTrade];
      setTradeHistory(updatedHistory);
      saveTradeHistory(updatedHistory);

      // Record trade for APY calculation (0.1% fee)
      const feeAmount = amountRaw / BigInt(1000); // 0.1% fee
      if (selectedPool?.poolAccountIdHex) {
        recordTrade(selectedPool.poolAccountIdHex, amountRaw, estimatedOut, feeAmount);
      }

      toast.success('✅ Swap submitted! Auto-consuming tokens...');
      toast.info('⏳ Tokens will be received automatically. Use "Consume Notes" if needed.', {
        autoClose: 6000
      });
      setSwapAmountIn('');
      setSwapAmountOut('');
    } catch (err: any) {
      console.error('Swap failed:', err);
      toast.error(`Swap failed: ${err?.message || 'Unknown error'}`);
    }
  }, [orderType, swapAmountIn, activeMarket, connected, accountId, swapReversed, poolReserves, slippageTolerance, swap, userBalances, handleLimitOrder]);

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

          const consumeTxBuilder = new TransactionRequestBuilder();
          const noteAndArgs = new NoteAndArgs(note, null);
          const transactionRequest = consumeTxBuilder
            .withInputNotes(new NoteAndArgsArray([noteAndArgs]))
            .build();

          const customTxPayload = new CustomTransaction(
            address || accountId,
            address || accountId,
            transactionRequest,
            [noteIdStr],
            undefined
          );

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
  }, [client, accountId, address, requestTransaction]);

  // Fetch notes when notes tab is selected
  useEffect(() => {
    if (bottomTab === 'notes' && client && accountId) {
      const fetchNotes = async () => {
        try {
          await client.syncState();
          const accountIdObj = AccountId.fromHex(accountId);
          const consumableNotes = await client.getConsumableNotes(accountIdObj);

          const incomingNotes = consumableNotes.map((consumable: any) => {
            const noteRecord = consumable.inputNoteRecord();
            const noteIdStr = noteRecord.id().toString();
            const assets = noteRecord.assets();

            return {
              id: noteIdStr.substring(0, 16) + '...',
              asset: 'Token',
              amount: assets.length > 0 ? 'Available' : 'N/A',
              status: noteRecord.isConsumed() ? 'Consumed' :
                      noteRecord.isProcessing() ? 'Processing' : 'Ready',
            };
          });

          setNotes({
            incoming: incomingNotes,
            pending: [],
            spent: [],
          });
        } catch (error) {
          console.error('Failed to fetch notes:', error);
        }
      };

      fetchNotes();
    }
  }, [bottomTab, client, accountId]);

  return (
    <div className="app">
      <section className="terminal">
        <aside className="panel markets">
          <div className="panel-header">
            <span>Markets</span>
          </div>
          <div className="market-search">
            <input
              type="text"
              placeholder="Search"
              value={marketSearch}
              onChange={(event) => setMarketSearch(event.target.value)}
            />
            <label className="favorite-toggle">
              <input
                type="checkbox"
                checked={favoriteOnly}
                onChange={(event) => setFavoriteOnly(event.target.checked)}
              />
              Favorites
            </label>
          </div>
          <div className="market-list">
            {filteredMarkets.map((market) => (
              <button
                key={market.pair}
                className={`market-row ${activeMarket === market.pair ? 'active' : ''}`}
                onClick={() => {
                  setActiveMarket(market.pair);
                  setSwapAmountIn('');
                  setSwapAmountOut('');
                }}
              >
                <div className="market-pair">{market.pair}</div>
                <div className="market-meta">
                  <span>{market.last}</span>
                  <span className={market.change.startsWith('-') ? 'down' : 'up'}>
                    {market.change}
                  </span>
                  <span>{market.vol}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel chart">
          <div className="panel-header chart-header">
            <div className="pair-title">
              {activeMarket}
              {poolReserves[activeMarket] && (
                <span style={{ marginLeft: '12px', fontSize: '1.1rem', color: '#51cf66' }}>
                  {(Number(poolReserves[activeMarket].reserveB) / Number(poolReserves[activeMarket].reserveA)).toFixed(6)}
                </span>
              )}
            </div>
            <div className="timeframes">
              {['1M', '5M', '15M', '1H', '4H', '1D'].map((frame) => (
                <button
                  key={frame}
                  className={`chip ${timeframe === frame ? 'active' : ''}`}
                  onClick={() => setTimeframe(frame)}
                >
                  {frame}
                </button>
              ))}
            </div>
            <select
              className="indicator-select"
              value={showMA ? 'ma' : 'none'}
              onChange={(e) => setShowMA(e.target.value === 'ma')}
            >
              <option value="none">Indicators</option>
              <option value="ma">MA (5)</option>
            </select>
          </div>

          {/* Real TradingView-style Chart */}
          <div
            className="chart-canvas"
            ref={chartContainerRef}
            style={{ height: '400px', minHeight: '400px' }}
          />

          {/* Price Info Bar */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '8px 16px',
            background: '#0d1117',
            borderTop: '1px solid #21262d',
            fontSize: '0.85rem'
          }}>
            <div style={{ display: 'flex', gap: '24px' }}>
              <span><span style={{ color: '#9aa4b2' }}>Pair:</span> <span style={{ color: '#fff' }}>{activeMarket}</span></span>
              {poolReserves[activeMarket] && (
                <>
                  <span><span style={{ color: '#9aa4b2' }}>{selectedPool?.tokenA}:</span> <span style={{ color: '#51cf66' }}>{poolReserves[activeMarket].reserveA.toString()}</span></span>
                  <span><span style={{ color: '#9aa4b2' }}>{selectedPool?.tokenB}:</span> <span style={{ color: '#1f6feb' }}>{poolReserves[activeMarket].reserveB.toString()}</span></span>
                </>
              )}
            </div>
            <div>
              <span style={{ color: '#9aa4b2' }}>Trades: </span>
              <span style={{ color: '#fff' }}>{tradeHistory.filter(t => t.pair === activeMarket).length}</span>
            </div>
          </div>

          {/* Trade History Section */}
          <div className="chart-tabs" style={{ marginTop: '8px' }}>
            <button
              className={chartTab === 'trades' ? 'active' : ''}
              onClick={() => setChartTab('trades')}
            >
              Recent Trades
            </button>
            <button
              className={chartTab === 'depth' ? 'active' : ''}
              onClick={() => setChartTab('depth')}
            >
              Pool Info
            </button>
          </div>
          <div className="chart-mini" style={{ height: '180px', minHeight: '180px', maxHeight: '180px', overflow: 'auto' }}>
            {chartTab === 'trades' ? (
              <table>
                <thead style={{ position: 'sticky', top: 0, background: '#111720', zIndex: 1 }}>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th>Price</th>
                    <th>Amount In</th>
                    <th>Amount Out</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory
                    .filter(trade => trade.pair === activeMarket)
                    .slice(-50)
                    .reverse()
                    .map((trade, idx) => (
                      <tr key={`${trade.txId}-${idx}`}>
                        <td style={{ color: '#9aa4b2' }}>{trade.time}</td>
                        <td>
                          <span style={{
                            padding: '2px 6px',
                            borderRadius: '3px',
                            fontSize: '0.75rem',
                            background: trade.side === 'buy' ? 'rgba(81, 207, 102, 0.2)' : 'rgba(248, 81, 73, 0.2)',
                            color: trade.side === 'buy' ? '#51cf66' : '#f85149'
                          }}>
                            {trade.side.toUpperCase()}
                          </span>
                        </td>
                        <td className={trade.side === 'buy' ? 'up' : 'down'}>{parseFloat(trade.price).toFixed(6)}</td>
                        <td>{trade.amountIn}</td>
                        <td>{trade.amountOut}</td>
                      </tr>
                    ))}
                  {tradeHistory.filter(trade => trade.pair === activeMarket).length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: '#9aa4b2', padding: '2rem' }}>
                        No trades yet. Execute a swap to see trade history.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <div style={{
                padding: '1.5rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '1rem'
              }}>
                <div style={{ textAlign: 'center', fontSize: '1.1rem', color: '#fff' }}>
                  📊 AMM Liquidity Pool
                </div>
                {poolReserves[activeMarket] && (
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '1rem',
                    background: '#0d1117',
                    padding: '1rem',
                    borderRadius: '8px'
                  }}>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#9aa4b2', marginBottom: '4px' }}>Reserve {selectedPool?.tokenA}</div>
                      <div style={{ color: '#51cf66', fontSize: '1.2rem', fontWeight: 'bold' }}>
                        {poolReserves[activeMarket].reserveA.toString()}
                      </div>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ color: '#9aa4b2', marginBottom: '4px' }}>Reserve {selectedPool?.tokenB}</div>
                      <div style={{ color: '#1f6feb', fontSize: '1.2rem', fontWeight: 'bold' }}>
                        {poolReserves[activeMarket].reserveB.toString()}
                      </div>
                    </div>
                    <div style={{ gridColumn: '1 / -1', textAlign: 'center', borderTop: '1px solid #21262d', paddingTop: '1rem' }}>
                      <div style={{ color: '#9aa4b2', marginBottom: '4px' }}>Current Price</div>
                      <div style={{ color: '#ff6b35', fontSize: '1.3rem', fontWeight: 'bold' }}>
                        {(Number(poolReserves[activeMarket].reserveB) / Number(poolReserves[activeMarket].reserveA)).toFixed(6)}
                        <span style={{ fontSize: '0.9rem', color: '#9aa4b2', marginLeft: '8px' }}>
                          {selectedPool?.tokenB}/{selectedPool?.tokenA}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="panel trade">
          <div className="panel-header">
            <span>Trade</span>
          </div>
          <div className="order-type">
            <button
              className={orderType === 'market' ? 'active' : ''}
              onClick={() => setOrderType('market')}
            >
              Market
            </button>
            <button
              className={orderType === 'limit' ? 'active' : ''}
              onClick={() => setOrderType('limit')}
            >
              Limit
            </button>
          </div>
          {orderType === 'limit' ? (
            <div style={{ padding: '15px 0' }}>
              {(() => {
                const [tokenA, tokenB] = activeMarket.split('/');
                const tokenIn = swapReversed ? tokenB : tokenA;
                const tokenOut = swapReversed ? tokenA : tokenB;
                const tokenInMeta = getTokenBySymbol(tokenIn);
                const tokenOutMeta = getTokenBySymbol(tokenOut);
                const balanceIn = getTokenBalance(tokenIn, tokenInMeta?.faucetId || '');
                return (
                  <>
                    <div style={{ margin: '10px 0', padding: '12px', background: '#1a1a1a', borderRadius: '8px', border: '1px solid #2a2a2a' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ color: '#9aa4b2', fontSize: '0.9rem' }}>Limit Price ({tokenOut}/{tokenIn})</span>
                      </div>
                      <input
                        type="number"
                        placeholder="0.0"
                        value={limitPrice}
                        onChange={(e) => setLimitPrice(e.target.value)}
                        style={{ width: '100%', background: 'transparent', border: 'none', color: '#fff', fontSize: '1.2rem', outline: 'none' }}
                      />
                    </div>
                    <div style={{ margin: '10px 0', padding: '12px', background: '#1a1a1a', borderRadius: '8px', border: '1px solid #2a2a2a' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ color: '#9aa4b2', fontSize: '0.9rem' }}>Amount ({tokenIn})</span>
                        <span style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>
                          Balance: {formatBalance(balanceIn, tokenInMeta?.decimals ?? 0)}
                        </span>
                      </div>
                      <input
                        type="number"
                        placeholder="0.0"
                        value={swapAmountIn}
                        onChange={(e) => setSwapAmountIn(e.target.value)}
                        style={{ width: '100%', background: 'transparent', border: 'none', color: '#fff', fontSize: '1.2rem', outline: 'none' }}
                      />
                    </div>
                    <div style={{ margin: '10px 0', padding: '12px', background: '#1a1a1a', borderRadius: '8px', border: '1px solid #2a2a2a' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                        <span style={{ color: '#9aa4b2', fontSize: '0.9rem' }}>Expiry</span>
                      </div>
                      <select
                        value={limitExpiry}
                        onChange={(e) => setLimitExpiry(e.target.value)}
                        style={{ width: '100%', background: '#0d0d0d', border: '1px solid #2a2a2a', color: '#fff', fontSize: '1rem', padding: '8px', borderRadius: '4px', outline: 'none' }}
                      >
                        <option value="3600">1 hour</option>
                        <option value="86400">24 hours</option>
                        <option value="604800">7 days</option>
                      </select>
                    </div>
                    {limitPrice && swapAmountIn && (
                      <div style={{ margin: '10px 0', padding: '8px', background: '#1a1a2a', borderRadius: '6px', fontSize: '12px', color: '#818cf8' }}>
                        You will receive at least {(parseFloat(swapAmountIn) * parseFloat(limitPrice)).toFixed(6)} {tokenOut}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          ) : (
            <>
              {/* Standard Swap Form with Direction Toggle */}
              {(() => {
                const [tokenA, tokenB] = activeMarket.split('/');
                const tokenIn = swapReversed ? tokenB : tokenA;
                const tokenOut = swapReversed ? tokenA : tokenB;
                const tokenInMeta = getTokenBySymbol(tokenIn);
                const tokenOutMeta = getTokenBySymbol(tokenOut);
                const balanceIn = getTokenBalance(tokenIn, tokenInMeta?.faucetId || '');
                const balanceOut = getTokenBalance(tokenOut, tokenOutMeta?.faucetId || '');
                
                return (
                  <>
                    {/* Input Token */}
                    <div style={{ 
                      margin: '15px 0', 
                      padding: '15px', 
                      background: '#1a1a1a', 
                      borderRadius: '8px',
                      border: '1px solid #2a2a2a'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ color: '#9aa4b2', fontSize: '0.9rem' }}>You pay</span>
                        {connected && account && (
                          <span style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>
                            Balance: {formatBalance(balanceIn, tokenInMeta?.decimals ?? 0)}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <input 
                          type="text" 
                          placeholder="0.0" 
                          value={swapAmountIn}
                          onChange={(e) => {
                            const value = e.target.value;
                            if (value === '' || /^\d*\.?\d*$/.test(value)) {
                              setSwapAmountIn(value);
                            }
                          }}
                          disabled={!connected || isSwapLoading}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            outline: 'none',
                            color: '#fff',
                            fontSize: '24px',
                            fontWeight: '500',
                            flex: 1,
                            padding: '0',
                          }}
                        />
                        <div style={{ 
                          padding: '6px 12px', 
                          background: '#2a2a2a', 
                          borderRadius: '6px',
                          fontSize: '14px',
                          fontWeight: '500'
                        }}>
                          {tokenIn}
                        </div>
                      </div>
                    </div>

                    {/* Swap Direction Toggle Button */}
                    <div style={{ display: 'flex', justifyContent: 'center', margin: '-10px 0' }}>
                      <button
                        onClick={() => {
                          setSwapReversed(!swapReversed);
                          setSwapAmountIn('');
                          setSwapAmountOut('');
                        }}
                        style={{
                          padding: '12px',
                          background: '#1a1a1a',
                          border: '2px solid #2a2a2a',
                          borderRadius: '50%',
                          cursor: 'pointer',
                          fontSize: '20px',
                          color: '#4ade80',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '40px',
                          height: '40px',
                          zIndex: 1,
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = '#2a2a2a';
                          e.currentTarget.style.borderColor = '#3a3a3a';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = '#1a1a1a';
                          e.currentTarget.style.borderColor = '#2a2a2a';
                        }}
                        title="Swap direction"
                      >
                        ⇅
                      </button>
                    </div>

                    {/* Output Token */}
                    <div style={{ 
                      margin: '15px 0', 
                      padding: '15px', 
                      background: '#1a1a1a', 
                      borderRadius: '8px',
                      border: '1px solid #2a2a2a'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ color: '#9aa4b2', fontSize: '0.9rem' }}>You receive</span>
                        {connected && account && (
                          <span style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>
                            Balance: {formatBalance(balanceOut, tokenOutMeta?.decimals ?? 0)}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <input 
                          type="text" 
                          placeholder="0.0" 
                          value={swapAmountOut}
                          disabled
                          style={{
                            background: 'transparent',
                            border: 'none',
                            outline: 'none',
                            color: '#fff',
                            fontSize: '24px',
                            fontWeight: '500',
                            flex: 1,
                            padding: '0',
                            opacity: swapAmountIn ? 1 : 0.5,
                          }}
                        />
                        <div style={{ 
                          padding: '6px 12px', 
                          background: '#2a2a2a', 
                          borderRadius: '6px',
                          fontSize: '14px',
                          fontWeight: '500'
                        }}>
                          {tokenOut}
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()}
            </>
          )}
          {orderType === 'market' && (
            <div className="slippage-box" style={{ margin: '10px 0', padding: '10px', background: '#1a1a1a', borderRadius: '4px' }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>Slippage Tolerance:</span>
                <input 
                  type="number" 
                  value={slippageTolerance} 
                  onChange={(e) => setSlippageTolerance(parseFloat(e.target.value) || 0.5)}
                  min="0"
                  max="100"
                  step="0.1"
                  style={{ width: '80px', padding: '4px' }}
                />
                <span>%</span>
              </label>
            </div>
          )}
          {orderType === 'market' && (
            <div className="preset-row">
              {['25%', '50%', '75%', '100%'].map((pct) => {
                const percentage = parseFloat(pct.replace('%', ''));
                return (
                  <button 
                    key={pct} 
                    className="chip"
                    onClick={() => {
                      const [tokenA, tokenB] = activeMarket.split('/');
                      const tokenSymbol = swapReversed ? tokenB : tokenA;
                      const tokenMeta = getTokenBySymbol(tokenSymbol);
                      if (!tokenMeta) return;
                      
                      const balance = getTokenBalance(tokenSymbol, tokenMeta.faucetId);
                      const decimals = tokenMeta.decimals ?? 0;
                      const divisor = BigInt(10 ** decimals);
                      const balanceDecimal = Number(balance) / Number(divisor);
                      const amount = (balanceDecimal * percentage / 100).toString();
                      setSwapAmountIn(amount);
                    }}
                  >
                    {pct}
                  </button>
                );
              })}
            </div>
          )}
          <div className="fee-box">
            <div>Fee: 0.10%</div>
            <div>Est. total: {swapAmountOut || '0.00'}</div>
          </div>
          <div className="privacy">
            <div className="privacy-toggle">
              <span>Privacy mode</span>
              <div className="toggle-group">
                <button
                  className={privacyMode === 'public' ? 'active' : ''}
                  onClick={() => setPrivacyMode('public')}
                >
                  Public
                </button>
                <button
                  className={privacyMode === 'private' ? 'active' : ''}
                  onClick={() => setPrivacyMode('private')}
                >
                  Private
                </button>
              </div>
            </div>
            {privacyMode === 'private' && (
              <div className="privacy-hint">
                Private notes may require offchain note detail sharing.
              </div>
            )}
          </div>
          {(() => {
            const [tA, tB] = activeMarket.split('/');
            const sellSym = swapReversed ? tB : tA;
            const buySym = swapReversed ? tA : tB;
            const currentRoute = findSwapRoute(sellSym, buySym);
            if (currentRoute && !currentRoute.isDirect) {
              return (
                <div style={{ marginBottom: '8px', padding: '6px 10px', background: '#1a1a3a', borderRadius: '6px', fontSize: '12px', color: '#818cf8', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>Route:</span>
                  <span style={{ color: '#e2e8f0' }}>{currentRoute.path.join(' -> ')}</span>
                  <span style={{ color: '#64748b' }}>({currentRoute.hops} hops)</span>
                </div>
              );
            }
            return null;
          })()}
          <button
            className="primary-button full-width"
            onClick={handleSwap}
            disabled={!connected || isSwapLoading || isLimitLoading || !swapAmountIn || (orderType === 'limit' && !limitPrice)}
          >
            {orderType === 'limit'
              ? (isLimitLoading ? 'Placing...' : 'Place Limit Order')
              : (isSwapLoading ? 'Swapping...' : 'Place Order')}
          </button>
          {swapError && (
            <div style={{ color: 'red', marginTop: '10px', padding: '10px', background: '#2a1a1a', borderRadius: '4px' }}>
              ❌ Error: {swapError}
            </div>
          )}
          {swapTxId && (
            <div style={{ color: 'green', marginTop: '10px', padding: '10px', background: '#1a2a1a', borderRadius: '4px' }}>
              ✅ Transaction: {String(swapTxId).slice(0, 16)}...
            </div>
          )}
          {swapNoteId && (
            <div style={{ color: 'blue', marginTop: '10px', padding: '10px', background: '#1a1a2a', borderRadius: '4px' }}>
              📝 SWAP Note ID: {swapNoteId.slice(0, 16)}...
              <div style={{ fontSize: '0.85rem', marginTop: '5px', color: '#9aa4b2' }}>
                ✅ Pool will automatically consume this note. You'll receive tokens via P2ID note.
              </div>
            </div>
          )}
          {isSwapLoading && (
            <div className="tx-status">
              <span>Status:</span>
              <span className="tx-stage active">Building tx...</span>
              <span className="tx-stage">Proving...</span>
              <span className="tx-stage">Submitting...</span>
            </div>
          )}
        </aside>

        <section className="panel bottom">
          <div className="panel-header">
            <div className="tab-row">
              {(['balances', 'orders', 'history', 'notes'] as const).map((tab) => (
                <button
                  key={tab}
                  className={bottomTab === tab ? 'active' : ''}
                  onClick={() => setBottomTab(tab)}
                >
                  {tab === 'balances'
                    ? 'Balances'
                    : tab === 'orders'
                    ? 'Open Orders'
                    : tab === 'history'
                    ? 'History'
                    : tab === 'notes'
                    ? 'Notes'
                    : 'Faucet'}
                </button>
              ))}
            </div>
            <div className="tx-summary">
              <button
                className="ghost-button"
                onClick={async () => {
                  if (!client || !accountId) return;
                  setRefreshing(true);
                  try {
                    await client.syncState();
                    toast.success('State synced successfully');
                  } catch (error) {
                    console.error('Failed to refresh:', error);
                    toast.error('Failed to sync state');
                  } finally {
                    setRefreshing(false);
                  }
                }}
                disabled={!connected || refreshing}
              >
                {refreshing ? 'Syncing…' : 'Sync State'}
              </button>
              <button
                className="ghost-button"
                onClick={handleConsumeNotes}
                disabled={!connected || consuming || !requestTransaction}
                style={{ marginLeft: '8px' }}
              >
                {consuming ? 'Consuming…' : 'Consume Notes'}
              </button>
            </div>
          </div>
          <div className="panel-body">
            {bottomTab === 'balances' && (
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Total</th>
                    <th>Available</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const tokens = ['MILO', 'MELO', 'MUSDC'];

                    if (!connected) {
                      return (
                        <tr>
                          <td colSpan={3} style={{ textAlign: 'center', color: '#9aa4b2' }}>Connect wallet to view balances</td>
                        </tr>
                      );
                    }

                    return tokens.map(symbol => {
                      const token = getTokenBySymbol(symbol);
                      if (!token) return null;
                      const balance = getTokenBalance(symbol, token.faucetId);
                      const formatted = formatBalance(balance, token.decimals);
                      return (
                        <tr key={symbol}>
                          <td style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{
                              width: '24px',
                              height: '24px',
                              borderRadius: '50%',
                              background: token.color,
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '10px',
                              fontWeight: 'bold'
                            }}>
                              {symbol[0]}
                            </span>
                            {symbol}
                          </td>
                          <td>{formatted}</td>
                          <td>{formatted}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            )}

            {bottomTab === 'orders' && (
              <table>
                <thead>
                  <tr>
                    <th>Order ID</th>
                    <th>Status</th>
                    <th>Target Price</th>
                    <th>Amount</th>
                    <th>Expires</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {limitOrders.length > 0 ? (
                    limitOrders.map((order: any) => {
                      const expiresAt = new Date(order.expires_at * 1000);
                      const isExpired = Date.now() > order.expires_at * 1000;
                      const statusColor = order.status === 'Pending' ? '#f0b429'
                        : order.status === 'Filled' ? '#51cf66'
                        : order.status === 'Cancelled' ? '#9aa4b2'
                        : '#f85149';
                      return (
                        <tr key={order.order_id}>
                          <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                            {order.order_id.length > 20 ? order.order_id.substring(0, 20) + '...' : order.order_id}
                          </td>
                          <td>
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '0.75rem',
                              background: `${statusColor}22`,
                              color: statusColor,
                            }}>
                              {order.status}
                            </span>
                          </td>
                          <td>{order.target_price?.toFixed(6) ?? '-'}</td>
                          <td>{order.amount_in?.toLocaleString() ?? '-'}</td>
                          <td style={{ color: isExpired ? '#f85149' : '#9aa4b2', fontSize: '0.85rem' }}>
                            {expiresAt.toLocaleTimeString('en-US', { hour12: false })}
                          </td>
                          <td>
                            {order.status === 'Pending' && (
                              <button
                                className="ghost-button"
                                style={{ fontSize: '0.75rem', padding: '2px 8px', color: '#f85149' }}
                                onClick={async () => {
                                  try {
                                    const res = await fetch(`${SWAP_DAEMON_URL}/cancel_limit_order`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ order_id: order.order_id }),
                                    });
                                    if (res.ok) {
                                      toast.success(`Order ${order.order_id} cancelled`);
                                      await fetchLimitOrders();
                                    } else {
                                      toast.error('Failed to cancel order');
                                    }
                                  } catch (e) {
                                    toast.error('Failed to cancel order');
                                  }
                                }}
                              >
                                Cancel
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', color: '#9aa4b2' }}>
                        {!connected ? 'Connect wallet to view orders' : 'No open orders'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {bottomTab === 'history' && (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Pair</th>
                    <th>Side</th>
                    <th>Price</th>
                    <th>Amount In</th>
                    <th>Amount Out</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeHistory.length > 0 ? (
                    tradeHistory.slice().reverse().map((trade, idx) => (
                      <tr key={`${trade.timestamp}-${idx}`}>
                        <td>{trade.time}</td>
                        <td>{trade.pair}</td>
                        <td style={{ color: trade.side === 'buy' ? '#51cf66' : '#ff6b6b' }}>
                          {trade.side === 'buy' ? 'Buy' : 'Sell'}
                        </td>
                        <td>{trade.price}</td>
                        <td>{trade.amountIn}</td>
                        <td>{trade.amountOut}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} style={{ textAlign: 'center', color: '#9aa4b2' }}>No trade history</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            {bottomTab === 'notes' && (
              <div className="notes-panel">
                <div className="note-tabs">
                  {(['incoming', 'pending', 'spent'] as const).map((tab) => (
                    <button
                      key={tab}
                      className={noteTab === tab ? 'active' : ''}
                      onClick={() => setNoteTab(tab)}
                    >
                      {tab === 'incoming' ? `Incoming (${notes.incoming.length})` : tab === 'pending' ? `Pending (${notes.pending.length})` : `Spent (${notes.spent.length})`}
                    </button>
                  ))}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Note ID</th>
                      <th>Asset</th>
                      <th>Amount</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!connected ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#9aa4b2' }}>Connect wallet to view notes</td>
                      </tr>
                    ) : notes[noteTab].length > 0 ? notes[noteTab].map((row, idx) => (
                      <tr key={`${row.id}-${idx}`}>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{row.id}</td>
                        <td>{row.asset}</td>
                        <td>{row.amount}</td>
                        <td>
                          <span style={{
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            background: row.status === 'Ready' ? '#238636' : row.status === 'Processing' ? '#1f6feb' : '#30363d',
                            color: '#fff'
                          }}>
                            {row.status}
                          </span>
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', color: '#9aa4b2' }}>No {noteTab} notes found</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

          </div>
        </section>
      </section>
    </div>
  );
}
