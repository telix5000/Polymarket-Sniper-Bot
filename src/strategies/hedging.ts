/**
 * Hedging Strategy
 *
 * Instead of selling at a loss, buy the opposing outcome to guarantee profit.
 *
 * LOGIC:
 * 1. Find positions losing more than triggerLossPct
 * 2. If we can afford a hedge, BUY THE OPPOSITE SIDE
 * 3. If we can't hedge, SELL to stop bleeding
 *
 * That's it. No complex timing, no volume analysis, no elaborate calculations.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { postOrder } from "../utils/post-order.util";
import {
  LogDeduper,
  SkipReasonAggregator,
  TOKEN_ID_DISPLAY_LENGTH,
} from "../utils/log-deduper.util";
import { formatCents, assessOrderbookQuality } from "../utils/price.util";
import type { ReservePlan } from "../risk";
import {
  notifyHedge,
  notifyHedgeExit,
  notifySell,
} from "../services/trade-notification.service";
import {
  acquireHedgeLock,
  releaseHedgeLock,
} from "../utils/funds-allowance.util";
import { POLYMARKET_TAKER_FEE_BPS, BASIS_POINTS_DIVISOR, calculateMinAcceptablePrice, FALLING_KNIFE_SLIPPAGE_PCT } from "./constants";

/**
 * Hedging Direction - determines when hedging is active
 * - "down": Only hedge losing positions (traditional behavior)
 * - "up": Only buy more shares when winning at high probability (85¢+)
 * - "both": Both behaviors enabled (default - maximize wins and minimize losses)
 */
export type HedgingDirection = "down" | "up" | "both";

/**
 * Hedging Configuration
 */
export interface HedgingConfig {
  /** Enable hedging */
  enabled: boolean;

  /**
   * Direction for hedging (default: "both")
   * - "down": Only hedge losing positions (traditional behavior)
   * - "up": Only buy more shares when winning at high probability
   * - "both": Both behaviors enabled (maximize wins AND minimize losses)
   */
  direction: HedgingDirection;

  /** Loss % to trigger hedging (default: 20) */
  triggerLossPct: number;

  /** Maximum USD per hedge (default: from MAX_POSITION_USD) */
  maxHedgeUsd: number;

  /** Minimum USD per hedge - skip smaller hedges (default: 1) */
  minHedgeUsd: number;

  /** Allow exceeding maxHedgeUsd for large losses (default: true) */
  allowExceedMax: boolean;

  /** Absolute max even when exceeding (default: from HEDGING_ABSOLUTE_MAX_USD) */
  absoluteMaxUsd: number;

  /** Max entry price for hedging - only hedge risky positions (default: 0.75 = 75¢) */
  maxEntryPrice: number;

  /** Loss % to force liquidation instead of hedge (default: 50) */
  forceLiquidationPct: number;

  /**
   * Loss % threshold for emergency full protection (default: 30)
   * When position drops beyond this %, hedge sizing targets absoluteMaxUsd (or maxHedgeUsd
   * if !allowExceedMax) directly instead of the computed break-even size, to maximize
   * protection for heavy reversals. Reserve constraints are then applied separately.
   */
  emergencyLossPct: number;

  /**
   * Minimum seconds to hold before hedging/liquidating (default: 120)
   * CRITICAL: Prevents immediate sell after buying due to bid-ask spread.
   * Without this, a position bought at 65¢ might immediately show a "loss"
   * due to the spread between bid/ask and trigger an unwanted hedge/liquidation.
   */
  minHoldSeconds: number;

  // === NEAR-CLOSE HEDGING BEHAVIOR ===
  // Near market close, apply stricter hedging thresholds to avoid dumb hedges

  /**
   * Minutes before market close to apply near-close behavior (default: 30)
   * When position is within this window, stricter hedge triggers apply
   */
  nearCloseWindowMinutes: number;

  /**
   * Near-close: Minimum adverse price move (in cents) to trigger hedge (default: 12)
   * In the near-close window, only hedge if price dropped by at least this amount
   */
  nearClosePriceDropCents: number;

  /**
   * Near-close: Minimum loss % to trigger hedge (default: 30)
   * In the near-close window, only hedge if loss % exceeds this threshold
   * Note: Either price drop OR loss % can trigger a hedge (OR condition)
   */
  nearCloseLossPct: number;

  /**
   * Minutes before market close for near-resolution hedging behavior (default: 3)
   * 
   * Inside this window:
   * - Significant losses (>= triggerLossPct): HEDGE by buying inverse, then sell original
   *   This is actually the BEST time to hedge since outcome is nearly certain.
   * - Small losses (< triggerLossPct): Skip hedging (not worth the complexity)
   * 
   * The inverse purchase locks in recovery value, then selling the original
   * completes the hedge by salvaging whatever the losing position is still worth.
   */
  noHedgeWindowMinutes: number;

  // === SMART HEDGING UP (HIGH WIN PROBABILITY) ===
  // When near close and price is high (85¢+), buy MORE shares to maximize almost guaranteed gains

  /**
   * Price threshold for "hedging up" - buy more shares when current price >= this (default: 0.85 = 85¢)
   * When a position is winning at this price or above near market close,
   * buy additional shares to maximize gains since resolution to $1 is nearly guaranteed.
   */
  hedgeUpPriceThreshold: number;

  /**
   * Minutes before market close to enable "hedging up" behavior (default: 30)
   * Only buy more shares when within this window AND price >= hedgeUpPriceThreshold.
   * To hedge up without any time restriction, use the hedgeUpAnytime setting instead.
   */
  hedgeUpWindowMinutes: number;

  /**
   * Maximum USD to spend on "hedging up" per position (default: uses absoluteMaxUsd)
   * This is the maximum additional investment in a winning position.
   * Respects dynamic reserves - won't exceed available funds minus reserve.
   */
  hedgeUpMaxUsd: number;

  /**
   * Maximum price for "hedging up" - don't buy at prices >= this (default: 0.95 = 95¢)
   * Prevents buying at prices that are essentially "closed" where profit margin is minimal.
   * The sweet spot for hedging up is between hedgeUpPriceThreshold (85¢) and this max (95¢).
   */
  hedgeUpMaxPrice: number;

  /**
   * Allow "hedging up" at any time, not just near market close (default: false)
   * When true, positions at high win probability (>= hedgeUpPriceThreshold) can be
   * hedged up immediately, regardless of time to close.
   * When false (default), hedging up only occurs within hedgeUpWindowMinutes of market close.
   * This is the safer default - near close, the outcome is more certain.
   */
  hedgeUpAnytime: boolean;

  // === HEDGE EXIT MONITORING ===
  // When holding paired hedge positions, monitor when to exit the losing side

  /**
   * Price threshold to exit the losing side of a hedged position (default: 0.25 = 25¢)
   * When either side of a hedged position drops below this price, it's essentially
   * a guaranteed loss for that side. The system will sell that position to recover
   * remaining value before it goes to zero.
   *
   * Set to 0 to disable hedge exit monitoring.
   */
  hedgeExitThreshold: number;
}

export const DEFAULT_HEDGING_CONFIG: HedgingConfig = {
  enabled: true,
  direction: "both", // Enable both hedging down (losses) and hedging up (high win prob)
  triggerLossPct: 20,
  maxHedgeUsd: 10,
  minHedgeUsd: 1,
  allowExceedMax: true,
  absoluteMaxUsd: 25,
  maxEntryPrice: 1.0, // Hedge ALL positions regardless of entry price
  forceLiquidationPct: 50,
  emergencyLossPct: 30, // Emergency hedge mode at 30% loss - targets absoluteMaxUsd directly
  minHoldSeconds: 120, // Wait 2 minutes before hedging - prevents immediate sell after buy
  // Near-close hedging behavior
  nearCloseWindowMinutes: 30, // Apply near-close rules in last 30 minutes
  nearClosePriceDropCents: 12, // Near close: hedge only on >= 12¢ adverse move
  nearCloseLossPct: 30, // Near close: hedge only on >= 30% loss
  noHedgeWindowMinutes: 3, // Near-resolution: significant losses hedge (buy inverse + sell original)
  // Hedging up (high win probability) settings
  hedgeUpPriceThreshold: 0.85, // Buy more shares when price >= 85¢
  hedgeUpWindowMinutes: 30, // Enable hedging up in last 30 minutes before close
  hedgeUpMaxUsd: 25, // Max USD to spend per position on hedging up (matches absoluteMaxUsd)
  hedgeUpMaxPrice: 0.95, // Don't buy at 95¢+ (too close to resolved, minimal profit margin)
  hedgeUpAnytime: false, // Default: only hedge up near close (safer - more certainty of outcome)
  // Hedge exit monitoring
  hedgeExitThreshold: 0.25, // Exit losing side when it drops below 25¢ (guaranteed loss)
};

/**
 * Cooldown duration for failed liquidation attempts (5 minutes).
 *
 * RATIONALE:
 * - After a sell/hedge fails (due to insufficient balance, allowance, or liquidity),
 *   retrying immediately will almost certainly fail again.
 * - 5 minutes is long enough for external conditions to potentially change
 *   (e.g., deposits, approvals, or liquidity improvements).
 * - This prevents repeated attempts that spam logs, waste resources, and may
 *   trigger rate limits.
 *
 * WHEN APPLIED:
 * - When a sell order fails after hedge fails (both attempts exhausted)
 * - When a liquidation order fails in force-liquidation scenario
 * - When a liquidation fails in no-hedge window
 */
const FAILED_LIQUIDATION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Maximum number of entries to keep in the failedLiquidationCooldowns map.
 * Prevents unbounded memory growth if positions are removed through other means
 * (e.g., sold externally, redeemed, manually removed) before their cooldown expires.
 */
const MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES = 1000;

/**
 * Threshold for detecting essentially resolved markets.
 * When the opposite side price >= this threshold, the market is
 * considered resolved and liquidation is skipped in favor of redemption.
 */
const MARKET_RESOLVED_THRESHOLD = 0.95;

/**
 * Threshold for determining hedge is too expensive (normal hedging).
 * When the opposite side price >= this threshold but < MARKET_RESOLVED_THRESHOLD,
 * hedging is skipped but liquidation may still be attempted.
 * 
 * At 90¢, you pay 90¢ to get $1 = only 10¢ profit potential per share.
 * Transaction fees and slippage make this marginal.
 */
const HEDGE_TOO_EXPENSIVE_THRESHOLD = 0.9;

/**
 * Higher threshold for near-resolution hedging.
 * When close to market resolution, we're more willing to pay a premium
 * to lock in recovery value (cap losses rather than seek profit).
 * 
 * At 93¢, you pay 93¢ to guarantee $1 from one side = 7¢ minimum recovery.
 * This is still worth it to prevent total loss on the losing side.
 */
const NEAR_RESOLUTION_HEDGE_MAX_PRICE = 0.93;

/**
 * Hedging Strategy
 */
export class HedgingStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: HedgingConfig;
  /** Optional getter for the current reserve plan (injected by orchestrator) */
  private getReservePlan?: () => ReservePlan | null;

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

  // Track what we've already hedged to avoid double-hedging
  private hedgedPositions: Set<string> = new Set();

  // === PAIRED HEDGE TRACKING ===
  // Track relationships between original positions and their hedge positions
  // Key: original position key (marketId-tokenId), Value: { marketId, hedgeTokenId, originalTokenId }
  // Used for monitoring both sides and determining when to exit the losing side
  private pairedHedges: Map<string, { marketId: string; hedgeTokenId: string; originalTokenId: string }> = new Map();

  // Track positions that have been exited via hedge exit monitoring
  private hedgeExitedPositions: Set<string> = new Set();

  // Track failed liquidation attempts with cooldown to prevent repeated retries
  // Key: position key (marketId-tokenId), Value: timestamp when cooldown expires
  private failedLiquidationCooldowns: Map<string, number> = new Map();

  // === LOG DEDUPLICATION ===
  // Prevents per-position skip log spam by tracking state changes
  private logDeduper = new LogDeduper();
  // Track last skip reason per tokenId to detect state changes
  private lastSkipReasonByTokenId: Map<string, string> = new Map();
  // Cycle counter for summary logging
  private cycleCount = 0;

  constructor(config: {
    client: ClobClient;
    logger: ConsoleLogger;
    positionTracker: PositionTracker;
    config: HedgingConfig;
    /** Optional getter for the current reserve plan (for reserve-aware hedging) */
    getReservePlan?: () => ReservePlan | null;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.positionTracker = config.positionTracker;
    this.config = config.config;
    this.getReservePlan = config.getReservePlan;

    const hedgeUpStatus =
      this.config.direction !== "down"
        ? `@${(this.config.hedgeUpPriceThreshold * 100).toFixed(0)}¢-${(this.config.hedgeUpMaxPrice * 100).toFixed(0)}¢/$${this.config.hedgeUpMaxUsd}`
        : "disabled";

    const hedgeExitStatus =
      this.config.hedgeExitThreshold > 0
        ? `${(this.config.hedgeExitThreshold * 100).toFixed(0)}¢`
        : "disabled";

    this.logger.info(
      `[Hedging] Initialized: direction=${this.config.direction}, trigger=-${this.config.triggerLossPct}%, ` +
        `maxHedge=$${this.config.maxHedgeUsd}, absoluteMax=$${this.config.absoluteMaxUsd}, ` +
        `allowExceedMax=${this.config.allowExceedMax}, emergencyLossPct=${this.config.emergencyLossPct}%, ` +
        `minHoldSec=${this.config.minHoldSeconds}, hedgeUp=${hedgeUpStatus}, hedgeExit=${hedgeExitStatus}`,
    );
  }

  // Track positions that have been "hedged up" (bought more shares) this cycle
  private hedgedUpPositions: Set<string> = new Set();

  // === PER-CYCLE HEDGE BUDGET ===
  // Tracks remaining hedge budget within a single execute() cycle.
  // This prevents multiple hedges in the same cycle from exceeding (availableCash - reserveRequired).
  // Reset at the start of each executeInternal() call.
  private cycleHedgeBudgetRemaining: number | null = null;

  /**
   * Initialize the per-cycle hedge budget from the current reserve plan.
   * Called at the start of executeInternal() to set the budget for this cycle.
   * 
   * RESERVE BEHAVIOR: Hedging uses full available cash (even reserves) because:
   * - Hedging DOWN protects against losses (defensive)
   * - Hedging UP capitalizes on high-probability wins (opportunistic)
   * Both are valuable operations that justify using reserves. Reserves will be
   * replenished from profits, but missing hedge opportunities can be costly.
   */
  private initCycleHedgeBudget(): void {
    if (!this.getReservePlan) {
      this.cycleHedgeBudgetRemaining = null;
      return;
    }

    const plan = this.getReservePlan();
    if (!plan) {
      this.cycleHedgeBudgetRemaining = null;
      return;
    }

    // Initialize budget: use FULL available cash, not (availableCash - reserveRequired)
    // This allows hedging to use reserves for both protective (down) and opportunistic (up) cases.
    // The rationale: hedging is a high-value operation - missing a hedge opportunity can be
    // more costly than temporarily depleting reserves.
    this.cycleHedgeBudgetRemaining = plan.availableCash;
    
    // Log when we're using reserves for hedging
    if (plan.mode === "RISK_OFF") {
      this.logger.info(
        `[Hedging] 💰 Using reserves for hedging: available=$${plan.availableCash.toFixed(2)}, ` +
          `reserveRequired=$${plan.reserveRequired.toFixed(2)}, shortfall=$${plan.shortfall.toFixed(2)}`,
      );
    }
  }

  /**
   * Deduct an amount from the per-cycle hedge budget after a successful BUY order.
   * @param amountUsd - The USD amount spent on the hedge/buy-more operation (must be non-negative)
   */
  private deductFromCycleHedgeBudget(amountUsd: number): void {
    if (this.cycleHedgeBudgetRemaining !== null && amountUsd > 0) {
      this.cycleHedgeBudgetRemaining = Math.max(0, this.cycleHedgeBudgetRemaining - amountUsd);
    }
  }

  /**
   * Apply budget-aware sizing to a computed hedge/buy amount.
   * 
   * CRITICAL: Hedging is NEVER blocked by RISK_OFF mode or reserve shortfall. Hedging has its own rules
   * and is a high-priority risk management operation that must be allowed to proceed.
   * It only skips when there's literally zero cash available. The minimum hedge amount check
   * happens in the calling function (executeHedge/tryBuyMoreShares).
   *
   * @param computedUsd - The originally computed hedge/buy amount
   * @param operationLabel - Label for logging (e.g., "HEDGE" or "HEDGE UP")
   * @returns Object with { skip: true; reason: string } or { skip: false, cappedUsd: number, isPartial: boolean }
   */
  private applyReserveAwareSizing(
    computedUsd: number,
    operationLabel: string,
  ): { skip: true; reason: string } | { skip: false; cappedUsd: number; isPartial: boolean } {
    // If no budget tracking, use full computed amount
    if (this.cycleHedgeBudgetRemaining === null) {
      return { skip: false, cappedUsd: computedUsd, isPartial: false };
    }

    // HEDGING IS NEVER BLOCKED BY RESERVES - it has its own rules
    // If budget is below computed amount, cap to available budget (partial hedge)
    // The minimum hedge check happens separately in executeHedge/tryBuyMoreShares
    if (this.cycleHedgeBudgetRemaining < computedUsd) {
      const cappedUsd = this.cycleHedgeBudgetRemaining;
      if (cappedUsd > 0) {
        this.logger.info(
          `[Hedging] 📉 PARTIAL ${operationLabel}: Capping from $${computedUsd.toFixed(2)} to $${cappedUsd.toFixed(2)} (available cash)`,
        );
        return { skip: false, cappedUsd, isPartial: true };
      }
      // Only skip if literally zero cash available
      this.logger.warn(
        `[Hedging] 💸 ${operationLabel}: No cash available ($0.00) - cannot hedge`,
      );
      return { skip: true, reason: "NO_CASH_AVAILABLE" };
    }

    // Full amount available
    return { skip: false, cappedUsd: computedUsd, isPartial: false };
  }

  /**
   * Execute the strategy - find losing positions and hedge them
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard: prevent concurrent execution
    if (this.inFlight) {
      this.logger.debug("[Hedging] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    try {
      return await this.executeInternal();
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Internal execution logic (called by execute() with in-flight guard)
   */
  private async executeInternal(): Promise<number> {
    // Clean up expired cooldown entries periodically to prevent memory leaks
    this.cleanupExpiredCooldowns();

    // === INITIALIZE PER-CYCLE HEDGE BUDGET ===
    // This ensures multiple hedges in the same cycle don't exceed reserves
    this.initCycleHedgeBudget();

    const positions = this.positionTracker.getPositions();
    let actionsCount = 0;
    const now = Date.now();
    this.cycleCount++;

    // === DIAGNOSTIC: Log high-loss positions that could be hedged ===
    // This helps diagnose why hedging might not be acting on losses
    const highLossPositions = positions.filter(
      (p) => p.pnlPct < 0 && Math.abs(p.pnlPct) >= this.config.forceLiquidationPct
    );
    if (highLossPositions.length > 0) {
      // Rate limit this log to once per minute
      const logKey = `diagnostic_high_loss:${highLossPositions.length}`;
      if (this.logDeduper.shouldLog(logKey, 60_000)) {
        this.logger.info(
          `[Hedging] 🔍 Diagnostic: Found ${highLossPositions.length} catastrophic loss position(s) ` +
            `(>=${this.config.forceLiquidationPct}% loss). Direction=${this.config.direction}, ` +
            `Budget=$${this.cycleHedgeBudgetRemaining?.toFixed(2) ?? "null"}, ` +
            `Hedged=${this.hedgedPositions.size}, Cooldowns=${this.failedLiquidationCooldowns.size}`,
        );
      }
    }

    // === LOG DEDUPLICATION: Aggregate skip reasons instead of per-position logs ===
    const skipAggregator = new SkipReasonAggregator();

    // === PHASE 1: HEDGING UP (Buy more shares for high win probability positions near close) ===
    // This maximizes gains on nearly guaranteed wins by buying additional shares
    if (this.config.direction === "up" || this.config.direction === "both") {
      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

        // Skip if already hedged up this cycle
        if (this.hedgedUpPositions.has(key)) {
          continue;
        }

        // Check if position qualifies for "hedging up"
        const hedgeUpResult = await this.tryHedgeUp(position, now);
        if (hedgeUpResult.action === "bought") {
          actionsCount++;
          this.hedgedUpPositions.add(key);
          this.logger.info(
            `[Hedging] 📈 HEDGE UP: Bought more shares of ${position.side} ${tokenIdShort}... ` +
              `at ${formatCents(position.currentPrice)} (${hedgeUpResult.reason})`,
          );
        } else if (hedgeUpResult.action === "skipped") {
          skipAggregator.add(tokenIdShort, hedgeUpResult.reason);
        }
        // "not_applicable" means the position doesn't qualify for hedge up at all
      }
    }

    // === PHASE 2: HEDGING DOWN (Hedge or liquidate losing positions) ===
    // This is the traditional hedging behavior - protect against losses
    if (this.config.direction === "down" || this.config.direction === "both") {
      for (const position of positions) {
        const key = `${position.marketId}-${position.tokenId}`;
        const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

        // Helper to detect catastrophic losses for enhanced logging
        const isCatastrophicLossPosition = position.pnlPct < 0 && 
          Math.abs(position.pnlPct) >= this.config.forceLiquidationPct;

        // Skip if already hedged
        if (this.hedgedPositions.has(key)) {
          if (isCatastrophicLossPosition) {
            this.logger.info(
              `[Hedging] 📋 Catastrophic loss position already hedged: ${position.side ?? "?"} ${tokenIdShort}... at ${position.pnlPct.toFixed(1)}%`,
            );
          }
          skipAggregator.add(tokenIdShort, "already_hedged");
          continue;
        }

      // Skip if in failed liquidation cooldown (prevents repeated attempts)
      const cooldownUntil = this.failedLiquidationCooldowns.get(key);
      if (cooldownUntil && now < cooldownUntil) {
        if (isCatastrophicLossPosition) {
          const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
          this.logger.warn(
            `[Hedging] ⏳ Catastrophic loss position in cooldown: ${position.side ?? "?"} ${tokenIdShort}... at ${position.pnlPct.toFixed(1)}% (${remainingSec}s remaining)`,
          );
        }
        skipAggregator.add(tokenIdShort, "cooldown");
        continue;
      }
      // Clean up expired cooldown entries (for current position)
      if (cooldownUntil && now >= cooldownUntil) {
        this.failedLiquidationCooldowns.delete(key);
      }

      // === ORDERBOOK QUALITY ASSESSMENT (Jan 2025 Fix) ===
      // Check if orderbook prices can be trusted before making P&L-based decisions.
      // This prevents "catastrophic loss" false positives when orderbook is broken.
      //
      // CRITICAL: If orderbook is INVALID_BOOK or NO_BOOK, we should use
      // Data-API price (dataApiCurPrice) instead of orderbook-derived P&L.
      // The position.pnlTrusted flag already handles NO_BOOK cases, but we add
      // explicit orderbook quality checking for additional safety.
      //
      // EXCEPTION: For CATASTROPHIC losses with TRUSTED P&L, we still proceed.
      // The P&L source (Data-API) is reliable even if the orderbook is stale.
      const orderbookQuality = assessOrderbookQuality(
        position.currentBidPrice,
        position.currentAskPrice,
        position.dataApiCurPrice,
      );

      if (orderbookQuality.quality === "INVALID_BOOK") {
        // Check for catastrophic loss exception
        const isActualLoss = position.pnlPct < 0;
        const lossPctMagnitude = Math.abs(position.pnlPct);
        const isCatastrophicLossWithTrustedPnl = 
          isActualLoss && 
          lossPctMagnitude >= this.config.forceLiquidationPct && 
          position.pnlTrusted;

        if (isCatastrophicLossWithTrustedPnl) {
          // CATASTROPHIC LOSS with trusted P&L - PROCEED despite invalid orderbook
          // The P&L is calculated from Data-API which is reliable
          this.logger.warn(
            `[Hedging] 🚨 CATASTROPHIC LOSS (${lossPctMagnitude.toFixed(1)}%) with invalid orderbook ` +
              `(${orderbookQuality.reason}) but TRUSTED P&L - PROCEEDING with hedge/liquidation. ` +
              `Position: ${position.side} ${tokenIdShort}...`,
          );
          // Fall through to continue processing
        } else {
          // Orderbook is broken/stale - do not trust P&L derived from it
          // Skip hedge/liquidation to avoid acting on bad data
          const previousReason = this.lastSkipReasonByTokenId.get(key);
          if (previousReason !== "invalid_book") {
            this.logger.warn(
              `[Hedging] ⚠️ Invalid orderbook for ${position.side} ${tokenIdShort}... (${orderbookQuality.reason}), skipping to avoid false catastrophic loss`,
            );
            this.lastSkipReasonByTokenId.set(key, "invalid_book");
          }
          skipAggregator.add(tokenIdShort, "invalid_book");
          continue;
        }
      }

      // === CRITICAL: P&L TRUST CHECK ===
      // For normal losses, skip positions with untrusted P&L to avoid selling winners.
      // EXCEPTION: For CATASTROPHIC losses (>= forceLiquidationPct), allow action even with
      // untrusted P&L because the risk of inaction is greater than the risk of acting on
      // imperfect data. A 50% loss is a 50% loss regardless of P&L source precision.
      if (!position.pnlTrusted) {
        // Only consider catastrophic loss exception when pnlPct is actually negative
        const isActualLoss = position.pnlPct < 0;
        const lossPctMagnitude = Math.abs(position.pnlPct);
        const isCatastrophicLoss = isActualLoss && lossPctMagnitude >= this.config.forceLiquidationPct;
        
        if (isCatastrophicLoss) {
          // CATASTROPHIC LOSS with untrusted P&L - ALLOW hedging/liquidation with warning
          // The risk of doing nothing is greater than the risk of acting on imperfect data
          this.logger.warn(
            `[Hedging] 🚨 CATASTROPHIC LOSS (${lossPctMagnitude.toFixed(1)}% >= ${this.config.forceLiquidationPct}%) with untrusted P&L ` +
            `(${position.pnlUntrustedReason ?? "unknown reason"}) - PROCEEDING WITH HEDGE/LIQUIDATION despite data uncertainty`,
          );
          // Fall through to continue processing - don't skip
        } else if (isActualLoss && lossPctMagnitude >= this.config.triggerLossPct) {
          // Significant loss but not catastrophic - log warning but still skip
          this.logger.warn(
            `[Hedging] ⚠️ Skip hedge (UNTRUSTED_PNL): ${position.side} ${tokenIdShort}... at ${lossPctMagnitude.toFixed(1)}% loss has untrusted P&L (${position.pnlUntrustedReason ?? "unknown reason"}) - CANNOT HEDGE until P&L is trusted`,
          );
          skipAggregator.add(tokenIdShort, "untrusted_pnl");
          continue;
        } else {
          this.logger.debug(
            `[Hedging] 📋 Skip hedge (UNTRUSTED_PNL): ${position.side} position has untrusted P&L (${position.pnlUntrustedReason ?? "unknown reason"})`,
          );
          skipAggregator.add(tokenIdShort, "untrusted_pnl");
          continue;
        }
      }

      // === EXECUTION STATUS CHECK (Jan 2025 - Handle NOT_TRADABLE_ON_CLOB) ===
      // If position has executionStatus set to NOT_TRADABLE_ON_CLOB, skip hedging.
      // This handles orderbook 404, empty book, and other CLOB unavailability scenarios.
      // 
      // CRITICAL FIX (Jan 2025): For CATASTROPHIC losses, allow liquidation attempt even
      // when NOT_TRADABLE. The sellPosition method will use Data API price as fallback.
      // It's better to attempt a sell than do nothing on a 50%+ loss.
      if (
        position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
        position.executionStatus === "EXECUTION_BLOCKED"
      ) {
        const pnlPct = position.pnlPct;
        const lossPctMagnitude = Math.abs(pnlPct);
        const isActualLoss = pnlPct < 0;
        const isCatastrophicLoss = isActualLoss && lossPctMagnitude >= this.config.forceLiquidationPct;
        
        if (isCatastrophicLoss) {
          // CATASTROPHIC LOSS on NOT_TRADABLE position (trusted or untrusted P&L)
          // Attempt liquidation using Data API price as fallback
          // NOTE: Consistent with lines 619-626 which allow action on catastrophic losses
          // even with untrusted P&L - the risk of inaction is greater than the risk of acting
          this.logger.warn(
            `[Hedging] 🚨 CATASTROPHIC LOSS (${lossPctMagnitude.toFixed(1)}%) on NOT_TRADABLE position ${position.side} ${tokenIdShort}... ` +
              `- ATTEMPTING LIQUIDATION using Data API price ${(position.currentPrice * 100).toFixed(1)}¢` +
              `${!position.pnlTrusted ? ` (untrusted P&L: ${position.pnlUntrustedReason ?? "unknown"})` : ""}`,
          );
          
          // Skip hedging (can't buy opposite side without orderbook), but try to sell
          const key = `${position.marketId}-${position.tokenId}`;
          
          // Check cooldown
          const cooldownExpiry = this.failedLiquidationCooldowns.get(key);
          if (cooldownExpiry && now < cooldownExpiry) {
            this.logger.debug(
              `[Hedging] ⏳ Liquidation cooldown active for ${key} (expires in ${Math.ceil((cooldownExpiry - now) / 1000)}s)`,
            );
            skipAggregator.add(tokenIdShort, "cooldown");
            continue;
          }
          
          const sold = await this.sellPosition(position);
          if (sold) {
            actionsCount++;
            this.hedgedPositions.add(key);
            this.logger.info(
              `[Hedging] ✅ Emergency liquidation succeeded for NOT_TRADABLE position ${position.side} ${tokenIdShort}...`,
            );
          } else {
            this.failedLiquidationCooldowns.set(key, now + FAILED_LIQUIDATION_COOLDOWN_MS);
            this.logger.warn(
              `[Hedging] ⏳ Emergency liquidation failed - position on cooldown for 5 minutes: ${key}`,
            );
          }
          continue;
        }
        
        // Log at warn level for significant actual losses (pnlPct must be negative)
        if (isActualLoss && lossPctMagnitude >= this.config.triggerLossPct) {
          this.logger.warn(
            `[Hedging] ⚠️ Skip hedge (NOT_TRADABLE): ${position.side} ${tokenIdShort}... at ${lossPctMagnitude.toFixed(1)}% loss - position not tradable on CLOB (status=${position.executionStatus})`,
          );
        }
        skipAggregator.add(tokenIdShort, "not_tradable");
        continue;
      }

      // Skip if not losing enough
      if (position.pnlPct > -this.config.triggerLossPct) {
        skipAggregator.add(tokenIdShort, "loss_below_trigger");
        continue;
      }

      // Skip if entry price too high (not risky tier)
      if (position.entryPrice >= this.config.maxEntryPrice) {
        skipAggregator.add(tokenIdShort, "entry_price_high");
        continue;
      }

      // Skip if no side defined (can't hedge without knowing the outcome)
      const side = position.side?.toUpperCase();
      if (!side || side.trim() === "") {
        skipAggregator.add(tokenIdShort, "no_side");
        continue;
      }

      // Skip resolved positions - log state change only
      if (position.redeemable) {
        const previousReason = this.lastSkipReasonByTokenId.get(key);
        if (previousReason !== "redeemable") {
          // State changed to redeemable - this is noteworthy
          this.logger.info(
            `[Hedging] 🔄 Position became redeemable: ${position.side} ${tokenIdShort}... (routing to AutoRedeem)`,
          );
          this.lastSkipReasonByTokenId.set(key, "redeemable");
        }
        skipAggregator.add(tokenIdShort, "redeemable");
        continue;
      }

      // === NEAR-RESOLUTION GATING (Jan 2025 Fix) ===
      // CRITICAL: Skip positions that are near-resolution winners.
      // These positions are almost certainly going to resolve to $1.00.
      // Hedging/liquidating them would be selling winners at a discount.
      //
      // nearResolutionCandidate is computed by PositionTracker using:
      // - currentPrice >= 99.5¢ (NEAR_RESOLUTION_THRESHOLD_DOLLARS)
      // - currentPrice >= 50¢ (safety guard prevents false positives from broken orderbook)
      // - redeemable === false
      if (position.nearResolutionCandidate) {
        const previousReason = this.lastSkipReasonByTokenId.get(key);
        if (previousReason !== "near_resolution") {
          // State changed to near-resolution - log once per TTL
          this.logger.info(
            `[Hedging] 🎯 Near-resolution position (${formatCents(position.currentPrice)}), skipping hedge/liquidation: ${position.side} ${tokenIdShort}...`,
          );
          this.lastSkipReasonByTokenId.set(key, "near_resolution");
        }
        skipAggregator.add(tokenIdShort, "near_resolution");
        continue;
      }

      // CRITICAL: Check minimum hold time before ANY action (hedge or sell)
      // This prevents immediate sell/hedge after buying due to bid-ask spread
      //
      // EXCEPTION: For CATASTROPHIC losses (>= forceLiquidationPct), skip these checks.
      // If Data API says we're down 50%+, we should act immediately - the price IS the truth.
      const lossPct = Math.abs(position.pnlPct);
      const isCatastrophicLoss = position.pnlPct < 0 && lossPct >= this.config.forceLiquidationPct;
      
      const entryTime = this.positionTracker.getPositionEntryTime(
        position.marketId,
        position.tokenId,
      );
      
      if (!entryTime) {
        if (isCatastrophicLoss) {
          // CATASTROPHIC LOSS with no entry time - ACT ANYWAY
          // The Data API price is telling us we're losing badly - don't wait for entry time verification
          this.logger.warn(
            `[Hedging] 🚨 CATASTROPHIC LOSS (${lossPct.toFixed(1)}%) with no entry time - PROCEEDING ANYWAY (Data API is source of truth)`,
          );
          // Fall through to continue processing
        } else {
          // Normal loss without entry time - be conservative and skip
          skipAggregator.add(tokenIdShort, "no_entry_time");
          continue;
        }
      }

      // Check hold time (but skip for catastrophic losses)
      if (entryTime && !isCatastrophicLoss) {
        const holdSeconds = (now - entryTime) / 1000;
        if (holdSeconds < this.config.minHoldSeconds) {
          skipAggregator.add(tokenIdShort, "hold_time_short");
          continue;
        }
      }

      // === NEAR-CLOSE HEDGING BEHAVIOR ===
      // Near market close, hedging (buying the inverse) is actually MORE valuable, not less.
      // When a market is about to resolve, one outcome WILL pay $1. If you're losing on one side,
      // buying the other side guarantees you recover value from one of them.
      //
      // EXAMPLE: You hold YES at 20¢ (down from 60¢). Market closes in 2 minutes. NO is at 80¢.
      // - If you do NOTHING: You might lose 100% if YES loses
      // - If you BUY NO at 80¢: You're guaranteed $1 from one side, capping your loss
      //
      // The "no-hedge window" was originally meant to avoid dumb hedges, but it was actually
      // BLOCKING the smartest hedge - buying inverse near resolution when losing.
      //
      // NEW LOGIC (Jan 2025):
      // - Near resolution with significant loss: PRIORITIZE buying the inverse (hedge)
      // - After buying inverse, ALSO SELL the original losing position to recover remaining value
      // - Near-close threshold checks still apply for small losses (avoid overtrading)
      let isNearResolutionHedge = false;
      if (position.marketEndTime && position.marketEndTime > now) {
        const minutesToClose = (position.marketEndTime - now) / (60 * 1000);

        // Inside no-hedge window (last 2-3 minutes):
        // For significant losses, try to BUY THE INVERSE to lock in whatever value remains
        // This is the BEST time to hedge - the outcome is nearly certain
        if (minutesToClose <= this.config.noHedgeWindowMinutes) {
          if (lossPct >= this.config.triggerLossPct) {
            // Significant loss near resolution - buying inverse is critical
            isNearResolutionHedge = true;
            this.logger.info(
              `[Hedging] 🎯 NEAR-RESOLUTION HEDGE: ${minutesToClose.toFixed(1)}min to close, loss ${lossPct.toFixed(1)}% - ` +
                `Will BUY INVERSE then SELL original to lock in remaining value`,
            );
            // Fall through to the main hedging logic below - don't skip!
            // The hedge will try to buy the opposite side
          } else {
            // Small loss near close - not worth the complexity
            skipAggregator.add(tokenIdShort, "no_hedge_window_small_loss");
            continue;
          }
        }
        // Inside near-close window (default: last 30 minutes): apply stricter thresholds
        // Only hedge if it's a BIG adverse move (≥12¢) OR a BIG loss (≥30%)
        else if (minutesToClose <= this.config.nearCloseWindowMinutes) {
          const priceDropCents =
            (position.entryPrice - position.currentPrice) * 100;
          const meetsDropThreshold =
            priceDropCents >= this.config.nearClosePriceDropCents;
          const meetsLossThreshold = lossPct >= this.config.nearCloseLossPct;

          if (!meetsDropThreshold && !meetsLossThreshold) {
            // Use aggregator for near-close threshold skips
            skipAggregator.add(tokenIdShort, "near_close_threshold");
            continue;
          }

          this.logger.info(
            `[Hedging] 📍 Near-close hedge triggered: ${minutesToClose.toFixed(1)}min to close, ` +
              `loss=${lossPct.toFixed(1)}%${meetsLossThreshold ? " ✓" : ""}, ` +
              `drop=${priceDropCents.toFixed(1)}¢${meetsDropThreshold ? " ✓" : ""}`,
          );
        }
      }

      // ALWAYS try to hedge FIRST, even for catastrophic losses
      // Only liquidate as a last resort if hedge fails
      // NOTE: isCatastrophicLoss is already computed above at the entry time check

      // === HEDGE OPERATION LOCK ===
      // Acquire a lock on this market to prevent incoming BUY orders during the hedge operation.
      // This is critical because:
      // 1. When hedging, we may need to SELL a position then BUY the inverse
      // 2. If a copy-trade BUY comes in between, it could consume funds meant for the hedge
      // 3. This prevents conflicts and ensures the hedge operation completes atomically
      const lockAcquired = acquireHedgeLock(position.marketId, "HEDGE_DOWN");
      if (!lockAcquired) {
        this.logger.warn(
          `[Hedging] ⚠️ Could not acquire hedge lock for ${position.marketId.slice(0, 8)}... - another operation in progress`,
        );
        skipAggregator.add(tokenIdShort, "hedge_lock_unavailable");
        continue;
      }

      try {
        // Try to hedge
        this.logger.info(
          `[Hedging] 🎯 Position losing ${lossPct.toFixed(1)}%${isCatastrophicLoss ? " (catastrophic)" : ""}${isNearResolutionHedge ? " (near-resolution)" : ""} - attempting hedge FIRST`,
        );

        const hedgeResult = await this.executeHedge(position, lossPct, isNearResolutionHedge);
        if (hedgeResult.success) {
          actionsCount++;
          this.hedgedPositions.add(key);
          // Track paired hedge for exit monitoring
          if (hedgeResult.hedgeTokenId) {
            this.pairedHedges.set(key, {
              marketId: position.marketId,
              hedgeTokenId: hedgeResult.hedgeTokenId,
              originalTokenId: position.tokenId,
            });
            this.logger.debug(
              `[Hedging] 📊 Tracking paired hedge: original=${position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH)}... hedge=${hedgeResult.hedgeTokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH)}...`,
            );
          }

          // === NEAR-RESOLUTION: ALSO SELL THE ORIGINAL LOSING POSITION ===
          // After successfully buying the inverse near resolution, immediately sell
          // the original losing position to recover whatever value it still has.
          // This completes the hedge: BUY inverse + SELL original = locked in recovery
          if (isNearResolutionHedge) {
            this.logger.info(
              `[Hedging] 💰 NEAR-RESOLUTION: Now selling original losing position to complete hedge`,
            );
            const soldOriginal = await this.sellPosition(position);
            if (soldOriginal) {
              actionsCount++;
              // Mark the original as exited in hedge tracking
              this.hedgeExitedPositions.add(key);
              this.logger.info(
                `[Hedging] ✅ NEAR-RESOLUTION HEDGE COMPLETE: Bought inverse + sold original ${position.side} ${tokenIdShort}...`,
              );
            } else {
              this.logger.warn(
                `[Hedging] ⚠️ Failed to sell original position after hedge - will retry via hedge exit monitoring`,
              );
            }
          }
          continue;
        }

        // === PARTIAL FILL PROTECTION ===
        // If money was spent on a partial fill, mark position as hedged to prevent
        // re-hedging and exceeding HEDGING_ABSOLUTE_MAX_USD.
        // This is critical: without this check, partial fills could trigger repeated
        // hedge attempts, each spending money until the total far exceeds the limit.
        if (hedgeResult.filledAmountUsd) {
          this.logger.warn(
            `[Hedging] 🛑 Partial hedge fill ($${hedgeResult.filledAmountUsd.toFixed(2)}) - marking position as hedged to prevent exceeding ABSOLUTE_MAX`,
          );
          this.hedgedPositions.add(key);
          // Track paired hedge even for partial fills
          if (hedgeResult.hedgeTokenId) {
            this.pairedHedges.set(key, {
              marketId: position.marketId,
              hedgeTokenId: hedgeResult.hedgeTokenId,
              originalTokenId: position.tokenId,
            });
          }
          
          // For partial fills near resolution, still try to sell the original
          if (isNearResolutionHedge) {
            this.logger.info(
              `[Hedging] 💰 NEAR-RESOLUTION (partial): Attempting to sell original losing position`,
            );
            const soldOriginal = await this.sellPosition(position);
            if (soldOriginal) {
              actionsCount++;
              this.hedgeExitedPositions.add(key);
            }
          }
          actionsCount++;
          continue;
        }

        // If market is essentially resolved (opposite side >= 95¢), skip liquidation
        // The position should be redeemed, not sold at a loss
        if (hedgeResult.reason === "MARKET_RESOLVED") {
          this.logger.info(
            `[Hedging] 📋 Position marked as resolved - skipping liquidation, awaiting redemption: ${key}`,
          );
          // Add to hedged positions to prevent future attempts (will be redeemed instead)
          this.hedgedPositions.add(key);
          continue;
        }

        // === REASON-AWARE HEDGE FALLBACK ===
        // When hedge fails due to insufficient funds or no cash available, try to free funds
        // by selling profitable positions (lowest profit first), then retry the hedge.
        // Keep selling positions until we have enough funds for the hedge.
        //
        // IMPORTANT: This fund-freeing logic is ONLY for HEDGING DOWN (protecting losses).
        // HEDGE UP (buying more of winning positions) should NOT sell other positions.
        if (hedgeResult.reason === "INSUFFICIENT_BALANCE_OR_ALLOWANCE" || hedgeResult.reason === "NO_CASH_AVAILABLE") {
          // Calculate how much we need for the hedge
          // Use absoluteMaxUsd as the target since that's the max we'd spend on a hedge
          const targetHedgeAmount = this.config.allowExceedMax 
            ? this.config.absoluteMaxUsd 
            : this.config.maxHedgeUsd;
          
          this.logger.info(
            `[Hedging] 💰 Hedge failed (insufficient funds) - need ~$${targetHedgeAmount.toFixed(2)} for hedge, attempting to free funds by selling profitable positions`,
          );

          // Get profitable positions sorted by lowest profit first (sell smallest winners first)
          const profitCandidates =
            this.positionTracker.getProfitLiquidationCandidates(
              0, // Any profit
              this.config.minHoldSeconds,
            );

          // Filter out positions we've already hedged
          const sellableProfits = profitCandidates.filter((p) => {
            const k = `${p.marketId}-${p.tokenId}`;
            return !this.hedgedPositions.has(k);
          });

          let totalFreedFunds = 0;
          let positionsSold = 0;
          
          // Keep selling lowest-profit positions until we have enough funds
          for (const profitToSell of sellableProfits) {
            // Check if we've freed enough funds already
            if (totalFreedFunds >= targetHedgeAmount) {
              this.logger.info(
                `[Hedging] 💰 Freed enough funds ($${totalFreedFunds.toFixed(2)} >= $${targetHedgeAmount.toFixed(2)}) after selling ${positionsSold} position(s)`,
              );
              break;
            }

            this.logger.info(
              `[Hedging] 🔄 Selling profitable position #${positionsSold + 1} to free funds: ${profitToSell.side} +${profitToSell.pnlPct.toFixed(1)}% ($${(profitToSell.size * profitToSell.currentPrice).toFixed(2)})`,
            );

            const soldProfit = await this.sellPosition(profitToSell);
            if (soldProfit) {
              positionsSold++;
              actionsCount++;
              // Mark as hedged to prevent future attempts on this position
              this.hedgedPositions.add(
                `${profitToSell.marketId}-${profitToSell.tokenId}`,
              );
              // Update cycle budget with freed funds so retry can use them
              // Account for transaction fees (taker fee on sell)
              const grossValue = profitToSell.size * profitToSell.currentPrice;
              const feeAmount = grossValue * (POLYMARKET_TAKER_FEE_BPS / BASIS_POINTS_DIVISOR);
              const freedValue = grossValue - feeAmount;
              totalFreedFunds += freedValue;
              
              if (this.cycleHedgeBudgetRemaining !== null) {
                this.cycleHedgeBudgetRemaining += freedValue;
              }
              
              this.logger.info(
                `[Hedging] 💰 Freed $${freedValue.toFixed(2)} (gross $${grossValue.toFixed(2)} - fees $${feeAmount.toFixed(4)}) - total freed: $${totalFreedFunds.toFixed(2)}`,
              );
            } else {
              this.logger.warn(
                `[Hedging] ⚠️ Failed to sell profitable position for fund release - trying next`,
              );
            }
          }

          if (positionsSold === 0) {
            this.logger.debug(
              `[Hedging] 📋 No profitable positions available to sell for fund release`,
            );
          }

          // Retry hedge if we freed some funds
          if (totalFreedFunds > 0) {
            this.logger.info(
              `[Hedging] 🔄 Retrying hedge after freeing $${totalFreedFunds.toFixed(2)} from ${positionsSold} position(s)...`,
            );

            const retryResult = await this.executeHedge(position, lossPct, isNearResolutionHedge);
            if (retryResult.success) {
              actionsCount++;
              this.hedgedPositions.add(key);
              
              // For near-resolution, also sell the original after successful hedge
              if (isNearResolutionHedge) {
                this.logger.info(
                  `[Hedging] 💰 NEAR-RESOLUTION: Now selling original losing position to complete hedge`,
                );
                const soldOriginal = await this.sellPosition(position);
                if (soldOriginal) {
                  actionsCount++;
                  this.hedgeExitedPositions.add(key);
                }
              }
              continue;
            }

            // Check for partial fill on retry - still mark as hedged to prevent exceeding limit
            if (retryResult.filledAmountUsd) {
              this.logger.warn(
                `[Hedging] 🛑 Retry partial fill ($${retryResult.filledAmountUsd.toFixed(2)}) - marking position as hedged`,
              );
              this.hedgedPositions.add(key);
              actionsCount++;
              continue;
            }

            this.logger.warn(
              `[Hedging] ⚠️ Hedge retry failed (${retryResult.reason}) - will sell losing position as last resort`,
            );
          }

          // Fall through to selling the losing position as last resort
        }

        // Log specific hedge failure reasons for visibility
        if (
          hedgeResult.reason === "TOO_EXPENSIVE" ||
          hedgeResult.reason === "NO_OPPOSITE_TOKEN" ||
          hedgeResult.reason === "NO_LIQUIDITY"
        ) {
          this.logger.info(
            `[Hedging] 📋 Hedge skip reason: ${hedgeResult.reason}`,
          );
        }

        // === NEAR-RESOLUTION: SELL LOSING POSITION EVEN IF HEDGE FAILED ===
        // If we're near resolution and couldn't buy the inverse (e.g., too expensive at 93¢+),
        // we should STILL sell the original position to recover whatever value it has.
        // Don't wait for it to go to $0 and redeem nothing!
        //
        // EXCEPTION: If market is essentially resolved (95¢+), await redemption instead.
        if (isNearResolutionHedge && hedgeResult.reason !== "MARKET_RESOLVED") {
          this.logger.warn(
            `[Hedging] 🚨 NEAR-RESOLUTION: Hedge failed (${hedgeResult.reason}) - SELLING losing position to salvage remaining value`,
          );
          const sold = await this.sellPosition(position);
          if (sold) {
            actionsCount++;
            this.hedgedPositions.add(key);
            this.logger.info(
              `[Hedging] ✅ NEAR-RESOLUTION: Sold losing ${position.side} ${tokenIdShort}... to recover value`,
            );
          } else {
            this.failedLiquidationCooldowns.set(key, now + FAILED_LIQUIDATION_COOLDOWN_MS);
            this.logger.warn(
              `[Hedging] ⏳ Near-resolution sell failed - position on cooldown: ${key}`,
            );
          }
          continue;
        }

        // Hedge failed - only liquidate if loss is catastrophic (>= forceLiquidationPct)
        // For smaller losses, wait and try again later (market conditions may improve)
        if (!isCatastrophicLoss) {
          this.logger.info(
            `[Hedging] 📋 Hedge failed (${hedgeResult.reason}) but loss ${lossPct.toFixed(1)}% < ${this.config.forceLiquidationPct}% threshold - waiting for better conditions`,
          );
          continue;
        }

        // Catastrophic loss AND hedge failed - liquidate to stop bleeding
        this.logger.warn(
          `[Hedging] 🚨 Hedge failed (${hedgeResult.reason}) AND loss ${lossPct.toFixed(1)}% >= ${this.config.forceLiquidationPct}% - LIQUIDATING as last resort`,
        );
        const sold = await this.sellPosition(position);
        if (sold) {
          actionsCount++;
          this.hedgedPositions.add(key);
        } else {
          // Both hedge and sell failed - add to cooldown to prevent repeated attempts
          this.failedLiquidationCooldowns.set(
            key,
            now + FAILED_LIQUIDATION_COOLDOWN_MS,
          );
          this.logger.warn(
            `[Hedging] ⏳ Hedge and liquidation both failed - position on cooldown for 5 minutes: ${key}`,
          );
        }
      } finally {
        // Always release the hedge lock when done
        releaseHedgeLock(position.marketId);
      }
    }
    }

    // === PHASE 3: HEDGE EXIT MONITORING ===
    // Monitor paired hedge positions and exit the losing side when it drops below threshold
    // This recovers value from guaranteed losing positions before they go to zero
    if (this.config.hedgeExitThreshold > 0 && this.pairedHedges.size > 0) {
      const exitActionsCount = await this.monitorHedgeExits(positions, now);
      actionsCount += exitActionsCount;
    }

    // === LOG DEDUPLICATION: Emit aggregated skip summary (rate-limited) ===
    // Use WARN level for significant issues (reserve shortfall, not tradable) to ensure visibility
    if (skipAggregator.hasSkips()) {
      const fingerprint = skipAggregator.getFingerprint();
      if (this.logDeduper.shouldLogSummary("Hedging", fingerprint)) {
        const summary = skipAggregator.getSummary();
        // Check for critical skip reasons that need visibility
        // Use specific patterns to avoid false positives (e.g., matching 'reserve' in unrelated text)
        const hasCriticalSkips = 
          summary.includes("NO_CASH_AVAILABLE") || 
          summary.includes("untrusted_pnl") ||
          summary.includes("not_tradable") ||
          summary.includes("cooldown") ||
          summary.includes("hedge_lock_unavailable") ||
          summary.includes("invalid_book");
        
        if (hasCriticalSkips) {
          this.logger.warn(
            `[Hedging] ⚠️ Skipped ${skipAggregator.getTotalCount()} positions: ${summary} (cycle=${this.cycleCount})`,
          );
        } else {
          // Still log at INFO level if positions were skipped - helps diagnose issues
          this.logger.info(
            `[Hedging] 📋 Skipped ${skipAggregator.getTotalCount()} positions: ${summary} (cycle=${this.cycleCount})`,
          );
        }
      }
    }

    return actionsCount;
  }

  /**
   * Try to "hedge up" - buy more shares of a high win probability position near market close.
   *
   * LOGIC:
   * 1. Check if position qualifies: price >= hedgeUpPriceThreshold (e.g., 85¢)
   * 2. Check if near close: within hedgeUpWindowMinutes (e.g., 30 minutes)
   * 3. Check if we have sufficient funds (respecting dynamic reserves)
   * 4. If all conditions met, buy additional shares up to hedgeUpMaxUsd
   *
   * @returns Object indicating the action taken:
   *          - action: "bought" if we bought more shares
   *          - action: "skipped" if conditions not met but position could qualify
   *          - action: "not_applicable" if position doesn't qualify at all
   *          - reason: Description of what happened
   */
  private async tryHedgeUp(
    position: Position,
    now: number,
  ): Promise<{ action: "bought" | "skipped" | "not_applicable"; reason: string }> {
    const tokenIdShort = position.tokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);

    // === BASIC QUALIFICATION CHECKS ===

    // Check if position has a side (required for trading)
    if (!position.side || position.side.trim() === "") {
      return { action: "not_applicable", reason: "no_side" };
    }

    // Check if price is at high win probability threshold
    if (position.currentPrice < this.config.hedgeUpPriceThreshold) {
      return { action: "not_applicable", reason: "price_below_threshold" };
    }

    // Check if price is too high (essentially closed - minimal profit margin)
    // Sweet spot is between hedgeUpPriceThreshold (85¢) and hedgeUpMaxPrice (95¢)
    if (position.currentPrice >= this.config.hedgeUpMaxPrice) {
      return { action: "skipped", reason: "price_too_high" };
    }

    // Check execution status - can't trade if position is not tradable
    if (
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED"
    ) {
      return { action: "skipped", reason: "not_tradable" };
    }

    // Skip redeemable positions (market already resolved)
    if (position.redeemable) {
      return { action: "skipped", reason: "redeemable" };
    }

    // Skip near-resolution positions (99.5¢+, essentially already won)
    if (position.nearResolutionCandidate) {
      return { action: "skipped", reason: "near_resolution" };
    }

    // === TIME WINDOW CHECK ===
    // If hedgeUpAnytime is enabled, skip the time window check entirely
    // Otherwise, only hedge up when near market close
    if (!this.config.hedgeUpAnytime) {
      if (!position.marketEndTime || position.marketEndTime <= now) {
        // No end time available or market already ended
        return { action: "not_applicable", reason: "no_end_time" };
      }

      const minutesToClose = (position.marketEndTime - now) / (60 * 1000);

      // Must be within the hedge up window
      if (minutesToClose > this.config.hedgeUpWindowMinutes) {
        return { action: "not_applicable", reason: "outside_window" };
      }

      // Don't hedge up in the very last minutes (same as no-hedge window)
      if (minutesToClose <= this.config.noHedgeWindowMinutes) {
        return { action: "skipped", reason: "no_hedge_window" };
      }
    } else {
      // Even with hedgeUpAnytime, respect the no-hedge window if market end time is known
      if (position.marketEndTime && position.marketEndTime > now) {
        const minutesToClose = (position.marketEndTime - now) / (60 * 1000);
        if (minutesToClose <= this.config.noHedgeWindowMinutes) {
          return { action: "skipped", reason: "no_hedge_window" };
        }
      }
    }

    // === ORDERBOOK QUALITY CHECK ===
    const orderbookQuality = assessOrderbookQuality(
      position.currentBidPrice,
      position.currentAskPrice,
      position.dataApiCurPrice,
    );

    if (orderbookQuality.quality === "INVALID_BOOK") {
      return { action: "skipped", reason: "invalid_book" };
    }

    // === EXECUTE HEDGE UP ===
    // Compute time to close for logging (may be undefined if no marketEndTime)
    const timeToCloseStr = position.marketEndTime && position.marketEndTime > now
      ? `${((position.marketEndTime - now) / (60 * 1000)).toFixed(1)}min to close`
      : "no close time";
    this.logger.info(
      `[Hedging] 📈 HEDGE UP candidate: ${position.side} ${tokenIdShort}... ` +
        `at ${formatCents(position.currentPrice)}, ${timeToCloseStr}`,
    );

    const result = await this.executeBuyMore(position);
    if (result.success) {
      return {
        action: "bought",
        reason: `bought_$${result.amountUsd?.toFixed(2) ?? "?"}_at_${formatCents(position.currentPrice)}`,
      };
    }

    return { action: "skipped", reason: result.reason ?? "buy_failed" };
  }

  /**
   * Execute a "buy more" order - buy additional shares of the same position.
   * Used for "hedging up" to maximize gains on high probability positions.
   *
   * @returns Object with success status, reason, and amount spent
   */
  private async executeBuyMore(
    position: Position,
  ): Promise<{ success: boolean; reason?: string; amountUsd?: number }> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[Hedging] No wallet - cannot buy more`);
      return { success: false, reason: "NO_WALLET" };
    }

    // Get current ask price for buying
    let askPrice: number;
    try {
      const orderbook = await this.client.getOrderBook(position.tokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(`[Hedging] No liquidity to buy more ${position.side}`);
        return { success: false, reason: "NO_LIQUIDITY" };
      }
      askPrice = parseFloat(orderbook.asks[0].price);
    } catch {
      this.logger.warn(`[Hedging] Failed to get price for buying more`);
      return { success: false, reason: "ORDERBOOK_ERROR" };
    }

    // Check if ask price is still at or above our threshold
    if (askPrice < this.config.hedgeUpPriceThreshold) {
      this.logger.debug(
        `[Hedging] Ask price ${formatCents(askPrice)} below threshold ${formatCents(this.config.hedgeUpPriceThreshold)}`,
      );
      return { success: false, reason: "PRICE_DROPPED" };
    }

    // Check if ask price is too high (essentially closed - minimal profit margin)
    if (askPrice >= this.config.hedgeUpMaxPrice) {
      this.logger.debug(
        `[Hedging] Ask price ${formatCents(askPrice)} too high (>= ${formatCents(this.config.hedgeUpMaxPrice)}) - minimal profit margin`,
      );
      return { success: false, reason: "PRICE_TOO_HIGH" };
    }

    // === UNLIMITED MODE FOR HEDGE UP ===
    // Use full available cash - no ENV cap.
    let buyUsd: number;
    if (this.cycleHedgeBudgetRemaining !== null) {
      buyUsd = this.cycleHedgeBudgetRemaining;
      this.logger.info(
        `[Hedging] 📈 HEDGE UP SIZING: UNLIMITED MODE - using full available cash $${buyUsd.toFixed(2)}`,
      );
    } else {
      // Fallback to config limits if no budget tracking
      if (this.config.allowExceedMax) {
        buyUsd = Math.min(this.config.hedgeUpMaxUsd, this.config.absoluteMaxUsd);
      } else {
        buyUsd = Math.min(this.config.hedgeUpMaxUsd, this.config.maxHedgeUsd);
      }
      this.logger.info(
        `[Hedging] 📈 HEDGE UP SIZING: fallback to config limit $${buyUsd.toFixed(2)}`,
      );
    }

    // === BUDGET-AWARE SIZING ===
    // Apply sizing using per-cycle hedge budget (available cash)
    const reserveSizing = this.applyReserveAwareSizing(buyUsd, "HEDGE UP");
    if (reserveSizing.skip) {
      return { success: false, reason: reserveSizing.reason };
    }
    buyUsd = reserveSizing.cappedUsd;

    // Check minimum
    if (buyUsd < this.config.minHedgeUsd) {
      this.logger.debug(
        `[Hedging] Buy amount $${buyUsd.toFixed(2)} below min $${this.config.minHedgeUsd}`,
      );
      return { success: false, reason: "BELOW_MIN" };
    }

    // Calculate expected profit if we win
    const additionalShares = buyUsd / askPrice;
    const potentialProfit = additionalShares * (1 - askPrice); // What we make if price goes to $1

    this.logger.info(
      `[Hedging] 📈 BUYING MORE: ${additionalShares.toFixed(2)} ${position.side} @ ${formatCents(askPrice)} = $${buyUsd.toFixed(2)}` +
        `\n  Potential profit if ${position.side} wins: +$${potentialProfit.toFixed(2)}`,
    );

    try {
      // Normalize the outcome for the order API
      const orderOutcome = this.normalizeOutcomeForOrder(position.side ?? "YES");

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: orderOutcome,
        side: "BUY",
        sizeUsd: buyUsd,
        maxAcceptablePrice: askPrice * 1.02, // Allow 2% slippage
        logger: this.logger,
        skipDuplicatePrevention: true, // Hedge up is intentional
        skipMinBuyPriceCheck: true, // High prices are what we want here
      });

      if (result.status === "submitted") {
        // Deduct from per-cycle hedge budget to prevent exceeding reserves
        this.deductFromCycleHedgeBudget(buyUsd);
        this.logger.info(`[Hedging] ✅ Buy more executed successfully`);
        return { success: true, amountUsd: buyUsd };
      }

      this.logger.warn(
        `[Hedging] ⚠️ Buy more order not filled: ${result.reason ?? "unknown"}`,
      );
      return { success: false, reason: result.reason ?? "ORDER_NOT_FILLED" };
    } catch (err) {
      this.logger.error(
        `[Hedging] ❌ Buy more failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { success: false, reason: "BUY_ERROR" };
    }
  }

  /**
   * Monitor paired hedge positions and exit the losing side when it drops below threshold.
   *
   * When we hold both sides of a binary market (original position + hedge position),
   * one side is guaranteed to lose. When a side drops below hedgeExitThreshold (e.g., 25¢),
   * it's essentially a guaranteed loss - we should sell it to recover remaining value
   * before it goes to zero.
   *
   * @param positions - All current positions from position tracker
   * @param now - Current timestamp
   * @returns Number of exit actions taken
   */
  private async monitorHedgeExits(
    positions: Position[],
    now: number,
  ): Promise<number> {
    let exitActionsCount = 0;

    // Create a map for quick position lookup by marketId-tokenId
    const positionMap = new Map<string, Position>();
    for (const pos of positions) {
      positionMap.set(`${pos.marketId}-${pos.tokenId}`, pos);
    }

    // Check each paired hedge
    for (const [originalKey, pairedInfo] of this.pairedHedges.entries()) {
      const { marketId, hedgeTokenId, originalTokenId } = pairedInfo;
      const hedgeKey = `${marketId}-${hedgeTokenId}`;

      // Skip if either position has already been exited
      if (this.hedgeExitedPositions.has(originalKey) || this.hedgeExitedPositions.has(hedgeKey)) {
        continue;
      }

      // Get both positions
      const originalPosition = positionMap.get(originalKey);
      const hedgePosition = positionMap.get(hedgeKey);

      // Skip if either position is no longer held
      if (!originalPosition && !hedgePosition) {
        // Both positions gone - clean up tracking (including hedgeExitedPositions)
        this.pairedHedges.delete(originalKey);
        this.hedgeExitedPositions.delete(originalKey);
        this.hedgeExitedPositions.delete(hedgeKey);
        continue;
      }

      // Check original position for exit (if still held)
      if (originalPosition && originalPosition.currentPrice < this.config.hedgeExitThreshold) {
        const tokenIdShort = originalTokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);
        this.logger.warn(
          `[Hedging] 🔻 HEDGE EXIT: Original ${originalPosition.side} ${tokenIdShort}... at ` +
            `${formatCents(originalPosition.currentPrice)} < ${formatCents(this.config.hedgeExitThreshold)} threshold - SELLING to recover value`,
        );

        // Acquire hedge lock to prevent incoming BUY orders during exit sale
        const lockAcquired = acquireHedgeLock(marketId, "HEDGE_EXIT");
        if (!lockAcquired) {
          this.logger.warn(
            `[Hedging] ⚠️ Could not acquire hedge lock for hedge exit - skipping`,
          );
          continue;
        }
        try {
          const sold = await this.sellPosition(originalPosition);
          if (sold) {
            exitActionsCount++;
            this.hedgeExitedPositions.add(originalKey);
            this.logger.info(
              `[Hedging] ✅ HEDGE EXIT: Sold losing original position ${tokenIdShort}...`,
            );
          }
        } finally {
          releaseHedgeLock(marketId);
        }
        continue; // Don't check hedge side in same cycle
      }

      // Check hedge position for exit (if still held)
      if (hedgePosition && hedgePosition.currentPrice < this.config.hedgeExitThreshold) {
        const tokenIdShort = hedgeTokenId.slice(0, TOKEN_ID_DISPLAY_LENGTH);
        this.logger.warn(
          `[Hedging] 🔻 HEDGE EXIT: Hedge ${hedgePosition.side} ${tokenIdShort}... at ` +
            `${formatCents(hedgePosition.currentPrice)} < ${formatCents(this.config.hedgeExitThreshold)} threshold - SELLING to recover value`,
        );

        // Acquire hedge lock to prevent incoming BUY orders during exit sale
        const lockAcquired = acquireHedgeLock(marketId, "HEDGE_EXIT");
        if (!lockAcquired) {
          this.logger.warn(
            `[Hedging] ⚠️ Could not acquire hedge lock for hedge exit - skipping`,
          );
          continue;
        }
        try {
          const sold = await this.sellPosition(hedgePosition);
          if (sold) {
            exitActionsCount++;
            this.hedgeExitedPositions.add(hedgeKey);
            this.logger.info(
              `[Hedging] ✅ HEDGE EXIT: Sold losing hedge position ${tokenIdShort}...`,
            );
          }
        } finally {
          releaseHedgeLock(marketId);
        }
      }
    }

    return exitActionsCount;
  }

  /**
   * Execute a hedge - buy the opposite side
   * Supports all binary market types: YES/NO, Over/Under, Team A/Team B, etc.
   *
   * @param position - The position to hedge
   * @param lossPct - Optional loss percentage for emergency hedge detection.
   *                  When >= emergencyLossPct, targets absoluteMaxUsd directly instead of break-even calculation.
   * @param isNearResolution - Optional flag indicating this is a near-resolution hedge.
   *                           When true, uses higher price threshold (93¢ vs 90¢) since the goal
   *                           is to cap losses rather than seek profit.
   * @returns Object with success status and reason for failure
   *          - reason "MARKET_RESOLVED" means opposite side >= 95¢, skip liquidation
   *          - reason "TOO_EXPENSIVE" means opposite side >= threshold, try liquidation
   *          - other reasons indicate hedge attempt failed, try liquidation
   *          - filledAmountUsd: Amount spent on partial fills (prevents re-hedging if > 0)
   *          - hedgeTokenId: The token ID of the hedge position (for paired tracking)
   */
  private async executeHedge(
    position: Position,
    lossPct?: number,
    isNearResolution?: boolean,
  ): Promise<{ success: boolean; reason?: string; filledAmountUsd?: number; hedgeTokenId?: string }> {
    const currentSide = position.side?.toUpperCase();

    // Get the opposite token (works for any binary market)
    const oppositeInfo = await this.getOppositeToken(
      position.marketId,
      position.tokenId,
    );

    if (!oppositeInfo) {
      this.logger.warn(
        `[Hedging] Could not find opposite token for ${currentSide}`,
      );
      return { success: false, reason: "NO_OPPOSITE_TOKEN" };
    }

    const { tokenId: oppositeTokenId, outcome: oppositeSide } = oppositeInfo;

    // Get opposite side price
    let oppositePrice: number;
    try {
      const orderbook = await this.client.getOrderBook(oppositeTokenId);
      if (!orderbook.asks || orderbook.asks.length === 0) {
        this.logger.warn(`[Hedging] No liquidity for ${oppositeSide}`);
        return { success: false, reason: "NO_LIQUIDITY" };
      }
      oppositePrice = parseFloat(orderbook.asks[0].price);
    } catch {
      this.logger.warn(`[Hedging] Failed to get opposite price`);
      return { success: false, reason: "ORDERBOOK_ERROR" };
    }

    // Determine price threshold based on hedge type
    // Near-resolution hedges use higher threshold (93¢) since goal is to cap losses
    // Normal hedges use lower threshold (90¢) since we need profit margin
    const priceThreshold = isNearResolution
      ? NEAR_RESOLUTION_HEDGE_MAX_PRICE
      : HEDGE_TOO_EXPENSIVE_THRESHOLD;

    // If opposite is >= 95¢, market is essentially resolved - await redemption
    if (oppositePrice >= MARKET_RESOLVED_THRESHOLD) {
      this.logger.info(
        `[Hedging] ${oppositeSide} at ${(oppositePrice * 100).toFixed(0)}¢ - market essentially resolved, skipping (await redemption)`,
      );
      // Return special indicator that this is a resolved market, not a hedge failure
      return { success: false, reason: "MARKET_RESOLVED" };
    }

    // Check if opposite side is too expensive to hedge
    // For near-resolution hedges, allow hedging at exactly the threshold (93¢)
    // since the goal is loss-capping, not profit. Normal hedges use >= for 90¢.
    const isTooExpensive = isNearResolution
      ? oppositePrice > priceThreshold  // Allow exactly 93¢ for near-resolution
      : oppositePrice >= priceThreshold; // Block at 90¢+ for normal hedges
    
    if (isTooExpensive) {
      const thresholdLabel = isNearResolution ? "near-resolution max" : "normal max";
      const comparisonOp = isNearResolution ? ">" : ">=";
      this.logger.warn(
        `[Hedging] ${oppositeSide} at ${(oppositePrice * 100).toFixed(0)}¢ ${comparisonOp} ${(priceThreshold * 100).toFixed(0)}¢ (${thresholdLabel}) - too expensive to hedge`,
      );
      return { success: false, reason: "TOO_EXPENSIVE" };
    }

    // Calculate hedge size
    const originalInvestment = position.size * position.entryPrice;
    const hedgeProfit = 1 - oppositePrice; // What we make per share if hedge wins

    // Calculate shares needed to guarantee profit on hedge win
    const breakEvenShares = originalInvestment / hedgeProfit;
    const profitableHedgeUsd = breakEvenShares * oppositePrice * 1.1; // 10% buffer

    // === UNLIMITED MODE FOR HEDGING ===
    // Hedging uses full available cash - no ENV cap.
    // The hedge amount is determined by available cash, not config limits.
    // This ensures we can always protect against losses.
    const isEmergencyHedge = lossPct !== undefined && lossPct >= this.config.emergencyLossPct;
    let hedgeUsd: number;
    
    // Use the full available budget (will be capped by applyReserveAwareSizing)
    if (this.cycleHedgeBudgetRemaining !== null) {
      hedgeUsd = this.cycleHedgeBudgetRemaining;
      if (isEmergencyHedge) {
        this.logger.warn(
          `[Hedging] 🚨 EMERGENCY HEDGE (${lossPct.toFixed(1)}% loss): UNLIMITED MODE - using full available cash $${hedgeUsd.toFixed(2)}`,
        );
      } else {
        this.logger.info(
          `[Hedging] 📊 HEDGE SIZING: loss=${lossPct?.toFixed(1) ?? "?"}%, UNLIMITED MODE - using available cash $${hedgeUsd.toFixed(2)}`,
        );
      }
    } else {
      // Fallback to config limits if no budget tracking
      if (isEmergencyHedge) {
        hedgeUsd = this.config.allowExceedMax ? this.config.absoluteMaxUsd : this.config.maxHedgeUsd;
        this.logger.warn(
          `[Hedging] 🚨 EMERGENCY HEDGE (${lossPct.toFixed(1)}% loss): fallback to config limit $${hedgeUsd.toFixed(2)}`,
        );
      } else {
        hedgeUsd = this.config.allowExceedMax ? this.config.absoluteMaxUsd : Math.min(profitableHedgeUsd, this.config.maxHedgeUsd);
        this.logger.info(
          `[Hedging] 📊 HEDGE SIZING: loss=${lossPct?.toFixed(1) ?? "?"}%, fallback to config limit $${hedgeUsd.toFixed(2)}`,
        );
      }
    }

    // === BUDGET-AWARE SIZING ===
    // Apply sizing using per-cycle hedge budget (available cash)
    const operationLabel = isEmergencyHedge ? "EMERGENCY HEDGE" : "HEDGE";
    const reserveSizing = this.applyReserveAwareSizing(hedgeUsd, operationLabel);
    if (reserveSizing.skip) {
      return { success: false, reason: reserveSizing.reason };
    }
    hedgeUsd = reserveSizing.cappedUsd;

    // Log when reserve constraint affected emergency hedge sizing
    if (isEmergencyHedge && reserveSizing.isPartial) {
      this.logger.warn(
        `[Hedging] 🚨 EMERGENCY HEDGE constrained by reserves: ` +
          `targeting $${hedgeUsd.toFixed(2)} (reserve budget limited)`,
      );
    }

    // Check minimum
    if (hedgeUsd < this.config.minHedgeUsd) {
      this.logger.debug(
        `[Hedging] Hedge $${hedgeUsd.toFixed(2)} below min $${this.config.minHedgeUsd}`,
      );
      return { success: false, reason: "BELOW_MIN_HEDGE" };
    }

    // Calculate expected outcomes
    const hedgeShares = hedgeUsd / oppositePrice;
    const totalInvested = originalInvestment + hedgeUsd;
    const ifOriginalWins = position.size * 1.0 - totalInvested;
    const ifHedgeWins = hedgeShares * 1.0 - totalInvested;

    this.logger.info(
      `[Hedging] 🔄 HEDGING: Buy ${hedgeShares.toFixed(2)} ${oppositeSide} @ ${(oppositePrice * 100).toFixed(1)}¢ = $${hedgeUsd.toFixed(2)}` +
        `\n  If ${currentSide} wins: ${ifOriginalWins >= 0 ? "+" : ""}$${ifOriginalWins.toFixed(2)}` +
        `\n  If ${oppositeSide} wins: ${ifHedgeWins >= 0 ? "+" : ""}$${ifHedgeWins.toFixed(2)}`,
    );

    // Execute the hedge order
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[Hedging] No wallet - cannot hedge`);
      return { success: false, reason: "NO_WALLET" };
    }

    try {
      // Normalize the outcome to YES/NO for the order API (tokenId identifies the actual outcome)
      const orderOutcome = this.normalizeOutcomeForOrder(oppositeSide);

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: oppositeTokenId,
        outcome: orderOutcome,
        side: "BUY",
        sizeUsd: hedgeUsd,
        maxAcceptablePrice: oppositePrice * 1.02,
        logger: this.logger,
        skipDuplicatePrevention: true, // Hedges are intentional
        skipMinBuyPriceCheck: true, // Allow buying low-priced hedges
      });

      if (result.status === "submitted") {
        // Deduct from per-cycle hedge budget to prevent exceeding reserves
        this.deductFromCycleHedgeBudget(hedgeUsd);
        this.logger.info(`[Hedging] ✅ Hedge executed successfully`);

        // Send telegram notification for hedge placement
        void notifyHedge(
          position.marketId,
          oppositeTokenId,
          hedgeUsd / oppositePrice, // Estimate shares from USD
          oppositePrice,
          hedgeUsd,
          {
            outcome: oppositeSide,
          },
        ).catch(() => {
          // Ignore notification errors - logging is handled by the service
        });

        return { success: true, hedgeTokenId: oppositeTokenId };
      }

      // Check for partial fill - money was spent even though order didn't fully complete
      const filledUsd = result.filledAmountUsd;
      if (filledUsd && filledUsd > 0) {
        // Deduct partial fill from budget too
        this.deductFromCycleHedgeBudget(filledUsd);
        this.logger.warn(
          `[Hedging] ⚠️ Hedge partially filled: $${filledUsd.toFixed(2)} spent (order incomplete)`,
        );
        // Return partial fill info so caller can mark position as hedged
        // Include hedgeTokenId for paired tracking even on partial fill
        return {
          success: false,
          reason: result.reason ?? "ORDER_NOT_FILLED",
          filledAmountUsd: filledUsd,
          hedgeTokenId: oppositeTokenId,
        };
      }

      this.logger.warn(
        `[Hedging] ⚠️ Hedge order not filled: ${result.reason ?? "unknown"}`,
      );
      return { success: false, reason: result.reason ?? "ORDER_NOT_FILLED" };
    } catch (err) {
      this.logger.error(
        `[Hedging] ❌ Hedge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { success: false, reason: "HEDGE_ERROR" };
    }
  }

  /**
   * Normalize an outcome string to the OrderOutcome type expected by postOrder.
   *
   * IMPORTANT: The CLOB API uses tokenId (not outcome) to identify the specific
   * outcome token for order execution. The outcome field is primarily for logging
   * and internal bookkeeping. For non-YES/NO markets, we use "YES" as a placeholder
   * since the tokenId is what actually determines which side is being traded.
   *
   * @param outcome - The outcome string from the position (e.g., "YES", "NO", "Over", "Under", "Team A")
   * @returns "YES" or "NO" for the order API
   */
  private normalizeOutcomeForOrder(outcome: string): "YES" | "NO" {
    const upper = outcome.toUpperCase();
    if (upper === "YES" || upper === "NO") {
      return upper as "YES" | "NO";
    }
    // For non-YES/NO markets (Over/Under, Team A/Team B, etc.), we use "YES" as a
    // placeholder. The tokenId is what the CLOB API uses to identify the specific
    // outcome token - the outcome field is just metadata for logging.
    return "YES";
  }

  /**
   * Sell a position to stop losses
   * Supports all binary market types: YES/NO, Over/Under, Team A/Team B, etc.
   */
  private async sellPosition(position: Position): Promise<boolean> {
    const wallet = (this.client as { wallet?: Wallet }).wallet;
    if (!wallet) {
      this.logger.error(`[Hedging] No wallet - cannot sell`);
      return false;
    }

    // The execute() method already filters out positions without a side,
    // but check again as a safety measure
    if (!position.side || position.side.trim() === "") {
      this.logger.warn(
        `[Hedging] Position has no side defined - cannot sell (tokenId=${position.tokenId})`,
      );
      return false;
    }

    const currentValue = position.size * position.currentPrice;

    this.logger.info(
      `[Hedging] 💸 SELLING ${position.side} to salvage $${currentValue.toFixed(2)}`,
    );

    try {
      // Normalize the outcome for the order (tokenId is what matters for execution)
      const orderOutcome = this.normalizeOutcomeForOrder(position.side);

      // Use liberal slippage for liquidation - this is a "falling knife" scenario
      // where we need to exit and salvage whatever capital remains.
      // FALLING_KNIFE_SLIPPAGE_PCT (25%) is more liberal than normal sells but
      // still recovers meaningful value rather than accepting near-zero prices.
      const minPrice = calculateMinAcceptablePrice(position.currentPrice, FALLING_KNIFE_SLIPPAGE_PCT);

      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: orderOutcome,
        side: "SELL",
        sizeUsd: currentValue,
        // Use falling knife slippage (25%) for graceful exit
        minAcceptablePrice: minPrice,
        logger: this.logger,
        skipDuplicatePrevention: true,
        skipMinOrderSizeCheck: true, // Allow selling small positions during liquidation
      });

      if (result.status === "submitted") {
        this.logger.info(`[Hedging] ✅ Position sold`);

        // Calculate P&L for the trade
        const tradePnl = (position.currentPrice - position.entryPrice) * position.size;

        // Determine if this is a hedge exit or regular sell
        // Check if the position's tokenId was tracked as a hedge
        const isHedgeExit = this.hedgedPositions.has(position.tokenId);

        if (isHedgeExit) {
          // This is a hedge position being exited
          void notifyHedgeExit(
            position.marketId,
            position.tokenId,
            position.size,
            position.currentPrice,
            currentValue,
            {
              entryPrice: position.entryPrice,
              pnl: tradePnl,
              outcome: position.side,
            },
          ).catch(() => {
            // Ignore notification errors - logging is handled by the service
          });
        } else {
          // Regular position being sold (force liquidation or stop loss)
          void notifySell(
            position.marketId,
            position.tokenId,
            position.size,
            position.currentPrice,
            currentValue,
            {
              strategy: "Hedging",
              entryPrice: position.entryPrice,
              pnl: tradePnl,
              outcome: position.side,
            },
          ).catch(() => {
            // Ignore notification errors - logging is handled by the service
          });
        }

        return true;
      }

      this.logger.warn(
        `[Hedging] ⚠️ Sell not filled: ${result.reason ?? "unknown"}`,
      );
      return false;
    } catch (err) {
      this.logger.error(
        `[Hedging] ❌ Sell failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get the opposite token ID for hedging in any binary market.
   * Works for YES/NO, Over/Under, Team A/Team B, or any other two-outcome market.
   *
   * For binary markets, there are always exactly 2 tokens. We find the one
   * that is NOT the current position's token.
   *
   * @returns Object with tokenId and outcome name, or null if not found
   */
  private async getOppositeToken(
    marketId: string,
    currentTokenId: string,
  ): Promise<{ tokenId: string; outcome: string } | null> {
    try {
      const market = await this.client.getMarket(marketId);
      if (!market) return null;

      const tokens = (
        market as { tokens?: Array<{ token_id: string; outcome: string }> }
      ).tokens;
      // Ensure this is truly a binary market: must have exactly 2 tokens
      if (!tokens || tokens.length !== 2) return null;

      // For any binary market, find the token that is NOT the current one
      const oppositeToken = tokens.find((t) => t.token_id !== currentTokenId);

      if (!oppositeToken) return null;

      // Outcome should always be defined for valid market tokens.
      // If missing, log a warning but continue - the tokenId is what matters for execution.
      if (!oppositeToken.outcome) {
        this.logger.warn(
          `[Hedging] Opposite token has no outcome defined (marketId=${marketId}, tokenId=${oppositeToken.token_id})`,
        );
      }

      return {
        tokenId: oppositeToken.token_id,
        outcome: oppositeToken.outcome ?? "Unknown",
      };
    } catch {
      return null;
    }
  }

  /**
   * Clean up expired cooldown entries to prevent unbounded memory growth.
   *
   * This handles cases where positions are removed through other means
   * (e.g., sold externally, redeemed, manually removed) before their
   * cooldown expires. Without cleanup, entries would accumulate indefinitely.
   *
   * Strategy:
   * 1. Remove all entries with expired timestamps
   * 2. If still over max size, remove oldest entries
   */
  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    let expiredCount = 0;

    // First pass: remove all expired entries
    for (const [key, expiresAt] of this.failedLiquidationCooldowns) {
      if (now >= expiresAt) {
        this.failedLiquidationCooldowns.delete(key);
        expiredCount++;
      }
    }

    // Second pass: if still over max size, remove oldest entries
    if (
      this.failedLiquidationCooldowns.size >
      MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES
    ) {
      const entries = Array.from(this.failedLiquidationCooldowns.entries());
      // Sort by expiration time (oldest first)
      entries.sort((a, b) => a[1] - b[1]);

      const toRemove = entries.length - MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES;
      for (let i = 0; i < toRemove; i++) {
        this.failedLiquidationCooldowns.delete(entries[i][0]);
      }

      this.logger.debug(
        `[Hedging] Cleaned up ${expiredCount} expired + ${toRemove} oldest cooldown entries (max: ${MAX_FAILED_LIQUIDATION_COOLDOWN_ENTRIES})`,
      );
    } else if (expiredCount > 0) {
      this.logger.debug(
        `[Hedging] Cleaned up ${expiredCount} expired cooldown entries`,
      );
    }
  }

  /**
   * Get strategy stats
   */
  getStats(): {
    enabled: boolean;
    hedgedCount: number;
    failedLiquidationCooldownCount: number;
  } {
    return {
      enabled: this.config.enabled,
      hedgedCount: this.hedgedPositions.size,
      failedLiquidationCooldownCount: this.failedLiquidationCooldowns.size,
    };
  }

  /**
   * Get required reserve for hedging
   */
  getRequiredReserve(): number {
    if (!this.config.enabled) return 0;
    return this.config.allowExceedMax
      ? this.config.absoluteMaxUsd
      : this.config.maxHedgeUsd;
  }

  /**
   * Get positions that are candidates for liquidation when funds are insufficient.
   * This exposes the PositionTracker's liquidation candidates for external visibility
   * (e.g., for monitoring, debugging, or external fund management).
   *
   * Returns active losing positions that can be sold to free up funds for hedging,
   * sorted by worst loss first. Excludes positions that are already hedged or
   * in cooldown.
   *
   * @returns Array of positions suitable for liquidation, sorted by worst loss first
   */
  getLiquidationCandidates(): Position[] {
    const candidates = this.positionTracker.getLiquidationCandidates(
      this.config.triggerLossPct,
      this.config.minHoldSeconds,
    );

    // Exclude positions we've already hedged or that are in cooldown
    const now = Date.now();
    return candidates.filter((pos) => {
      const key = `${pos.marketId}-${pos.tokenId}`;

      // Skip if already hedged
      if (this.hedgedPositions.has(key)) {
        return false;
      }

      // Skip if in failed liquidation cooldown
      const cooldownUntil = this.failedLiquidationCooldowns.get(key);
      if (cooldownUntil && now < cooldownUntil) {
        return false;
      }

      return true;
    });
  }

  /**
   * Get the total USD value that could be recovered by liquidating losing positions.
   * This is useful for determining how much funds could potentially be freed up
   * for hedging operations when the wallet balance is insufficient.
   *
   * @returns Total USD value of liquidation candidates (current market value)
   */
  getLiquidationCandidatesValue(): number {
    const candidates = this.getLiquidationCandidates();
    return candidates.reduce(
      (total, pos) => total + pos.size * pos.currentPrice,
      0,
    );
  }
}
