import { useCallback, useMemo, useState } from 'react';
import { useWallet } from '@miden-sdk/miden-wallet-adapter';
import { AccountId } from '@miden-sdk/miden-sdk';
import { TransactionType } from '@miden-sdk/miden-wallet-adapter';
import { LIQUIDITY_DAEMON_URL } from '../config/api';
import { getTokenBySymbol } from '../tokenRegistry';
import {
  createP2IDDepositTransaction,
  storeDepositInfo,
  clearOldDepositInfo,
} from '../lib/P2IDDeposit';

export interface LiquidityResult {
  readonly txId: string;
  readonly noteId: string;
}

interface UseLiquidityProps {
  client: any;
  accountId: string | null;
  poolAccountId?: string | AccountId | null;
}

export const useLiquidity = ({
  client,
  accountId,
  poolAccountId = '0xd3a3155904e59110238ef63a97a233',
}: UseLiquidityProps) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>();
  const { requestTransaction } = useWallet();
  const [txId, setTxId] = useState<undefined | string>();
  const [noteId, setNoteId] = useState<undefined | string>();

  const addLiquidity = useCallback(
    async ({
      token,
      amount,
      minLpAmountOut,
    }: {
      token: string;
      amount: bigint;
      minLpAmountOut: bigint;
    }) => {
      if (!poolAccountId || !accountId || !client || !requestTransaction) {
        setError('Client, account, or pool account not initialized');
        return;
      }

      const poolAccountIdHex = typeof poolAccountId === 'string'
        ? poolAccountId
        : poolAccountId.toString();

      console.log('🔍 Debug: useLiquidity params:', {
        accountId,
        poolAccountId: poolAccountIdHex,
        token,
        amount: amount.toString(),
      });

      setError('');
      setIsLoading(true);
      setTxId(undefined);
      setNoteId(undefined);

      try {
        const userAccountId = AccountId.fromHex(accountId);

        const tokenMeta = getTokenBySymbol(token);
        if (!tokenMeta) {
          throw new Error(`Token ${token} not found in registry`);
        }

        // Clear old deposit info
        clearOldDepositInfo();

        // Create P2ID deposit transaction (no custom MASM compilation needed)
        const { tx, noteId: createdNoteId, depositInfo } = await createP2IDDepositTransaction({
          poolAccountIdHex,
          tokenFaucetId: tokenMeta.faucetId,
          amount,
          minLpAmountOut,
          userAccountId,
          client,
        });

        // Store deposit info for daemon
        storeDepositInfo(depositInfo);

        // Submit via Extension Wallet
        console.log('📤 Submitting P2ID deposit via wallet extension...');
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

        console.log('✅ P2ID deposit transaction submitted:', txIdStr);
        console.log('📋 Note ID:', createdNoteId);

        // Notify daemon about new P2ID deposit note
        try {
          console.log('🔔 Notifying daemon about P2ID deposit note...');
          await fetch(`${LIQUIDITY_DAEMON_URL}/track_note`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              note_id: createdNoteId,
              note_type: 'P2ID_DEPOSIT',
              pool_account_id: poolAccountIdHex,
              deposit_info: depositInfo,
            }),
          });
          console.log('✅ Daemon notified');
        } catch (e) {
          console.warn('⚠️ Failed to notify daemon:', e);
        }

        // Wait for transaction to propagate
        console.log('⏳ Waiting for transaction to propagate (30s)...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Trigger daemon to consume the deposit note
        try {
          console.log('🔔 Triggering daemon to process P2ID deposit...');
          const response = await fetch(`${LIQUIDITY_DAEMON_URL}/consume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pool_account_id: poolAccountIdHex,
            }),
          });

          if (response.ok) {
            const result = await response.json();
            console.log('✅ Daemon response:', result);
            if (result.consumed > 0) {
              console.log(`✅ Daemon consumed ${result.consumed} deposit note(s)`);
            } else {
              console.log('ℹ️ No deposits processed yet (may need more time)');
            }
          } else {
            const errorText = await response.text();
            console.warn('⚠️ Daemon request failed:', response.status, errorText);
          }
        } catch (err: any) {
          console.warn('⚠️ Failed to trigger daemon:', err.message);
        }

        setNoteId(createdNoteId);
        setTxId(txIdStr);

        console.log('✅ P2ID deposit process completed');
      } catch (err) {
        console.error('❌ P2ID deposit error:', err);
        setError(err instanceof Error ? err.message : 'Failed to execute P2ID deposit');
      } finally {
        setIsLoading(false);
      }
    },
    [client, accountId, poolAccountId, requestTransaction],
  );

  const consumeDepositNotes = useCallback(
    async (poolAccountIdHex: string) => {
      if (!client || !accountId) {
        setError('Client or account not initialized');
        return;
      }

      setError('');
      setIsLoading(true);

      try {
        console.log('🔄 Triggering consume for pool:', poolAccountIdHex);

        const response = await fetch(`${LIQUIDITY_DAEMON_URL}/consume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pool_account_id: poolAccountIdHex,
          }),
        });

        if (response.ok) {
          const result = await response.json();
          console.log('✅ Consume result:', result);
        } else {
          const errorText = await response.text();
          console.warn('⚠️ Consume failed:', response.status, errorText);
        }

        // Wait for state to settle
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (client) await client.syncState();
      } catch (err) {
        console.error('❌ Error consuming deposit notes:', err);
        setError(err instanceof Error ? err.message : 'Unknown error');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [client, accountId],
  );

  const value = useMemo(
    () => ({ addLiquidity, consumeDepositNotes, isLoading, error, txId, noteId }),
    [addLiquidity, consumeDepositNotes, error, isLoading, txId, noteId],
  );

  return value;
};
