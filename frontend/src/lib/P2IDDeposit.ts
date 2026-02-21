import {
  AccountId,
  AccountInterface,
  FungibleAsset,
  NetworkId,
  Note,
  NoteAssets,
  NoteAttachment,
  NoteType,
  TransactionRequestBuilder,
  OutputNote,
  MidenArrays,
  WebClient,
} from '@miden-sdk/miden-sdk';
import { CustomTransaction } from '@miden-sdk/miden-wallet-adapter';
import { Buffer } from 'buffer';

window.Buffer = Buffer;

export interface P2IDDepositParams {
  poolAccountIdHex: string;
  tokenFaucetId: AccountId | string;
  amount: bigint;
  minLpAmountOut: bigint;
  userAccountId: AccountId;
  client: WebClient;
  noteType?: NoteType;
}

export interface P2IDDepositResult {
  readonly tx: any;
  readonly transactionRequest: any;
  readonly noteId: string;
  readonly depositInfo: DepositNoteInfo;
}

export interface DepositNoteInfo {
  noteId: string;
  poolAccountId: string;
  tokenId: string;
  amount: string;
  userAccountId: string;
  minLpAmountOut: string;
  timestamp: number;
}

function faucetIdToAccountId(faucetId: AccountId | string): AccountId {
  if (typeof faucetId === 'string') {
    return AccountId.fromHex(faucetId);
  }
  return faucetId;
}

function faucetIdToHex(faucetId: AccountId | string): string {
  if (typeof faucetId === 'string') {
    return faucetId;
  }
  if (faucetId && typeof faucetId === 'object') {
    if (typeof faucetId.toString === 'function') {
      return faucetId.toString();
    }
  }
  return String(faucetId);
}

/**
 * Create a P2ID deposit transaction using the simplified P2ID pattern.
 *
 * This approach:
 * 1. Creates a simple P2ID note sending tokens to the pool
 * 2. Stores deposit parameters for daemon to use
 * 3. Daemon consumes the P2ID note (pool receives tokens)
 */
export async function createP2IDDepositTransaction({
  poolAccountIdHex,
  tokenFaucetId,
  amount,
  minLpAmountOut,
  userAccountId,
  client,
  noteType,
}: P2IDDepositParams): Promise<P2IDDepositResult> {
  await client.syncState();

  const poolAccountId = AccountId.fromHex(poolAccountIdHex);
  const tokenAccountId = faucetIdToAccountId(tokenFaucetId);

  const offeredAsset = new FungibleAsset(tokenAccountId, amount);

  console.log('🔍 Creating P2ID deposit note:', {
    pool: poolAccountIdHex,
    token: faucetIdToHex(tokenFaucetId),
    amount: amount.toString(),
    minLpAmountOut: minLpAmountOut.toString(),
  });

  const note = Note.createP2IDNote(
    userAccountId,
    poolAccountId,
    new NoteAssets([offeredAsset]),
    noteType ?? NoteType.Public,
    new NoteAttachment(), // empty attachment
  );

  const noteId = note.id().toString();
  console.log('✅ P2ID deposit note created:', noteId);

  const transactionRequest = new TransactionRequestBuilder()
    .withOwnOutputNotes(new MidenArrays.OutputNoteArray([OutputNote.full(note)]))
    .build();

  const userAddress = userAccountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet).split('_')[0];
  const poolAddress = poolAccountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet).split('_')[0];

  const tx = new CustomTransaction(
    userAddress,
    poolAddress,
    transactionRequest,
    [],
    [],
  );

  const depositInfo: DepositNoteInfo = {
    noteId,
    poolAccountId: poolAccountIdHex,
    tokenId: faucetIdToHex(tokenFaucetId),
    amount: amount.toString(),
    userAccountId: userAccountId.toString(),
    minLpAmountOut: minLpAmountOut.toString(),
    timestamp: Date.now(),
  };

  console.log('📋 Deposit info prepared:', depositInfo);

  return {
    tx,
    transactionRequest,
    noteId,
    depositInfo,
  };
}

export function storeDepositInfo(depositInfo: DepositNoteInfo): void {
  try {
    const existing = localStorage.getItem('p2id_deposit_notes');
    const list = existing ? JSON.parse(existing) : [];
    list.push(depositInfo);
    localStorage.setItem('p2id_deposit_notes', JSON.stringify(list));
    console.log('💾 Stored P2ID deposit info:', depositInfo.noteId);
  } catch (e) {
    console.warn('⚠️ Failed to store deposit info:', e);
  }
}

export function getDepositInfo(noteId: string): DepositNoteInfo | null {
  try {
    const existing = localStorage.getItem('p2id_deposit_notes');
    if (!existing) return null;
    const list = JSON.parse(existing) as DepositNoteInfo[];
    return list.find(d => d.noteId === noteId) || null;
  } catch (e) {
    console.warn('⚠️ Failed to get deposit info:', e);
    return null;
  }
}

export function clearOldDepositInfo(): void {
  try {
    const existing = localStorage.getItem('p2id_deposit_notes');
    if (!existing) return;
    const list = JSON.parse(existing) as DepositNoteInfo[];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = list.filter(d => d.timestamp > oneDayAgo);
    localStorage.setItem('p2id_deposit_notes', JSON.stringify(filtered));
    console.log(`🧹 Cleaned up ${list.length - filtered.length} old deposit info entries`);
  } catch (e) {
    console.warn('⚠️ Failed to clear old deposit info:', e);
  }
}
