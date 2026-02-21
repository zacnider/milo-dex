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

export interface P2IDSwapParams {
  poolAccountIdHex: string;
  buyToken: { faucetId: AccountId | string; decimals: number };
  sellToken: { faucetId: AccountId | string; decimals: number };
  amount: bigint;
  minAmountOut: bigint;
  userAccountId: AccountId;
  client: WebClient;
  noteType?: NoteType;
}

export interface P2IDSwapResult {
  readonly tx: any; // CustomTransaction
  readonly transactionRequest: any;
  readonly noteId: string;
  readonly swapInfo: SwapNoteInfo;
}

export interface SwapNoteInfo {
  noteId: string;
  poolAccountId: string;
  sellTokenId: string;
  buyTokenId: string;
  amountIn: string;
  minAmountOut: string;
  userAccountId: string;
  timestamp: number;
}

// Helper function to convert faucetId to AccountId object safely
function faucetIdToAccountId(faucetId: AccountId | string): AccountId {
  if (typeof faucetId === 'string') {
    return AccountId.fromHex(faucetId);
  }
  return faucetId;
}

// Helper function to convert faucetId to hex string safely
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
 * Create a P2ID swap transaction using the simplified P2ID pattern
 *
 * This approach:
 * 1. Creates a simple P2ID note sending tokens to the pool
 * 2. Stores swap parameters for daemon to use
 * 3. Daemon consumes note and executes swap logic in Rust
 * 4. Daemon creates P2ID note back to user with swapped tokens
 */
export async function createP2IDSwapTransaction({
  poolAccountIdHex,
  buyToken,
  sellToken,
  amount,
  minAmountOut,
  userAccountId,
  client,
  noteType,
}: P2IDSwapParams): Promise<P2IDSwapResult> {
  // Sync state first
  await client.syncState();

  // Create poolAccountId from hex AFTER syncState
  const poolAccountId = AccountId.fromHex(poolAccountIdHex);

  // Convert faucetIds to AccountId objects
  const buyTokenAccountId = faucetIdToAccountId(buyToken.faucetId);
  const sellTokenAccountId = faucetIdToAccountId(sellToken.faucetId);

  // Create asset to send to pool
  const offeredAsset = new FungibleAsset(sellTokenAccountId, amount);

  console.log('🔍 Creating P2ID swap note:', {
    pool: poolAccountIdHex,
    sellToken: faucetIdToHex(sellToken.faucetId),
    buyToken: faucetIdToHex(buyToken.faucetId),
    amount: amount.toString(),
    minAmountOut: minAmountOut.toString(),
  });

  // Create P2ID note sending tokens to pool
  // Note: We use aux field to encode minimal swap info
  // Format: aux = 0 (simple transfer - swap params stored separately)
  const note = Note.createP2IDNote(
    userAccountId,
    poolAccountId,
    new NoteAssets([offeredAsset]),
    noteType ?? NoteType.Public,
    new NoteAttachment(), // empty attachment
  );

  const noteId = note.id().toString();

  console.log('✅ P2ID swap note created:', noteId);

  // Build transaction request
  const transactionRequest = new TransactionRequestBuilder()
    .withOwnOutputNotes(new MidenArrays.OutputNoteArray([OutputNote.full(note)]))
    .build();

  // Create CustomTransaction for Extension Wallet
  const userAddress = userAccountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet).split('_')[0];
  const poolAddress = poolAccountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet).split('_')[0];

  const tx = new CustomTransaction(
    userAddress,
    poolAddress,
    transactionRequest,
    [],
    [],
  );

  // Prepare swap info for daemon
  const swapInfo: SwapNoteInfo = {
    noteId,
    poolAccountId: poolAccountIdHex,
    sellTokenId: faucetIdToHex(sellToken.faucetId),
    buyTokenId: faucetIdToHex(buyToken.faucetId),
    amountIn: amount.toString(),
    minAmountOut: minAmountOut.toString(),
    userAccountId: userAccountId.toString(),
    timestamp: Date.now(),
  };

  console.log('📋 Swap info prepared:', swapInfo);

  return {
    tx,
    transactionRequest,
    noteId,
    swapInfo,
  };
}

/**
 * Store swap info for daemon to use when consuming note
 */
export function storeSwapInfo(swapInfo: SwapNoteInfo): void {
  try {
    const existing = localStorage.getItem('p2id_swap_notes');
    const swapsList = existing ? JSON.parse(existing) : [];
    swapsList.push(swapInfo);
    localStorage.setItem('p2id_swap_notes', JSON.stringify(swapsList));
    console.log('💾 Stored P2ID swap info:', swapInfo.noteId);
  } catch (e) {
    console.warn('⚠️ Failed to store swap info:', e);
  }
}

/**
 * Get swap info by note ID
 */
export function getSwapInfo(noteId: string): SwapNoteInfo | null {
  try {
    const existing = localStorage.getItem('p2id_swap_notes');
    if (!existing) return null;

    const swapsList = JSON.parse(existing) as SwapNoteInfo[];
    return swapsList.find(s => s.noteId === noteId) || null;
  } catch (e) {
    console.warn('⚠️ Failed to get swap info:', e);
    return null;
  }
}

/**
 * Clear old swap info (older than 24 hours)
 */
export function clearOldSwapInfo(): void {
  try {
    const existing = localStorage.getItem('p2id_swap_notes');
    if (!existing) return;

    const swapsList = JSON.parse(existing) as SwapNoteInfo[];
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const filtered = swapsList.filter(s => s.timestamp > oneDayAgo);

    localStorage.setItem('p2id_swap_notes', JSON.stringify(filtered));
    console.log(`🧹 Cleaned up ${swapsList.length - filtered.length} old swap info entries`);
  } catch (e) {
    console.warn('⚠️ Failed to clear old swap info:', e);
  }
}
