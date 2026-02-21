/**
 * LP Token Calculator
 *
 * This module provides functions to calculate LP token amounts for liquidity provision.
 * Following the standard AMM (Automated Market Maker) formula.
 */

export interface PoolState {
  /** Total liabilities (total LP tokens supply * price) */
  liabilities: bigint;
  /** Actual reserve of tokens in pool */
  reserve: bigint;
  /** Reserve with slippage protection */
  reserveWithSlippage: bigint;
  /** Total LP tokens issued */
  totalLPSupply: bigint;
}

/**
 * Calculate LP tokens to mint for a deposit
 *
 * Formula:
 * - If pool is empty (totalLPSupply == 0): LP_amount = deposit_amount
 * - If pool has liquidity: LP_amount = (deposit_amount * totalLPSupply) / liabilities
 *
 * @param depositAmount - Amount of tokens being deposited (in base units, e.g., 100_000_000 for 1 token with 8 decimals)
 * @param poolState - Current state of the pool
 * @returns LP token amount to mint
 */
export function calculateLPTokensForDeposit(
  depositAmount: bigint,
  poolState: PoolState
): bigint {
  // First liquidity provision
  if (poolState.totalLPSupply === BigInt(0)) {
    // For first liquidity, LP tokens = deposit amount (1:1 ratio)
    return depositAmount;
  }

  // Subsequent liquidity provisions
  // LP_amount = (deposit_amount * total_LP_supply) / liabilities
  const lpAmount = (depositAmount * poolState.totalLPSupply) / poolState.liabilities;

  return lpAmount;
}

/**
 * Calculate minimum LP tokens with slippage protection
 *
 * @param expectedLPAmount - Expected LP token amount
 * @param slippagePercent - Slippage tolerance percentage (e.g., 5 for 5%)
 * @returns Minimum LP tokens acceptable
 */
export function calculateMinLPWithSlippage(
  expectedLPAmount: bigint,
  slippagePercent: number = 5
): bigint {
  const slippageBps = BigInt(Math.floor(slippagePercent * 100)); // Convert to basis points
  const minLP = (expectedLPAmount * (BigInt(10000) - slippageBps)) / BigInt(10000);
  return minLP;
}

/**
 * Calculate token amount for given LP tokens (for withdrawal)
 *
 * Formula: token_amount = (lp_amount * liabilities) / totalLPSupply
 *
 * @param lpAmount - Amount of LP tokens to burn
 * @param poolState - Current state of the pool
 * @returns Token amount to withdraw
 */
export function calculateTokensForLPWithdraw(
  lpAmount: bigint,
  poolState: PoolState
): bigint {
  if (poolState.totalLPSupply === BigInt(0)) {
    return BigInt(0);
  }

  const tokenAmount = (lpAmount * poolState.liabilities) / poolState.totalLPSupply;
  return tokenAmount;
}

/**
 * Validate LP calculation
 *
 * Ensures calculated LP amount is reasonable compared to deposit
 *
 * @param depositAmount - Deposit amount
 * @param calculatedLP - Calculated LP amount
 * @param poolState - Pool state
 * @returns true if validation passes
 */
export function validateLPCalculation(
  depositAmount: bigint,
  calculatedLP: bigint,
  poolState: PoolState
): boolean {
  // For first liquidity, LP should equal deposit
  if (poolState.totalLPSupply === BigInt(0)) {
    return calculatedLP === depositAmount;
  }

  // For subsequent liquidity, LP should be proportional
  // Allow 1% deviation for rounding errors
  const expectedLP = calculateLPTokensForDeposit(depositAmount, poolState);
  const deviation = expectedLP > calculatedLP
    ? expectedLP - calculatedLP
    : calculatedLP - expectedLP;

  const maxDeviation = expectedLP / BigInt(100); // 1% tolerance
  return deviation <= maxDeviation;
}

/**
 * Format LP amount for display
 *
 * @param lpAmount - LP amount in base units
 * @param decimals - Token decimals (default 8)
 * @returns Formatted string
 */
export function formatLPAmount(lpAmount: bigint, decimals: number = 8): string {
  if (decimals === 0) return lpAmount.toString();
  const divisor = BigInt(10 ** decimals);
  const whole = lpAmount / divisor;
  const fraction = lpAmount % divisor;

  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractionStr ? `${whole}.${fractionStr}` : whole.toString();
}
