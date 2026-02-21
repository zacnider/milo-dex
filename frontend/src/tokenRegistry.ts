// Auto-generated token registry - Updated with real faucet IDs
// Generated from setup_milo execution
import { FAUCET_URL } from './config/api';

export interface TokenInfo {
  symbol: string;
  name: string;
  faucetId: string;
  decimals: number;
  logo: string;
  color: string;
  faucetApiUrl?: string;
  legacyFaucetIds?: string[];
}

// Runtime getter to prevent Rollup from inlining the URL at build time
function getFaucetUrl(): string {
  return FAUCET_URL;
}

export const CONFIG: { apiUrl: string; faucetServerUrl: string; userWalletId: string; userWalletAddress: string; tokens: Record<string, TokenInfo> } = {
  get apiUrl() { return getFaucetUrl(); },
  get faucetServerUrl() { return getFaucetUrl(); },
  userWalletId: '0x9e96e636738fc9104ed2b971931cc7',
  userWalletAddress: 'mtst1az0fde3kww8ujyzw62uhrycucup8zpqg',
  tokens: {
    MILO: {
      symbol: 'MILO',
      name: 'Milo Token',
      faucetId: '0x6c9dc9f00ccc7e2005a83d7aa307db',
      decimals: 8,
      logo: '/tokens/milo.svg',
      color: '#6366f1',
      get faucetApiUrl() { return getFaucetUrl(); },
    },
    MELO: {
      symbol: 'MELO',
      name: 'Melo Token',
      faucetId: '0xbde6a12c78fab7205b85d43e59ac81',
      decimals: 8,
      logo: '/tokens/melo.svg',
      color: '#10b981',
      get faucetApiUrl() { return getFaucetUrl(); },
    },
    MUSDC: {
      symbol: 'MUSDC',
      name: 'Milo USDC',
      faucetId: '0x5f97ba94b0d6912053db274d357659',
      decimals: 8,
      logo: '/tokens/usdc.svg',
      color: '#2563eb',
      get faucetApiUrl() { return getFaucetUrl(); },
    },
    MIDEN: {
      symbol: 'MIDEN',
      name: 'Miden Network',
      faucetId: '0x37d5977a8e16d8205a360820f0230f',
      decimals: 6,
      logo: '/tokens/miden.svg',
      color: '#ff6b35',
    },
  },
};

export const TOKEN_LIST = Object.values(CONFIG.tokens);
export const TOKEN_SYMBOLS = TOKEN_LIST.map((t) => t.symbol);

// Helper function to get token metadata by faucet ID
export function getTokenMetadata(faucetId: string): { symbol: string; decimals: number } | undefined {
  const normalizedFaucetId = faucetId.toLowerCase().replace(/^0x/, '');
  for (const token of TOKEN_LIST) {
    const tokenFaucetId = token.faucetId.toLowerCase().replace(/^0x/, '');
    if (tokenFaucetId === normalizedFaucetId) {
      return { symbol: token.symbol, decimals: token.decimals };
    }
  }
  return undefined;
}

// Helper function to get token by symbol
export function getTokenBySymbol(symbol: string) {
  const upperSymbol = symbol.toUpperCase();
  return TOKEN_LIST.find(t => t.symbol.toUpperCase() === upperSymbol);
}
