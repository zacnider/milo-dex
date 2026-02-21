import {
  AccountId,
  FungibleAsset,
  Note,
  NoteAssets,
  NoteInputs,
  NoteMetadata,
  NoteRecipient,
  NoteTag,
  NoteType,
  TransactionRequestBuilder,
  Felt,
  FeltArray,
  OutputNote,
  MidenArrays,
  Word,
  AccountInterface,
  NetworkId,
  WebClient,
} from '@miden-sdk/miden-sdk';
import { CustomTransaction } from '@miden-sdk/miden-wallet-adapter';
import { Buffer } from 'buffer';

window.Buffer = Buffer;

export interface SwapParams {
  poolAccountIdHex: string; // Hex string, will be converted to AccountId inside
  buyToken: { faucetId: AccountId | string; decimals: number }; // Accept hex string or AccountId
  sellToken: { faucetId: AccountId | string; decimals: number }; // Accept hex string or AccountId
  amount: bigint;
  minAmountOut: bigint;
  userAccountId: AccountId;
  client: WebClient;
  syncState?: () => Promise<void>; // Optional, will use client.syncState if not provided
}

export interface SwapResult {
  readonly tx: any; // CustomTransaction
  readonly transactionRequest: any; // TransactionRequest (before serialization)
  readonly noteId: string;
}

// Read SWAP.masm script
async function readSwapScript(): Promise<string> {
  const response = await fetch('/contracts/milo-pool/SWAP.masm');
  if (!response.ok) {
    throw new Error(`Failed to load SWAP.masm: ${response.statusText}`);
  }
  const text = await response.text();
  console.log('📄 Loaded SWAP.masm script, length:', text.length);
  return text;
}

// Read milo-pool.masm script
async function readPoolScript(): Promise<string> {
  const response = await fetch('/contracts/milo-pool/milo-pool.masm');
  if (!response.ok) {
    throw new Error(`Failed to load milo-pool.masm: ${response.statusText}`);
  }
  return await response.text();
}

// Helper function to convert AccountId to bech32
function accountIdToBech32(accountId: AccountId): string {
  return accountId.toBech32(NetworkId.testnet(), AccountInterface.BasicWallet).split('_')[0];
}

// Helper function to convert faucetId to AccountId object safely
function faucetIdToAccountId(faucetId: AccountId | string): AccountId {
  if (typeof faucetId === 'string') {
    return AccountId.fromHex(faucetId);
  }
  // Already an AccountId object
  return faucetId;
}

export async function compileSwapTransaction({
  poolAccountIdHex,
  buyToken,
  sellToken,
  amount,
  minAmountOut,
  userAccountId,
  client,
  syncState,
}: SwapParams): Promise<SwapResult> {
  // Use provided syncState or fallback to client.syncState
  const doSync = syncState || (() => client.syncState());
  await doSync();
  
  // Create poolAccountId from hex AFTER syncState (WASM module is ready)
  const poolAccountId = AccountId.fromHex(poolAccountIdHex);
  
  // Convert faucetIds to AccountId objects if they're hex strings
  const buyTokenAccountId = faucetIdToAccountId(buyToken.faucetId);
  const sellTokenAccountId = faucetIdToAccountId(sellToken.faucetId);
  
  const builder = client.createCodeBuilder();
  
  // Load and compile pool library
  const poolScript = await readPoolScript();
  const poolLib = builder.buildLibrary('milo::milo_pool', poolScript);
  builder.linkDynamicLibrary(poolLib);
  
  // Load and compile SWAP note script
  const swapScript = await readSwapScript();
  const noteScript = builder.compileNoteScript(swapScript);

  const noteType = NoteType.Public;
  const offeredAsset = new FungibleAsset(sellTokenAccountId, amount);

  // Note should only contain the offered asset
  const noteAssets = new NoteAssets([offeredAsset]);
  const noteTag = NoteTag.withAccountTarget(poolAccountId);
  
  // Debug: Log pool account ID and tag
  console.log('🔍 SwapNote - Pool account ID:', poolAccountIdHex);
  console.log('🔍 SwapNote - Pool account ID (bech32):', accountIdToBech32(poolAccountId));
  console.log('🔍 SwapNote - Note tag:', noteTag.asU32(), `(0x${noteTag.asU32().toString(16)})`);

  const metadata = new NoteMetadata(
    userAccountId,
    noteType,
    noteTag,
  );

  const deadline = Date.now() + 120_000; // 2 min from now

  // Use the AccountId for p2id tag
  const p2idTag = NoteTag.withAccountTarget(userAccountId).asU32();

  // Following the pattern: [min_amount_out, empty, out_asset_id_suffix, out_asset_id_prefix, deadline, p2id_tag, empty, empty, empty, empty, creator_id_suffix, creator_id_prefix]
  const inputs = new NoteInputs(
    new FeltArray([
      new Felt(minAmountOut),
      new Felt(BigInt(0)),
      buyTokenAccountId.suffix(),
      buyTokenAccountId.prefix(),
      new Felt(BigInt(deadline)),
      new Felt(BigInt(p2idTag)),
      new Felt(BigInt(0)),
      new Felt(BigInt(0)),
      new Felt(BigInt(0)),
      new Felt(BigInt(0)),
      userAccountId.suffix(),
      userAccountId.prefix(),
    ]),
  );

  const note = new Note(
    noteAssets,
    metadata,
    new NoteRecipient(generateRandomSerialNumber(), noteScript, inputs),
  );

  const noteId = note.id().toString();

  const transactionRequest = new TransactionRequestBuilder()
    .withOwnOutputNotes(new MidenArrays.OutputNoteArray([OutputNote.full(note)]))
    .build();

  // Convert account IDs to bech32 addresses
  // Note: toBech32 can only be called once per AccountId object due to WASM ownership
  const userAddress = accountIdToBech32(userAccountId);
  const poolAddress = accountIdToBech32(poolAccountId);

  // Use new CustomTransaction
  const tx = new CustomTransaction(
    userAddress,
    poolAddress,
    transactionRequest,
    [],
    [],
  );

  return {
    tx,
    transactionRequest, // Return the TransactionRequest object before serialization
    noteId,
  };
}

function generateRandomSerialNumber(): Word {
  // Generate random serial number as Word (4 Felts)
  return Word.newFromFelts([
    new Felt(BigInt(Math.floor(Math.random() * 0x1_0000_0000))),
    new Felt(BigInt(Math.floor(Math.random() * 0x1_0000_0000))),
    new Felt(BigInt(Math.floor(Math.random() * 0x1_0000_0000))),
    new Felt(BigInt(Math.floor(Math.random() * 0x1_0000_0000))),
  ]);
}
