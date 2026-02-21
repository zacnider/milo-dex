// Auto-generated pool configuration
// Generated from add_liquidity execution

export interface PoolInfo {
  id: string;
  address: string;
  name: string;
  tokens: [string, string];
}

export const POOL_CONFIG: PoolInfo[] = [
  {
    id: '0x6b10bd738877ea101db7175839e152',
    address: 'mtst1ap43p0tn3pm75yqakut4sw0p2ga9dxsz',
    name: 'MILO/USDC',
    tokens: ['MILO', 'MUSDC'],
  },
  {
    id: '0x563a995fec149d105728eaa1bd4332',
    address: 'mtst1aptr4x2las2f6yzh9r42r02rxgdu6r79',
    name: 'MELO/USDC',
    tokens: ['MELO', 'MUSDC'],
  },
];

// Helper to get pool by ID
export function getPoolById(poolId: string): PoolInfo | undefined {
  return POOL_CONFIG.find(p => p.id.toLowerCase() === poolId.toLowerCase());
}

// Helper to get pool by token pair
export function getPoolByTokens(tokenA: string, tokenB: string): PoolInfo | undefined {
  const normalizedA = tokenA.toUpperCase();
  const normalizedB = tokenB.toUpperCase();
  return POOL_CONFIG.find(p => 
    (p.tokens[0] === normalizedA && p.tokens[1] === normalizedB) ||
    (p.tokens[0] === normalizedB && p.tokens[1] === normalizedA)
  );
}
