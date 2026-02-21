import { useState, useEffect, useCallback } from 'react';

export interface PoolAPY {
  pool: string;
  pool_id: string;
  apy: string;
  volume_24h: number;
  fees_24h: number;
  trades_24h: number;
  tvl: number;
}

export interface TradeVolumeData {
  pool_id: string;
  volume_24h: number;
  fees_24h: number;
  trades_24h: number;
  last_updated: number;
}

import { LIQUIDITY_DAEMON_URL } from '../config/api';

const DAEMON_URL = LIQUIDITY_DAEMON_URL;

// Record a trade for volume tracking
// Amounts are in base units (8 decimals) - convert to human-readable before sending
export const recordTrade = async (
  poolId: string,
  amountIn: bigint,
  amountOut: bigint,
  feeAmount: bigint,
  decimals: number = 8
): Promise<boolean> => {
  try {
    const divisor = Math.pow(10, decimals);
    const response = await fetch(`${DAEMON_URL}/record_trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pool_id: poolId,
        amount_in: Number(amountIn) / divisor,
        amount_out: Number(amountOut) / divisor,
        fee_amount: Number(feeAmount) / divisor,
      }),
    });

    if (response.ok) {
      console.log('📊 Trade recorded for APY calculation');
      return true;
    }
    return false;
  } catch (error) {
    console.warn('⚠️ Failed to record trade:', error);
    return false;
  }
};

// Hook to fetch and track pool APY data
export const usePoolStats = () => {
  const [poolAPYs, setPoolAPYs] = useState<PoolAPY[]>([]);
  const [volumes, setVolumes] = useState<TradeVolumeData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAPY = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`${DAEMON_URL}/apy`);

      if (response.ok) {
        const data = await response.json();
        if (data.pools) {
          setPoolAPYs(data.pools);
        }
        setError(null);
      } else {
        setError('Failed to fetch APY data');
      }
    } catch (err) {
      // Daemon might not be running
      console.warn('⚠️ Could not fetch APY data:', err);
      setError('Daemon not available');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchVolumes = useCallback(async () => {
    try {
      const response = await fetch(`${DAEMON_URL}/trade_volume`);

      if (response.ok) {
        const data = await response.json();
        if (data.volumes) {
          setVolumes(data.volumes);
        }
      }
    } catch (err) {
      console.warn('⚠️ Could not fetch volume data:', err);
    }
  }, []);

  // Fetch on mount and periodically
  useEffect(() => {
    fetchAPY();
    fetchVolumes();

    // Refresh every 30 seconds
    const interval = setInterval(() => {
      fetchAPY();
      fetchVolumes();
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchAPY, fetchVolumes]);

  // Get APY for a specific pool
  const getAPYForPool = useCallback((poolPair: string): PoolAPY | null => {
    return poolAPYs.find(p => p.pool === poolPair) || null;
  }, [poolAPYs]);

  // Get volume for a specific pool
  const getVolumeForPool = useCallback((poolId: string): TradeVolumeData | null => {
    return volumes.find(v => v.pool_id === poolId) || null;
  }, [volumes]);

  // Format APY for display
  const formatAPY = (apy: string | number): string => {
    const value = typeof apy === 'string' ? parseFloat(apy) : apy;
    if (isNaN(value) || value === 0) return '0.00%';
    if (value < 0.01) return '<0.01%';
    if (value > 1000) return '>1000%';
    return `${value.toFixed(2)}%`;
  };

  // Format volume for display
  const formatVolume = (volume: number): string => {
    if (volume === 0) return '$0';
    if (volume < 1000) return `$${volume.toFixed(2)}`;
    if (volume < 1000000) return `$${(volume / 1000).toFixed(2)}K`;
    return `$${(volume / 1000000).toFixed(2)}M`;
  };

  return {
    poolAPYs,
    volumes,
    isLoading,
    error,
    fetchAPY,
    fetchVolumes,
    getAPYForPool,
    getVolumeForPool,
    formatAPY,
    formatVolume,
    recordTrade,
  };
};
