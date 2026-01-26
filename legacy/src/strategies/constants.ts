/**
 * Strategy configuration constants
 * Extracted to avoid magic numbers and improve maintainability
 */

/**
 * Position Tracker constants
 *
 * For HFT with many positions, we need fast refresh rates.
 * As you compound and scale up, position count grows exponentially.
 * The system must handle 100s of positions without bottlenecking.
 *
 * NOTE: This cache is for general position management (holdings, P&L display).
 * For TRADING DECISIONS, we fetch fresh orderbook data at execution time
 * (see useFreshOrderbook in scalp-trade.ts and fast-orderbook.util.ts).
 *
 * Environment variable: POSITION_TRACKER_REFRESH_MS (default: 5000)
 */
const parsePositionTrackerRefreshMs = (): number => {
  const envValue = process.env.POSITION_TRACKER_REFRESH_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= 1000) {
      return parsed;
    }
  }
  return 5000; // Default: 5 seconds
};
export const POSITION_TRACKER_REFRESH_INTERVAL_MS =
  parsePositionTrackerRefreshMs();

/**
 * Orchestrator constants
 *
 * Strategy execution must be fast to catch quick profit opportunities.
 * With many positions, we run strategies in PARALLEL not sequential.
 *
 * Environment variable: STRATEGY_EXECUTION_INTERVAL_MS (default: 2000)
 */
const parseStrategyExecutionIntervalMs = (): number => {
  const envValue = process.env.STRATEGY_EXECUTION_INTERVAL_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= 500) {
      return parsed;
    }
  }
  return 2000; // Default: 2 seconds
};
export const STRATEGY_EXECUTION_INTERVAL_MS =
  parseStrategyExecutionIntervalMs();

/**
 * Auto-Redeem check interval
 *
 * How often the auto-redeem strategy checks for redeemable positions.
 * Auto-redeem runs as part of the strategy orchestrator loop (every 2 seconds),
 * but internally throttles to this interval to avoid excessive blockchain calls.
 *
 * Default: 30 seconds (30000ms)
 * - Positions are checked against the position tracker which refreshes every 5 seconds
 * - Actual redemption requires blockchain transaction, so more frequent checks waste gas estimation
 * - 30 seconds is a reasonable balance between responsiveness and efficiency
 *
 * Can be overridden via AUTO_REDEEM_CHECK_INTERVAL_MS environment variable.
 */
export const AUTO_REDEEM_CHECK_INTERVAL_MS = 30000; // 30 seconds default

/**
 * Parallel execution settings
 * As positions scale, we need more concurrency
 */
export const MAX_PARALLEL_POSITION_CHECKS = 50; // Check up to 50 positions in parallel
export const MAX_PARALLEL_SELLS = 10; // Execute up to 10 sells in parallel

// Endgame Sweep constants
export const MAX_LIQUIDITY_USAGE_PCT = 0.1; // Use max 10% of available liquidity

/**
 * Fee constants (Polymarket trading fees as of 2024-2025)
 * @see https://docs.polymarket.com/polymarket-learn/trading/fees
 *
 * - Taker Fee: 0.01% (1 basis point) - paid when your order is immediately matched
 * - Maker Fee: 0% - paid when your limit order rests on the book
 *
 * For HFT scalping (taking liquidity), round-trip cost is only 0.02%!
 * This means even tiny edges of 0.1% are profitable.
 */
export const POLYMARKET_TAKER_FEE_BPS = 1; // 0.01% per trade (1 basis point)
export const POLYMARKET_MAKER_FEE_BPS = 0; // 0% for maker orders
export const POLYMARKET_FEE_BPS = 1; // Default to taker fee for conservative calculations
export const POLYMARKET_ROUND_TRIP_FEE_PCT = 0.02; // 0.02% total for buy + sell as taker (0.01% each)

/**
 * Default sell slippage tolerance percentage.
 *
 * This is the percentage below the current best bid price that we're willing
 * to accept when selling a position. This accounts for:
 * - Bid/ask spread volatility
 * - Order execution delays
 * - Market microstructure noise
 *
 * CRITICAL: Without slippage tolerance, sell orders will fail if the best bid
 * is even 1 cent below the target price, causing missed profitable exits.
 *
 * A 2% slippage on a highly profitable trade (e.g., +42% gain) is acceptable
 * to ensure the trade executes rather than missing the opportunity entirely.
 *
 * SLIPPAGE TIERS (from tightest to most liberal):
 * - Normal profit-taking: 2% (default - balance execution vs value)
 * - Stale position cleanup: 3% (slightly looser to protect small profits)
 * - Urgent exits: 10% (accept reasonable price to exit quickly)
 * - Falling knife exits: 25% (liberal slippage for rapidly declining positions)
 * - Emergency exits: 50% (very liberal - "beggars can't be choosers")
 *
 * For stop-loss and liquidation scenarios, use FALLING_KNIFE_SLIPPAGE_PCT
 * or EMERGENCY_SELL_SLIPPAGE_PCT to ensure positions can be exited even
 * in volatile, rapidly declining markets.
 *
 * Can be overridden via environment variable SELL_SLIPPAGE_PCT
 */
export const DEFAULT_SELL_SLIPPAGE_PCT = 2; // 2% default slippage tolerance for sells

/**
 * Stale position sell slippage tolerance percentage.
 *
 * Used when selling positions that have been held for a long time
 * and we want to exit but don't need to rush. Slightly looser than
 * the default to ensure fills while still protecting small profits.
 */
export const STALE_SELL_SLIPPAGE_PCT = 3; // 3% for stale position cleanup

/**
 * Urgent sell slippage tolerance percentage.
 *
 * Used for near-resolution sells or other time-sensitive exits
 * where getting out quickly matters more than optimal price.
 */
export const URGENT_SELL_SLIPPAGE_PCT = 10; // 10% for time-sensitive exits

/**
 * Falling knife slippage tolerance percentage.
 *
 * Used when a position is rapidly losing value and we need to exit
 * to salvage whatever capital remains. This is more liberal than
 * urgent sells because on a downslide, the 10% tolerance may be
 * too tight to actually capture a sell.
 *
 * "Beggars can't be choosers" - getting back 75% of current value
 * is better than watching it fall to zero while waiting for a
 * better price that may never come.
 *
 * Use cases:
 * - Stop-loss triggers where price is actively declining
 * - Smart hedging liquidations after hedge fails
 * - Any scenario where the position is "falling knife" territory
 */
export const FALLING_KNIFE_SLIPPAGE_PCT = 25; // 25% for rapidly declining positions

/**
 * Emergency sell slippage tolerance percentage.
 *
 * The most liberal slippage setting short of "accept any price".
 * Used for worst-case scenarios where we absolutely must exit
 * and salvage whatever we can. At 50% slippage, we're saying
 * "I'll accept half the current bid price just to get out."
 *
 * This replaces the hardcoded 1¢ minimum in most scenarios,
 * providing a more graceful degradation that still recovers
 * meaningful value from the position.
 *
 * Example: At a 50¢ bid, 50% slippage accepts down to 25¢.
 * This is much better than the old 1¢ floor while still
 * being aggressive enough to fill in any market conditions.
 */
export const EMERGENCY_SELL_SLIPPAGE_PCT = 50; // 50% for emergency exits

/**
 * Helper function to calculate minimum acceptable price with slippage tolerance.
 *
 * This function is used to determine the floor price when selling a position,
 * allowing for small price movements between when the decision to sell is made
 * and when the order is actually executed.
 *
 * @param referencePrice The reference price to apply slippage to (in dollars [0, 1]).
 *   This can be the target price, current bid, or any price used as a baseline.
 *   Different strategies use different reference prices:
 *   - scalp-trade.ts: effectiveLimitPrice (target price)
 *   - auto-sell.ts: position.currentBidPrice (cached bid)
 *   - smart-hedging.ts: fresh bidPrice from orderbook
 * @param slippagePct The slippage tolerance percentage (default: DEFAULT_SELL_SLIPPAGE_PCT).
 *   Must be between 0 and 100.
 * @returns The minimum acceptable price (referencePrice * (1 - slippagePct/100))
 * @throws Error if slippagePct is outside the valid range [0, 100]
 */
export function calculateMinAcceptablePrice(
  referencePrice: number,
  slippagePct: number = DEFAULT_SELL_SLIPPAGE_PCT,
): number {
  if (slippagePct < 0 || slippagePct > 100) {
    throw new Error(
      `Invalid slippage percentage: ${slippagePct}. Must be between 0 and 100.`,
    );
  }
  return referencePrice * (1 - slippagePct / 100);
}

/**
 * Divisor for converting basis points to decimal (10000 BPS = 100%)
 */
export const BASIS_POINTS_DIVISOR = 10000;

/**
 * Calculate net profit after fees
 * @param grossProfitPct Gross profit percentage
 * @returns Net profit percentage after round-trip fees
 */
export function calculateNetProfit(grossProfitPct: number): number {
  return grossProfitPct - POLYMARKET_ROUND_TRIP_FEE_PCT;
}

/**
 * Check if a trade is profitable after fees
 * For HFT scalping with 0.02% round-trip fees, even small edges are profitable
 * @param grossProfitPct Gross profit percentage
 * @param minNetProfitPct Minimum acceptable net profit (default 0.1% for scalping)
 * @returns true if trade is profitable after fees
 */
export function isProfitableAfterFees(
  grossProfitPct: number,
  minNetProfitPct: number = 0.1,
): boolean {
  return calculateNetProfit(grossProfitPct) >= minNetProfitPct;
}

/**
 * Minimum profit thresholds for scalping
 *
 * IMPORTANT: Small profits are NOT worth the effort and risk.
 * Every trade has overhead: transaction fees, slippage risk, time.
 * Aim for at least $1 profit per trade to make it worthwhile.
 *
 * Examples on a $10 position:
 * - 10% gain = $1.00 profit (minimum acceptable)
 * - 15% gain = $1.50 profit (good)
 * - 25% gain = $2.50 profit (excellent)
 *
 * These thresholds ensure that trades generate meaningful profits.
 */

/**
 * Minimum absolute profit in USD for quick-flip sells
 * Trades below this profit threshold will be held longer
 * Default: $1.00 minimum profit per trade - anything less isn't worth it
 */
export const MIN_QUICK_FLIP_PROFIT_USD = 1.0;

/**
 * Default minimum profit percentage for quick-flip
 * 10% minimum to ensure meaningful dollar profits
 */
export const DEFAULT_QUICK_FLIP_TARGET_PCT = 10;

/**
 * Check if a trade meets minimum profit requirements
 * Both percentage AND absolute USD profit must be met
 *
 * NOTE: This function is provided for external use cases. The quick-flip strategy
 * uses position.pnlUsd directly from the position tracker for more accurate calculations.
 *
 * @param positionCostUsd Original position cost (size * entryPrice), NOT current market value
 * @param profitPct Profit percentage (gross)
 * @param minProfitPct Minimum profit percentage required
 * @param minProfitUsd Minimum absolute profit in USD required
 * @returns true if trade meets all profit requirements
 */
export function meetsMinProfitRequirements(
  positionCostUsd: number,
  profitPct: number,
  minProfitPct: number = DEFAULT_QUICK_FLIP_TARGET_PCT,
  minProfitUsd: number = MIN_QUICK_FLIP_PROFIT_USD,
): boolean {
  // Check percentage requirement
  if (profitPct < minProfitPct) {
    return false;
  }

  // Calculate absolute profit based on original investment
  const absoluteProfitUsd = (profitPct / 100) * positionCostUsd;

  // Check absolute profit requirement
  return absoluteProfitUsd >= minProfitUsd;
}
