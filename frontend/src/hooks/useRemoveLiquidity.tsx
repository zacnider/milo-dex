import { useCallback, useMemo, useState } from 'react';
import { useWallet } from '@miden-sdk/miden-wallet-adapter';
import { LIQUIDITY_DAEMON_URL } from '../config/api';

export interface RemoveLiquidityResult {
  readonly success: boolean;
  readonly txId: string;
  readonly tokenAOut: bigint;
  readonly tokenBOut: bigint;
}

interface UseRemoveLiquidityProps {
  client: any;
  accountId: string | null;
  poolAccountId?: string | null;
}

export const useRemoveLiquidity = ({
  client,
  accountId,
  poolAccountId,
}: UseRemoveLiquidityProps) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const { connected } = useWallet();
  const [txId, setTxId] = useState<undefined | string>();
  const [result, setResult] = useState<RemoveLiquidityResult | null>(null);

  const removeLiquidity = useCallback(
    async ({
      lpAmount,
      minTokenAOut,
      minTokenBOut,
      tokenA,
      tokenB,
    }: {
      lpAmount: bigint;
      minTokenAOut: bigint;
      minTokenBOut: bigint;
      tokenA: string;
      tokenB: string;
    }) => {
      if (!poolAccountId || !accountId || !client || !connected) {
        setError('Client, account, or pool account not initialized');
        return;
      }

      setError('');
      setIsLoading(true);
      setTxId(undefined);
      setResult(null);

      try {
        console.log('🔄 Requesting withdrawal from daemon...');
        console.log('   Pool:', poolAccountId);
        console.log('   User:', accountId);
        console.log('   LP Amount:', lpAmount.toString());
        console.log('   Token A:', tokenA);
        console.log('   Token B:', tokenB);

        // Sync state first
        if (client) await client.syncState();

        // Call daemon /withdraw endpoint
        const response = await fetch(`${LIQUIDITY_DAEMON_URL}/withdraw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pool_account_id: poolAccountId,
            user_account_id: accountId,
            lp_amount: lpAmount.toString(),
            min_token_a_out: minTokenAOut.toString(),
            min_token_b_out: minTokenBOut.toString(),
            token_a: tokenA,
            token_b: tokenB,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Withdrawal failed: ${response.status} - ${errorText}`);
        }

        const withdrawResult = await response.json();
        console.log('✅ Withdraw response:', withdrawResult);

        if (!withdrawResult.success) {
          throw new Error(withdrawResult.error || 'Withdrawal failed');
        }

        const txIdStr = withdrawResult.tx_id || 'pending';
        setTxId(txIdStr);
        setResult({
          success: true,
          txId: txIdStr,
          tokenAOut: BigInt(withdrawResult.token_a_out || 0),
          tokenBOut: BigInt(withdrawResult.token_b_out || 0),
        });

        console.log('✅ Withdrawal completed successfully');
        console.log(`   Token A out: ${withdrawResult.token_a_out}`);
        console.log(`   Token B out: ${withdrawResult.token_b_out}`);

        return {
          txId: txIdStr,
          tokenAOut: BigInt(withdrawResult.token_a_out || 0),
          tokenBOut: BigInt(withdrawResult.token_b_out || 0),
        };
      } catch (err) {
        console.error('❌ Withdrawal error:', err);
        setError(err instanceof Error ? err.message : 'Failed to withdraw liquidity');
      } finally {
        setIsLoading(false);
      }
    },
    [client, accountId, poolAccountId, connected],
  );

  const value = useMemo(
    () => ({ removeLiquidity, isLoading, error, txId, result }),
    [removeLiquidity, error, isLoading, txId, result],
  );

  return value;
};
