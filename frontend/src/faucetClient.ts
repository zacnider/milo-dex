type PowChallenge = {
  challenge: string;
  target: number;
  timestamp: number;
};

type FaucetTokensResponse = {
  tx_id: string;
  note_id: string;
};

export interface FaucetNoteResponse {
  note_id: string;
  data_base64: string;
}

const hexToBytes = (hex: string) => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const u64ToBeBytes = (value: number) => {
  const bytes = new Uint8Array(8);
  let temp = value;
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }
  return bytes;
};

const bytesToBigIntBE = (bytes: Uint8Array) => {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) + BigInt(byte);
  }
  return result;
};

const hashMeetsTarget = async (challengeBytes: Uint8Array, nonce: number, target: number) => {
  const data = new Uint8Array(challengeBytes.length + 8);
  data.set(challengeBytes, 0);
  data.set(u64ToBeBytes(nonce), challengeBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const number = bytesToBigIntBE(hash.slice(0, 8));
  // Server uses target * 1000, so we need to match
  return number < BigInt(target * 1000);
};

export const requestPow = async (apiUrl: string, accountId: string, amount: string, tokenSymbol?: string) => {
  const params = new URLSearchParams({
    account_id: accountId,
    amount: amount,
  });
  if (tokenSymbol) params.set('token_symbol', tokenSymbol);
  const response = await fetch(`${apiUrl}/pow?${params.toString()}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Faucet /pow failed: ${response.status} - ${errorText}`);
  }
  return (await response.json()) as PowChallenge;
};

export const solvePow = async (challengeHex: string, target: number) => {
  // PoW disabled for testnet - return 0 as dummy nonce
  console.log(`⚙️ PoW disabled - using dummy nonce`);
  return 0;
};

export const requestTokens = async (params: {
  apiUrl: string;
  accountId: string;
  amount: string;
  isPrivate: boolean;
  tokenSymbol?: string;
}) => {
  console.log(`🎯 requestTokens started:`, params);
  console.log(`📡 Requesting PoW challenge from ${params.apiUrl}/pow...`);
  const challenge = await requestPow(params.apiUrl, params.accountId, params.amount, params.tokenSymbol);
  console.log(`✅ PoW challenge received:`, challenge);
  const nonce = await solvePow(challenge.challenge, challenge.target);
  const assetAmountStr = params.amount.toString();
  const assetAmountParsed = parseInt(assetAmountStr, 10);
  console.log(`📤 Faucet request: amount string="${assetAmountStr}", parsed=${assetAmountParsed}, type=${typeof assetAmountParsed}`);
  const queryParams: Record<string, string> = {
    account_id: params.accountId,
    is_private_note: String(params.isPrivate),
    asset_amount: String(assetAmountParsed),
    challenge: challenge.challenge,
    nonce: String(nonce),
  };
  if (params.tokenSymbol) queryParams.token_symbol = params.tokenSymbol;
  const query = new URLSearchParams(queryParams);
  const url = `${params.apiUrl}/get_tokens?${query.toString()}`;
  console.log('🌐 Requesting tokens from:', url);
  console.log('📋 Query params:', queryParams);
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Faucet /get_tokens error:', response.status, errorText);
    throw new Error(`Faucet /get_tokens failed: ${response.status} - ${errorText}`);
  }
  const result = (await response.json()) as FaucetTokensResponse;
  console.log('Faucet response:', result);
  return result;
};

/**
 * Gets a note from the faucet API by note ID.
 * @param apiUrl The base URL of the faucet API.
 * @param noteId The note ID to fetch.
 * @returns The note data as base64.
 */
export async function getNoteFromFaucet(
  apiUrl: string,
  noteId: string,
): Promise<FaucetNoteResponse> {
  const response = await fetch(`${apiUrl}/get_note?note_id=${encodeURIComponent(noteId)}`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Faucet /get_note failed: ${response.status} - ${errorText}`);
  }
  return (await response.json()) as FaucetNoteResponse;
}
