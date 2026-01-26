import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import {
  LogDeduper,
  SKIP_LOG_TTL_MS,
  HIGH_VALUE_PRICE_THRESHOLD,
  HIGH_VALUE_NO_BID_LOG_TTL_MS,
} from "../utils/log-deduper.util";
import { notifySell } from "../services/trade-notification.service";
import { FALLING_KNIFE_SLIPPAGE_PCT } from "./constants";
import {
  postOrder,
  ABSOLUTE_MIN_TRADEABLE_PRICE,
} from "../utils/post-order.util";

export interface AutoSellConfig {
  enabled: boolean;
  threshold: number; // Price threshold to auto-sell (e.g., 0.99 = 99¢)
  minHoldSeconds: number; // Minimum time to hold before auto-selling (avoids conflict with endgame sweep)
  minOrderUsd: number; // Minimum order size in USD (from MIN_ORDER_USD env)
  /**
   * DISPUTE WINDOW EXIT SETTINGS
   * Positions near resolution ($0.99+) can get stuck in a 2-hour dispute window
   * Better to sell at 99.9¢ and free up capital than wait 2 hours for settlement
   *
   * When enabled, the strategy will:
   * 1. Look for positions at 99.9¢ or higher (dispute hold price)
   * 2. Sell immediately to exit without waiting for settlement
   * 3. This allows recycling capital faster instead of waiting for dispute resolution
   */
  disputeWindowExitEnabled?: boolean; // Enable early exit for positions in dispute window
  disputeWindowExitPrice?: number; // Price to sell at for dispute exit (default: 0.999 = 99.9¢)
  /**
   * STALE PROFITABLE POSITION EXIT SETTINGS
   * Positions that are profitable (green) but held for too long tie up capital
   * that could be used for more active trades. Rather than let capital sit idle
   * in positions that "aren't moving much", sell them to free up funds.
   *
   * When enabled (stalePositionHours > 0), the strategy will:
   * 1. Find profitable positions (pnlPct > 0) held longer than stalePositionHours
   * 2. Check if event expires soon (within staleExpiryHoldHours) - if so, HOLD for resolution
   * 3. If not expiring soon, sell them at current market price to lock in the profit
   * 4. Free up capital for new trading opportunities
   *
   * Set to 0 to disable stale position selling.
   * Default: 24 hours - positions in the green for 24+ hours are sold.
   */
  stalePositionHours?: number; // Hours before a profitable position is considered "stale" (0 = disabled)
  /**
   * EXPIRY-AWARE HOLD THRESHOLD
   * If a stale profitable position's market expires within this many hours,
   * HOLD the position instead of selling it. This is because:
   * - Holding to resolution may yield better returns (100% payout if winning)
   * - Selling now would forfeit potential profits from resolution
   * - Events expiring soon are worth waiting for rather than freeing capital
   *
   * This prevents selling a profitable position at 85¢ when the event resolves
   * in 12 hours and could pay out at $1.00. The capital efficiency loss from
   * waiting 12 hours is less than the ~15% profit loss from selling early.
   *
   * Set to 0 to disable expiry-aware holding (always sell stale positions).
   * Default: 48 hours - if event expires within 48 hours, hold for resolution
   */
  staleExpiryHoldHours?: number; // Hours before event expiry to hold instead of sell (0 = disabled)
  /**
   * QUICK WIN EXIT SETTINGS
   * Positions held for a short time with massive gains should be sold to lock in profit.
   * This targets positions that have spiked significantly in a short time window.
   *
   * Key differences from share price thresholds:
   * - Uses profit % based on purchase price (e.g., bought at 10¢, now 19¢ = 90% gain)
   * - Avoids conflicts with high-entry positions (e.g., bought at 80¢)
   * - Focuses on quick momentum wins rather than waiting for resolution
   *
   * When enabled (quickWinEnabled = true), the strategy will:
   * 1. Find positions held less than quickWinMaxHoldMinutes (default: 60 minutes)
   * 2. Check if profit % >= quickWinProfitPct (default: 90%)
   * 3. Sell immediately at current bid to lock in the quick gain
   *
   * Set quickWinEnabled to false to disable.
   * Default: Disabled (false) - opt-in feature via ENV variable
   */
  quickWinEnabled?: boolean; // Enable quick win exit (default: false)
  quickWinMaxHoldMinutes?: number; // Max hold time for quick win (default: 60 minutes)
  quickWinProfitPct?: number; // Profit % threshold for quick win (default: 90%)
  /**
   * OVERSIZED POSITION EXIT SETTINGS
   * Positions where invested USD exceeds a threshold (e.g., HEDGING_ABSOLUTE_MAX_USD)
   * are "oversized" and should be managed carefully to minimize losses or lock in gains.
   *
   * Strategy (in priority order):
   * 1. If position is now profitable (green), sell immediately to lock in gains
   * 2. If position is near breakeven (within tolerance), sell to exit at minimal loss
   * 3. If still losing and event is approaching (< N hours), force exit to avoid total loss
   *
   * When enabled, the strategy will:
   * 1. Find positions where invested USD exceeds oversizedExitThresholdUsd
   * 2. Check if position has turned profitable -> sell immediately
   * 3. Check if position is near breakeven (within tolerance %) -> sell to exit
   * 4. Check time to event (marketEndTime) -> if within hoursBeforeEvent and still losing, force exit
   *
   * Default: Disabled (false) - opt-in feature via ENV variable
   */
  oversizedExitEnabled?: boolean; // Enable oversized position exit (default: false)
  oversizedExitThresholdUsd?: number; // USD threshold - positions with invested value > this are "oversized" (default: uses HEDGING_ABSOLUTE_MAX_USD or 25)
  oversizedExitHoursBeforeEvent?: number; // Hours before event to force exit if still losing (default: 1)
  oversizedExitBreakevenTolerancePct?: number; // P&L % tolerance for "breakeven" sell (default: 2 = -2% to +2%)
}

/**
 * Default configuration for AutoSell strategy
 * - Enabled by default for capital efficiency
 * - Normal threshold at 99.9¢ (0.999)
 * - Dispute exit at 99.9¢ (0.999) for faster capital recovery
 * - Stale position exit at 24 hours for profitable positions
 * - Expiry-aware holding: hold if event expires within 48 hours
 * - Quick win exit disabled by default (opt-in feature)
 * - Oversized exit disabled by default (opt-in feature)
 */
export const DEFAULT_AUTO_SELL_CONFIG: AutoSellConfig = {
  enabled: true,
  threshold: 0.999, // Default near-resolution threshold (99.9¢)
  minHoldSeconds: 60, // Wait 60s before auto-selling to avoid conflict with endgame sweep
  minOrderUsd: 1, // Minimum $1 order size
  disputeWindowExitEnabled: true, // Enable dispute window exit
  disputeWindowExitPrice: 0.999, // Sell at 99.9¢ for dispute exit
  stalePositionHours: 24, // Sell profitable positions held for 24+ hours to free capital
  staleExpiryHoldHours: 48, // If event expires within 48 hours, hold for resolution instead of selling
  quickWinEnabled: false, // Disabled by default - opt-in via ENV
  quickWinMaxHoldMinutes: 60, // Quick win window: 1 hour
  quickWinProfitPct: 90, // Quick win threshold: 90% profit
  oversizedExitEnabled: false, // Disabled by default - opt-in via ENV
  oversizedExitThresholdUsd: 25, // Default: 25 USD (chosen to align with dynamic reserves hedgeCapUsd=25)
  oversizedExitHoursBeforeEvent: 1, // Default: exit 1 hour before event
  oversizedExitBreakevenTolerancePct: 2, // Default: +/- 2% considered breakeven
};

export interface AutoSellStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: AutoSellConfig;
}

/**
 * Skip reason tracking for logging
 */
interface SkipReasons {
  redeemable: number;
  notTradable: number;
  noBid: number;
  zeroPrice: number;
  belowThreshold: number;
  minHoldTime: number;
  alreadySold: number;
}

/**
 * Auto-Sell at High Price Strategy
 * Monitors owned positions approaching resolution
 * Automatically sells when price hits threshold (e.g., 99.6¢)
 * Only sells positions held longer than minHoldSeconds to avoid conflict with endgame sweep
 * Don't wait for 4pm UTC payout - free up capital immediately
 * Lose small amount per share but gain hours of capital availability
 *
 * FILTERING RULES:
 * 1. Only operates on ACTIVE (non-redeemable) positions
 * 2. Skips positions with executionStatus !== TRADABLE
 * 3. Skips positions with no bid price (currentBidPrice undefined)
 */
export class AutoSellStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: AutoSellConfig;
  private soldPositions: Set<string> = new Set();
  private positionFirstSeen: Map<string, number> = new Map();
  // Track tokens with no liquidity to suppress repeated warnings
  private noLiquidityTokens: Set<string> = new Set();

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();

  constructor(strategyConfig: AutoSellStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;

    if (this.config.enabled) {
      const disputeInfo = this.config.disputeWindowExitEnabled
        ? ` disputeExit=${(this.config.disputeWindowExitPrice ?? 0.999) * 100}¢`
        : "";
      const staleInfo = this.config.stalePositionHours && this.config.stalePositionHours > 0
        ? ` stalePositionHours=${this.config.stalePositionHours}`
        : "";
      const expiryHoldInfo = this.config.staleExpiryHoldHours && this.config.staleExpiryHoldHours > 0
        ? ` expiryHoldHours=${this.config.staleExpiryHoldHours}`
        : "";
      const quickWinInfo = this.config.quickWinEnabled
        ? ` quickWin=${this.config.quickWinMaxHoldMinutes}m@${this.config.quickWinProfitPct}%`
        : "";
      const oversizedInfo = this.config.oversizedExitEnabled
        ? ` oversizedExit=$${this.config.oversizedExitThresholdUsd}@${this.config.oversizedExitHoursBeforeEvent}h`
        : "";
      this.logger.info(
        `[AutoSell] Initialized: threshold=${(this.config.threshold * 100).toFixed(1)}¢ minHold=${this.config.minHoldSeconds}s${disputeInfo}${staleInfo}${quickWinInfo}${oversizedInfo}`,
      );
    }
  }

  /**
   * Execute the auto-sell strategy
   * Returns number of positions sold
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[AutoSell] Skipped - already in flight");
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
   * Internal execution logic
   */
  private async executeInternal(): Promise<number> {
    // Clean up stale entries
    this.cleanupStaleEntries();

    // Track skip reasons for aggregated logging
    const skipReasons: SkipReasons = {
      redeemable: 0,
      notTradable: 0,
      noBid: 0,
      zeroPrice: 0,
      belowThreshold: 0,
      minHoldTime: 0,
      alreadySold: 0,
    };

    let soldCount = 0;
    let scannedCount = 0;

    // === DISPUTE WINDOW EXIT (99.9¢) ===
    // Check for positions that can be sold at 99.9¢ to exit dispute hold
    // This takes priority over normal auto-sell since it frees capital immediately
    if (this.config.disputeWindowExitEnabled) {
      const disputeExitPrice = this.config.disputeWindowExitPrice ?? 0.999;
      const disputeExitPositions =
        this.positionTracker.getPositionsNearResolution(disputeExitPrice);

      for (const position of disputeExitPositions) {
        scannedCount++;
        const sold = await this.processPosition(
          position,
          skipReasons,
          true, // isDisputeExit
        );
        if (sold) {
          soldCount++;
        }
      }
    }

    // === STANDARD AUTO-SELL (normal threshold) ===
    // Get positions near resolution (price >= threshold)
    const nearResolutionPositions =
      this.positionTracker.getPositionsNearResolution(this.config.threshold);

    for (const position of nearResolutionPositions) {
      scannedCount++;
      const sold = await this.processPosition(
        position,
        skipReasons,
        false, // isDisputeExit
      );
      if (sold) {
        soldCount++;
      }
    }

    // === STALE PROFITABLE POSITION EXIT ===
    // Sell profitable positions held longer than stalePositionHours to free up capital
    // These are positions that are "in the green" but not moving much, tying up capital
    // that could be used for more active trades.
    let staleSoldCount = 0;
    const staleHours = this.config.stalePositionHours ?? 0;
    if (staleHours > 0) {
      const staleProfitablePositions =
        this.getStaleProfitablePositions(staleHours);

      for (const position of staleProfitablePositions) {
        scannedCount++;
        const sold = await this.processStalePosition(position);
        if (sold) {
          soldCount++;
          staleSoldCount++;
        }
      }
    }

    // === QUICK WIN EXIT ===
    // Sell positions held less than quickWinMaxHoldMinutes with massive gains (>quickWinProfitPct%)
    // This locks in quick momentum wins before they reverse.
    // Key feature: Uses profit % based on purchase price, not share price,
    // avoiding conflicts with positions bought in the "overly confident zone" (e.g., 80¢+)
    let quickWinSoldCount = 0;
    if (this.config.quickWinEnabled) {
      const quickWinPositions = this.getQuickWinPositions(
        this.config.quickWinMaxHoldMinutes ?? 60,
        this.config.quickWinProfitPct ?? 90,
      );

      for (const position of quickWinPositions) {
        scannedCount++;
        const sold = await this.processQuickWinPosition(position);
        if (sold) {
          soldCount++;
          quickWinSoldCount++;
        }
      }
    }

    // === OVERSIZED POSITION EXIT ===
    // Sell positions where invested USD exceeds oversizedExitThresholdUsd
    // Priority: 1) Sell if profitable, 2) Sell at breakeven, 3) Force exit before event
    // This prevents positions from exceeding HEDGING_ABSOLUTE_MAX_USD limits
    let oversizedSoldCount = 0;
    if (this.config.oversizedExitEnabled) {
      const oversizedPositions = this.getOversizedPositions(
        this.config.oversizedExitThresholdUsd ?? 25,
      );

      for (const position of oversizedPositions) {
        scannedCount++;
        const sold = await this.processOversizedPosition(position);
        if (sold) {
          soldCount++;
          oversizedSoldCount++;
        }
      }
    }

    // Log once-per-cycle summary
    const staleInfo = staleHours > 0 ? ` stale_sold=${staleSoldCount}` : "";
    const quickWinInfo = this.config.quickWinEnabled
      ? ` quick_win_sold=${quickWinSoldCount}`
      : "";
    const oversizedInfo = this.config.oversizedExitEnabled
      ? ` oversized_sold=${oversizedSoldCount}`
      : "";
    this.logger.info(
      `[AutoSell] scanned=${scannedCount} sold=${soldCount}${staleInfo}${quickWinInfo}${oversizedInfo} skipped_redeemable=${skipReasons.redeemable} skipped_not_tradable=${skipReasons.notTradable} skipped_no_bid=${skipReasons.noBid} skipped_zero_price=${skipReasons.zeroPrice}`,
    );

    // Log aggregated skip summary (rate-limited DEBUG)
    this.logSkipSummary(skipReasons);

    return soldCount;
  }

  /**
   * Check if position is tradable (not redeemable, has valid execution status)
   * Returns skip reason if not tradable, or null if tradable
   *
   * IMPORTANT (Jan 2025): Only skip REDEEMABLE if there's actual proof from
   * on-chain (ONCHAIN_DENOM) or Data API verified (DATA_API_FLAG).
   *
   * Positions with DATA_API_UNCONFIRMED are NOT skipped - they remain eligible
   * for AutoSell because Data API says redeemable but on-chain payoutDenominator == 0.
   * This allows selling positions at 99.9-100¢ when live bids exist.
   */
  private checkTradability(
    position: Position,
  ): "REDEEMABLE" | "NOT_TRADABLE" | "NO_BID" | "ZERO_PRICE" | null {
    // Filter 1: Skip REDEEMABLE positions ONLY if there's verified proof
    // Trust on-chain resolution (ONCHAIN_DENOM) or verified API flag (DATA_API_FLAG)
    // Don't skip if proofSource is DATA_API_UNCONFIRMED or NONE (can still sell)
    const hasVerifiedRedeemableProof =
      position.redeemableProofSource === "ONCHAIN_DENOM" ||
      position.redeemableProofSource === "DATA_API_FLAG";

    if (hasVerifiedRedeemableProof) {
      return "REDEEMABLE";
    }

    // Filter 2: Skip positions with invalid execution status
    if (
      position.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
      position.executionStatus === "EXECUTION_BLOCKED"
    ) {
      return "NOT_TRADABLE";
    }

    // Filter 3: Skip positions with no bid (can't sell)
    if (position.currentBidPrice === undefined) {
      return "NO_BID";
    }

    // Filter 4: Skip positions with zero/near-zero price (economically worthless)
    // Don't attempt to sell positions at or below ABSOLUTE_MIN_TRADEABLE_PRICE (0.10¢)
    // These positions are essentially worthless and the sell would be blocked anyway
    const currentPrice = position.currentBidPrice ?? position.currentPrice;
    if (currentPrice <= ABSOLUTE_MIN_TRADEABLE_PRICE) {
      return "ZERO_PRICE";
    }

    return null; // Position is tradable
  }

  /**
   * Process a single position for auto-sell
   * @returns true if position was sold
   */
  private async processPosition(
    position: Position,
    skipReasons: SkipReasons,
    isDisputeExit: boolean,
  ): Promise<boolean> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const tokenIdShort = position.tokenId.slice(0, 12);

    // Skip if already sold
    if (this.soldPositions.has(positionKey)) {
      skipReasons.alreadySold++;
      return false;
    }

    // Check tradability (redeemable, execution status, bid availability)
    const tradabilityIssue = this.checkTradability(position);
    if (tradabilityIssue) {
      // Build diagnostic info for logging: currentPrice, currentBidPrice, executionStatus in one line
      const currentPriceCents = (position.currentPrice * 100).toFixed(1);
      const bidPriceCents =
        position.currentBidPrice !== undefined
          ? (position.currentBidPrice * 100).toFixed(1)
          : "N/A";
      const execStatus = position.executionStatus ?? "unknown";
      const diagInfo = `currentPrice=${currentPriceCents}¢ currentBidPrice=${bidPriceCents}¢ executionStatus=${execStatus}`;

      switch (tradabilityIssue) {
        case "REDEEMABLE":
          skipReasons.redeemable++;
          this.logSkipOnce(
            `REDEEMABLE:${tokenIdShort}`,
            `[AutoSell] skip tokenId=${tokenIdShort}... reason=REDEEMABLE proofSource=${position.redeemableProofSource ?? "unknown"} (route to AutoRedeem) ${diagInfo}`,
          );
          break;
        case "NOT_TRADABLE":
          skipReasons.notTradable++;
          this.logSkipOnce(
            `NOT_TRADABLE:${tokenIdShort}`,
            `[AutoSell] skip tokenId=${tokenIdShort}... reason=NOT_TRADABLE ${diagInfo} bookStatus=${position.bookStatus ?? "unknown"}`,
          );
          break;
        case "NO_BID":
          skipReasons.noBid++;
          // For near-resolution positions (>= HIGH_VALUE_PRICE_THRESHOLD), log at INFO level
          // since this represents potentially stuck capital that users need to know about
          {
            const isHighValue =
              position.currentPrice >= HIGH_VALUE_PRICE_THRESHOLD;
            const bookStatusInfo = position.bookStatus ?? "UNKNOWN";
            const noBidMessage =
              `[AutoSell] ⚠️ NO_BID: tokenId=${tokenIdShort}... ${diagInfo} bookStatus=${bookStatusInfo}` +
              (isHighValue
                ? ` — Position at ${currentPriceCents}¢ cannot be sold via CLOB (no orderbook bids). ` +
                  `Check if market is in dispute window or orderbook is temporarily unavailable.`
                : ` (cannot sell without bid)`);

            if (isHighValue) {
              // Log at INFO for high-value positions so users see why their capital is stuck
              // Rate-limited with shorter TTL to ensure visibility while avoiding spam
              if (
                this.logDeduper.shouldLog(
                  `AutoSell:NO_BID_HIGH_VALUE:${tokenIdShort}`,
                  HIGH_VALUE_NO_BID_LOG_TTL_MS,
                )
              ) {
                this.logger.info(noBidMessage);
              }
            } else {
              this.logSkipOnce(`NO_BID:${tokenIdShort}`, noBidMessage);
            }
          }
          break;
        case "ZERO_PRICE":
          skipReasons.zeroPrice++;
          this.logSkipOnce(
            `ZERO_PRICE:${tokenIdShort}`,
            `[AutoSell] skip tokenId=${tokenIdShort}... reason=ZERO_PRICE ${diagInfo} — Position price ≤ ${(ABSOLUTE_MIN_TRADEABLE_PRICE * 100).toFixed(2)}¢ (economically worthless, not worth selling)`,
          );
          break;
      }
      return false;
    }

    // For dispute exit, skip min hold time check
    if (!isDisputeExit) {
      // Track first seen time
      if (!this.positionFirstSeen.has(positionKey)) {
        this.positionFirstSeen.set(positionKey, Date.now());
        skipReasons.minHoldTime++;
        return false; // Don't sell on first detection
      }

      // Check minimum hold time (avoids conflict with endgame sweep)
      const holdTimeSeconds =
        (Date.now() - this.positionFirstSeen.get(positionKey)!) / 1000;
      if (holdTimeSeconds < this.config.minHoldSeconds) {
        skipReasons.minHoldTime++;
        this.logger.debug(
          `[AutoSell] Position ${position.marketId.slice(0, 16)}... held for ${holdTimeSeconds.toFixed(0)}s, waiting for ${this.config.minHoldSeconds}s`,
        );
        return false;
      }
    }

    // All checks passed - attempt to sell
    const priceLabel = isDisputeExit ? "DISPUTE EXIT" : "NEAR_RESOLUTION";
    this.logger.info(
      `[AutoSell] ${priceLabel}: Selling position at ${(position.currentPrice * 100).toFixed(1)}¢: tokenId=${tokenIdShort}... marketId=${position.marketId.slice(0, 16)}...`,
    );

    try {
      const sold = await this.executeSell(position, "AutoSell");

      if (sold) {
        this.soldPositions.add(positionKey);

        // Calculate and log capital recovery
        const lossPerShare = 1.0 - position.currentPrice;
        const totalLoss = lossPerShare * position.size;
        const freedCapital = position.size * position.currentPrice;

        if (isDisputeExit) {
          this.logger.info(
            `[AutoSell] ✅ DISPUTE EXIT: Freed $${freedCapital.toFixed(2)} capital (cost: $${totalLoss.toFixed(3)} to avoid dispute hold wait)`,
          );
        } else {
          const feeCost = position.size * 0.002; // 0.2% round-trip fees
          const totalCost = totalLoss + feeCost;
          this.logger.info(
            `[AutoSell] ✅ Freed $${freedCapital.toFixed(2)} capital (cost: $${totalLoss.toFixed(2)} + $${feeCost.toFixed(2)} fees = $${totalCost.toFixed(2)} total)`,
          );
        }
        return true;
      }
    } catch (err) {
      this.logger.error(
        `[AutoSell] Failed to sell position ${position.marketId.slice(0, 16)}...`,
        err as Error,
      );
    }

    return false;
  }

  /**
   * Get profitable positions that have been held longer than staleHours
   * These are positions "in the green" (pnlPct > 0) that aren't moving much
   * and are tying up capital that could be used elsewhere.
   *
   * EXPIRY-AWARE LOGIC (Trading Bot vs Holding Bot):
   * If staleExpiryHoldHours > 0 and the market expires within that window,
   * we SKIP the position (hold for resolution) instead of selling it.
   * This is because:
   * - Resolution may yield $1.00 vs selling at 85¢ now
   * - Short wait times are worth the potential upside
   * - This is a trading bot, but smart trading means knowing when to hold
   *
   * @param staleHours - Number of hours after which a profitable position is considered stale
   * @returns Array of stale profitable positions (excluding those expiring soon)
   */
  private getStaleProfitablePositions(staleHours: number): Position[] {
    const positions = this.positionTracker.getPositions();
    const staleThresholdMs = staleHours * 60 * 60 * 1000; // Convert hours to milliseconds
    const now = Date.now();
    
    // Expiry-aware hold threshold (default 48 hours)
    const expiryHoldHours = this.config.staleExpiryHoldHours ?? 48;
    const expiryHoldMs = expiryHoldHours * 60 * 60 * 1000;

    return positions.filter((pos) => {
      // Must be profitable (green)
      if (!pos.pnlTrusted || pos.pnlPct <= 0) {
        return false;
      }

      // Must have entry time info from trade history
      if (pos.firstAcquiredAt === undefined || pos.timeHeldSec === undefined) {
        return false;
      }

      // Entry metadata must be trusted to use timestamps for stale detection
      // When entryMetaTrusted === false, trade history doesn't match live shares,
      // so firstAcquiredAt/timeHeldSec may be inaccurate and a recent position
      // could be incorrectly identified as 24+ hours old.
      if (pos.entryMetaTrusted === false) {
        return false;
      }

      // Check if held longer than staleHours
      const heldMs = now - pos.firstAcquiredAt;
      if (heldMs < staleThresholdMs) {
        return false;
      }

      // === EXPIRY-AWARE HOLD LOGIC ===
      // If event expires within expiryHoldHours, HOLD for resolution instead of selling
      // This prevents selling a profitable position (e.g., 85¢) when waiting for
      // resolution (potential $1.00 payout) is the smarter play.
      if (expiryHoldHours > 0 && pos.marketEndTime !== undefined) {
        const timeToExpiryMs = pos.marketEndTime - now;
        if (timeToExpiryMs > 0 && timeToExpiryMs <= expiryHoldMs) {
          // Event expires soon - hold for resolution
          const hoursToExpiry = timeToExpiryMs / (60 * 60 * 1000);
          const posKey = `${pos.marketId}-${pos.tokenId}`;
          // Log once per position per expiry window (rate-limited by LogDeduper)
          if (this.logDeduper.shouldLog(`stale_expiry_hold:${posKey}`, 60 * 60 * 1000)) {
            this.logger.info(
              `[AutoSell] EXPIRY_HOLD: Skipping stale position (${hoursToExpiry.toFixed(1)}h to expiry, hold threshold=${expiryHoldHours}h) - waiting for resolution may be more profitable`,
            );
          }
          return false;
        }
      }

      // Must have a valid bid price to sell
      if (pos.currentBidPrice === undefined) {
        return false;
      }

      // Skip already sold positions
      const positionKey = `${pos.marketId}-${pos.tokenId}`;
      if (this.soldPositions.has(positionKey)) {
        return false;
      }

      // Skip if not tradable
      const tradabilityIssue = this.checkTradability(pos);
      if (tradabilityIssue) {
        return false;
      }

      return true;
    });
  }

  /**
   * Process a stale profitable position for selling
   * These are positions that are profitable but have been held too long,
   * tying up capital that could be used for more active trades.
   *
   * @param position - The stale profitable position to sell
   * @returns true if position was sold
   */
  private async processStalePosition(position: Position): Promise<boolean> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const tokenIdShort = position.tokenId.slice(0, 12);

    // Calculate time held in hours
    const timeHeldHours = (position.timeHeldSec ?? 0) / 3600;
    const timeHeldDays = timeHeldHours / 24;

    // Log the stale position detection
    const timeHeldStr =
      timeHeldDays >= 1
        ? `${timeHeldDays.toFixed(1)}d`
        : `${timeHeldHours.toFixed(1)}h`;

    this.logger.info(
      `[AutoSell] STALE_PROFITABLE: Position held ${timeHeldStr} at +${position.pnlPct.toFixed(1)}% profit: tokenId=${tokenIdShort}... marketId=${position.marketId.slice(0, 16)}...`,
    );

    try {
      // Use unified executeSell method that follows hedging/stop-loss methodology
      const sold = await this.executeSell(position, "AutoSell (Stale)");

      if (sold) {
        this.soldPositions.add(positionKey);

        // Calculate and log profit captured based on actual realized P&L
        const profitUsd = position.pnlUsd;
        const freedCapital =
          position.size * (position.currentBidPrice ?? position.currentPrice);

        this.logger.info(
          `[AutoSell] ✅ STALE_PROFITABLE: Sold position held ${timeHeldStr}, realized profit $${profitUsd.toFixed(2)} (+${position.pnlPct.toFixed(1)}%), freed $${freedCapital.toFixed(2)} capital for new trades`,
        );
        return true;
      }
    } catch (err) {
      this.logger.error(
        `[AutoSell] Failed to sell stale position ${position.marketId.slice(0, 16)}...`,
        err as Error,
      );
    }

    return false;
  }

  /**
   * Unified sell method that follows the same methodology as hedging/stop-loss.
   *
   * Uses the same approach as hedging's sellPosition():
   * - Uses position's currentBidPrice/currentPrice (no manual orderbook fetch)
   * - postOrder() handles orderbook validation internally (single source of truth)
   * - Uses FALLING_KNIFE_SLIPPAGE_PCT (25%) for reliable fills
   * - Uses skipMinOrderSizeCheck: true to allow liquidating small positions
   *
   * @param position - The position to sell
   * @param strategyLabel - Label for logging (e.g., "AutoSell", "AutoSell (Stale)")
   * @returns true if order was submitted successfully
   */
  private async executeSell(
    position: Position,
    strategyLabel: string,
  ): Promise<boolean> {
    try {
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      // Use position's currentBidPrice or currentPrice (same as hedging)
      // No manual orderbook fetch - let postOrder() handle validation
      const currentPrice = position.currentBidPrice ?? position.currentPrice;
      const sizeUsd = position.size * currentPrice;

      // Calculate P&L info for logging
      const entryPrice = position.entryPrice;
      const expectedProfit = (currentPrice - entryPrice) * position.size;
      const profitPct =
        entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      // FIX (Jan 2025): Use sellSlippagePct to compute minAcceptablePrice from FRESH
      // orderbook data that postOrder fetches, rather than stale cached prices.
      // This prevents "Sale blocked" errors when the actual market price has dropped
      // below the cached position price.

      this.logger.info(
        `[AutoSell] Executing ${strategyLabel} sell: ${position.size.toFixed(2)} shares at ~${(currentPrice * 100).toFixed(1)}¢ ` +
          `(entry: ${(entryPrice * 100).toFixed(1)}¢, expected P&L: $${expectedProfit.toFixed(2)} / ${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(1)}%)`,
      );

      // Execute sell using same pattern as hedging's sellPosition()
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId: position.marketId,
        tokenId: position.tokenId,
        outcome: this.normalizeOutcomeForOrder(position.side),
        side: "SELL",
        sizeUsd,
        // FALLING_KNIFE_SLIPPAGE_PCT (25%) for reliable fills, computed from fresh orderbook
        sellSlippagePct: FALLING_KNIFE_SLIPPAGE_PCT,
        logger: this.logger,
        skipDuplicatePrevention: true, // Required for exits
        skipMinOrderSizeCheck: true, // Allow selling small positions - same as hedging
      });

      if (result.status === "submitted") {
        this.logger.info(
          `[AutoSell] ✓ ${strategyLabel} sell submitted: ${position.size.toFixed(2)} shares, expected P&L $${expectedProfit.toFixed(2)}`,
        );

        // Send telegram notification
        const tradePnl = (currentPrice - position.entryPrice) * position.size;
        void notifySell(
          position.marketId,
          position.tokenId,
          position.size,
          currentPrice,
          sizeUsd,
          {
            strategy: strategyLabel,
            entryPrice: position.entryPrice,
            pnl: tradePnl,
            outcome: position.side,
          },
        ).catch(() => {
          // Ignore notification errors
        });

        return true;
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[AutoSell] ${strategyLabel} sell skipped: ${result.reason ?? "unknown reason"}`,
        );
        return false;
      } else if (result.reason === "FOK_ORDER_KILLED") {
        this.logger.warn(
          `[AutoSell] ⚠️ ${strategyLabel} sell not filled (FOK killed) - market has insufficient liquidity`,
        );
        return false;
      } else {
        this.logger.error(
          `[AutoSell] ${strategyLabel} sell failed: ${result.reason ?? "unknown reason"}`,
        );
        throw new Error(
          `${strategyLabel} sell failed: ${result.reason ?? "unknown"}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[AutoSell] Failed to execute ${strategyLabel} sell: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Normalize an outcome string to the OrderOutcome type expected by postOrder.
   *
   * For YES/NO binary markets, returns the uppercase string "YES" or "NO".
   * For other market types (Over/Under, Team A/Team B, etc.), returns "YES"
   * as a placeholder since the tokenId is what actually identifies the outcome.
   *
   * @param outcome - The outcome string from the position
   * @returns "YES" or "NO" for the order API
   */
  private normalizeOutcomeForOrder(outcome: string | undefined): "YES" | "NO" {
    if (!outcome) return "YES";
    const upper = outcome.toUpperCase();
    if (upper === "YES" || upper === "NO") {
      return upper as "YES" | "NO";
    }
    // For non-YES/NO markets, tokenId identifies the outcome - use "YES" as placeholder
    return "YES";
  }

  /**
   * Log skip reason once per TTL (rate-limited DEBUG)
   */
  private logSkipOnce(key: string, message: string): void {
    if (this.logDeduper.shouldLog(`AutoSell:${key}`, SKIP_LOG_TTL_MS)) {
      this.logger.debug(message);
    }
  }

  /**
   * Log aggregated skip summary (rate-limited DEBUG)
   */
  private logSkipSummary(reasons: SkipReasons): void {
    const total =
      reasons.redeemable +
      reasons.notTradable +
      reasons.noBid +
      reasons.zeroPrice +
      reasons.belowThreshold +
      reasons.minHoldTime +
      reasons.alreadySold;

    if (total === 0) {
      return;
    }

    // Create fingerprint for change detection
    const fingerprint = `${reasons.redeemable},${reasons.notTradable},${reasons.noBid},${reasons.zeroPrice}`;

    // Log only if fingerprint changed or TTL expired
    if (
      this.logDeduper.shouldLog(
        "AutoSell:skip_summary",
        SKIP_LOG_TTL_MS,
        fingerprint,
      )
    ) {
      const parts: string[] = [];
      if (reasons.redeemable > 0)
        parts.push(`redeemable=${reasons.redeemable}`);
      if (reasons.notTradable > 0)
        parts.push(`not_tradable=${reasons.notTradable}`);
      if (reasons.noBid > 0) parts.push(`no_bid=${reasons.noBid}`);
      if (reasons.zeroPrice > 0) parts.push(`zero_price=${reasons.zeroPrice}`);
      if (reasons.belowThreshold > 0)
        parts.push(`below_threshold=${reasons.belowThreshold}`);
      if (reasons.minHoldTime > 0)
        parts.push(`min_hold_time=${reasons.minHoldTime}`);
      if (reasons.alreadySold > 0)
        parts.push(`already_sold=${reasons.alreadySold}`);

      this.logger.debug(`[AutoSell] Skipped: ${parts.join(", ")}`);
    }
  }

  /**
   * Get positions eligible for quick win exit
   * These are positions held for a short time with massive gains (>90% by default)
   *
   * Key feature: Uses profit % based on purchase price, not share price
   * Example: Bought at 10¢, now 19¢ = 90% gain → eligible for quick win
   * This avoids conflicts with positions bought at high prices (e.g., 80¢)
   *
   * @param maxHoldMinutes - Maximum hold time in minutes (default: 60)
   * @param minProfitPct - Minimum profit percentage (default: 90)
   * @returns Array of quick win positions
   */
  private getQuickWinPositions(
    maxHoldMinutes: number,
    minProfitPct: number,
  ): Position[] {
    const positions = this.positionTracker.getPositions();
    const maxHoldMs = maxHoldMinutes * 60 * 1000; // Convert minutes to milliseconds
    const now = Date.now();
    const filtered: Position[] = [];

    for (const pos of positions) {
      const posKey = `${pos.marketId}-${pos.tokenId}`;

      // Must be profitable (green)
      if (!pos.pnlTrusted || pos.pnlPct <= 0) {
        this.logger.debug(
          `[AutoSell] Quick Win: Skipping ${posKey.slice(0, 20)}... - not profitable or P&L untrusted`,
        );
        continue;
      }

      // Must exceed minimum profit threshold
      if (pos.pnlPct < minProfitPct) {
        continue; // Silent skip - most positions won't meet this threshold
      }

      // Must have entry time info from trade history
      if (pos.firstAcquiredAt === undefined || pos.timeHeldSec === undefined) {
        this.logger.debug(
          `[AutoSell] Quick Win: Skipping ${posKey.slice(0, 20)}... - no entry time info`,
        );
        continue;
      }

      // Entry metadata must be trusted to use timestamps for hold time
      // When entryMetaTrusted === false, trade history doesn't match live shares,
      // so firstAcquiredAt/timeHeldSec may be inaccurate
      if (pos.entryMetaTrusted === false) {
        this.logger.debug(
          `[AutoSell] Quick Win: Skipping ${posKey.slice(0, 20)}... - entry metadata not trusted`,
        );
        continue;
      }

      // Check if held LESS than maxHoldMinutes
      const heldMs = now - pos.firstAcquiredAt;
      if (heldMs >= maxHoldMs) {
        continue; // Silent skip - most profitable positions will be held longer
      }

      // Must have a valid bid price to sell
      if (pos.currentBidPrice === undefined) {
        this.logger.debug(
          `[AutoSell] Quick Win: Skipping ${posKey.slice(0, 20)}... - no bid price`,
        );
        continue;
      }

      // Skip already sold positions
      if (this.soldPositions.has(posKey)) {
        continue;
      }

      // Skip if not tradable
      const tradabilityIssue = this.checkTradability(pos);
      if (tradabilityIssue) {
        this.logger.debug(
          `[AutoSell] Quick Win: Skipping ${posKey.slice(0, 20)}... - tradability issue: ${tradabilityIssue}`,
        );
        continue;
      }

      filtered.push(pos);
    }

    return filtered;
  }

  /**
   * Process a quick win position for selling
   * These are positions with massive gains in a short time window
   * that should be sold to lock in the profit before momentum reverses.
   *
   * SLIPPAGE NOTE: Uses executeSell() which applies FALLING_KNIFE_SLIPPAGE_PCT (25%).
   * This is appropriate because:
   * 1. Quick wins have 90%+ gains, so 25% slippage still leaves significant profit
   * 2. Matches the hedging/stop-loss methodology for reliable fills
   * 3. The goal is to lock in profit quickly, not optimize for the last few cents
   *
   * @param position - The quick win position to sell
   * @returns true if position was sold
   */
  private async processQuickWinPosition(position: Position): Promise<boolean> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const tokenIdShort = position.tokenId.slice(0, 12);

    // Calculate time held in minutes
    const timeHeldMinutes = (position.timeHeldSec ?? 0) / 60;

    // Log the quick win detection
    this.logger.info(
      `[AutoSell] QUICK_WIN: Position held ${timeHeldMinutes.toFixed(1)}m at +${position.pnlPct.toFixed(1)}% profit: tokenId=${tokenIdShort}... marketId=${position.marketId.slice(0, 16)}...`,
    );

    try {
      // Use unified executeSell method that follows hedging/stop-loss methodology
      // For quick wins with 90%+ gains, slippage is acceptable to ensure order fills
      const sold = await this.executeSell(position, "AutoSell (Quick Win)");

      if (sold) {
        this.soldPositions.add(positionKey);

        // NOTE: These values reflect pre-trade state and may differ from actual realized P&L
        // due to slippage. Actual fill price may vary by up to 3% from currentBidPrice.
        const estimatedProfitUsd = position.pnlUsd;
        const estimatedCapital =
          position.size * (position.currentBidPrice ?? position.currentPrice);
        const bestBid = position.currentBidPrice ?? position.currentPrice;
        const sizeUsd = position.size * bestBid;

        // Send distinct notification for quick win exits (not stale position exits)
        const tradePnl = (bestBid - position.entryPrice) * position.size;
        void notifySell(
          position.marketId,
          position.tokenId,
          position.size,
          bestBid,
          sizeUsd,
          {
            strategy: "AutoSell (Quick Win)",
            entryPrice: position.entryPrice,
            pnl: tradePnl,
            outcome: position.side,
          },
        ).catch(() => {
          // Ignore notification errors
        });

        this.logger.info(
          `[AutoSell] ✅ QUICK_WIN: Sold position held ${timeHeldMinutes.toFixed(1)}m, estimated profit $${estimatedProfitUsd.toFixed(2)} (+${position.pnlPct.toFixed(1)}%), freed ~$${estimatedCapital.toFixed(2)} capital (actual fill may vary by slippage)`,
        );
        return true;
      }
    } catch (err) {
      this.logger.error(
        `[AutoSell] Failed to sell quick win position ${position.marketId.slice(0, 16)}...`,
        err as Error,
      );
    }

    return false;
  }

  /**
   * Get positions that are "oversized" - invested USD exceeds threshold
   * These are positions we want to evaluate for potential exit based on
   * their P&L status and time to event.
   *
   * Note: Returns ALL oversized positions regardless of P&L status.
   * The exit decision (profit/breakeven/event-approaching) is made by
   * processOversizedPosition() using getOversizedExitReason().
   *
   * @param thresholdUsd - USD threshold - positions with invested value > this are "oversized"
   * @returns Array of oversized positions (both profitable and losing)
   */
  private getOversizedPositions(thresholdUsd: number): Position[] {
    const positions = this.positionTracker.getPositions();
    const filtered: Position[] = [];

    for (const pos of positions) {
      const posKey = `${pos.marketId}-${pos.tokenId}`;

      // Skip already sold positions
      if (this.soldPositions.has(posKey)) {
        continue;
      }

      // Skip if not tradable
      const tradabilityIssue = this.checkTradability(pos);
      if (tradabilityIssue) {
        continue;
      }

      // Must have a valid bid price to sell
      if (pos.currentBidPrice === undefined) {
        continue;
      }

      // Calculate invested value (what we paid for the position)
      // size * entryPrice gives us the original investment in USD
      const investedUsd = pos.size * pos.entryPrice;

      // Check if position is "oversized" - invested value exceeds threshold
      if (investedUsd <= thresholdUsd) {
        continue;
      }

      // P&L must be trusted to make decisions
      if (!pos.pnlTrusted) {
        this.logger.debug(
          `[AutoSell] Oversized: Skipping ${posKey.slice(0, 20)}... - P&L not trusted`,
        );
        continue;
      }

      filtered.push(pos);
    }

    return filtered;
  }

  /**
   * Determine the exit strategy for an oversized position
   *
   * Returns the reason for exit or null if should not exit yet:
   * - "PROFITABLE": Position is now profitable (green) - sell immediately
   * - "BREAKEVEN": Position is near breakeven - sell to exit at minimal loss
   * - "EVENT_APPROACHING": Event is approaching and still losing - force exit
   * - null: Don't exit yet (wait for better opportunity)
   */
  private getOversizedExitReason(
    position: Position,
  ): "PROFITABLE" | "BREAKEVEN" | "EVENT_APPROACHING" | null {
    const tolerancePct = this.config.oversizedExitBreakevenTolerancePct ?? 2;
    const hoursBeforeEvent = this.config.oversizedExitHoursBeforeEvent ?? 1;

    // Priority 1: If profitable (green), sell immediately
    if (position.pnlPct > 0) {
      return "PROFITABLE";
    }

    // Priority 2: If near breakeven (within tolerance), sell to exit
    if (Math.abs(position.pnlPct) <= tolerancePct) {
      return "BREAKEVEN";
    }

    // Priority 3: Check if event is approaching
    // If we're still red but event is within hoursBeforeEvent, force exit
    const now = Date.now();
    if (position.marketEndTime && position.marketEndTime > now) {
      const msBeforeEvent = position.marketEndTime - now;
      const hoursRemaining = msBeforeEvent / (60 * 60 * 1000);

      if (hoursRemaining <= hoursBeforeEvent) {
        return "EVENT_APPROACHING";
      }
    }

    // Don't exit yet - wait for better opportunity
    return null;
  }

  /**
   * Process an oversized position for selling
   * Uses tiered exit strategy based on position state:
   * 1. Profitable -> sell immediately
   * 2. Breakeven -> sell to minimize loss
   * 3. Event approaching -> force exit
   *
   * @param position - The oversized position to potentially sell
   * @returns true if position was sold
   */
  private async processOversizedPosition(position: Position): Promise<boolean> {
    const positionKey = `${position.marketId}-${position.tokenId}`;
    const tokenIdShort = position.tokenId.slice(0, 12);

    // Calculate invested value
    const investedUsd = position.size * position.entryPrice;

    // Determine exit reason
    const exitReason = this.getOversizedExitReason(position);
    if (!exitReason) {
      // Not time to exit yet - wait for better opportunity
      this.logger.debug(
        `[AutoSell] Oversized: ${tokenIdShort}... invested=$${investedUsd.toFixed(2)} P&L=${position.pnlPct.toFixed(1)}% - waiting for better exit opportunity`,
      );
      return false;
    }

    // Calculate time to event for logging
    const now = Date.now();
    let timeToEventStr = "unknown";
    if (position.marketEndTime && position.marketEndTime > now) {
      const hoursRemaining = (position.marketEndTime - now) / (60 * 60 * 1000);
      timeToEventStr =
        hoursRemaining >= 1
          ? `${hoursRemaining.toFixed(1)}h`
          : `${(hoursRemaining * 60).toFixed(0)}m`;
    }

    // Log the exit decision
    const exitReasonLabel = {
      PROFITABLE: "💚 PROFITABLE",
      BREAKEVEN: "⚪ BREAKEVEN",
      EVENT_APPROACHING: "🚨 EVENT_APPROACHING",
    }[exitReason];

    this.logger.info(
      `[AutoSell] OVERSIZED_EXIT ${exitReasonLabel}: tokenId=${tokenIdShort}... invested=$${investedUsd.toFixed(2)} P&L=${position.pnlPct.toFixed(1)}% timeToEvent=${timeToEventStr}`,
    );

    try {
      // Use unified executeSell method
      const sold = await this.executeSell(
        position,
        `AutoSell (Oversized ${exitReason})`,
      );

      if (sold) {
        this.soldPositions.add(positionKey);

        // Calculate realized P&L for logging
        const currentPrice = position.currentBidPrice ?? position.currentPrice;
        const tradePnl = (currentPrice - position.entryPrice) * position.size;
        const freedCapital = position.size * currentPrice;

        // Send notification
        void notifySell(
          position.marketId,
          position.tokenId,
          position.size,
          currentPrice,
          freedCapital,
          {
            strategy: `AutoSell (Oversized ${exitReason})`,
            entryPrice: position.entryPrice,
            pnl: tradePnl,
            outcome: position.side,
          },
        ).catch(() => {
          // Ignore notification errors
        });

        const pnlSign = tradePnl >= 0 ? "+" : "";
        this.logger.info(
          `[AutoSell] ✅ OVERSIZED_EXIT: ${exitReasonLabel} exit completed, P&L: ${pnlSign}$${tradePnl.toFixed(2)}, freed $${freedCapital.toFixed(2)} capital`,
        );
        return true;
      }
    } catch (err) {
      this.logger.error(
        `[AutoSell] Failed to sell oversized position ${position.marketId.slice(0, 16)}...`,
        err as Error,
      );
    }

    return false;
  }

  /**
   * Clean up stale entries from tracking Maps/Sets
   * Removes entries for positions that no longer exist or were sold
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

    // Clean up positionFirstSeen for positions that no longer exist
    let cleanedFirstSeen = 0;
    const firstSeenKeysToDelete: string[] = [];
    for (const key of this.positionFirstSeen.keys()) {
      if (!currentKeys.has(key)) {
        firstSeenKeysToDelete.push(key);
      }
    }
    for (const key of firstSeenKeysToDelete) {
      this.positionFirstSeen.delete(key);
      cleanedFirstSeen++;
    }

    // Clean up soldPositions that are no longer in current positions
    // (they've been fully removed/resolved)
    let cleanedSold = 0;
    const soldKeysToDelete: string[] = [];
    for (const key of this.soldPositions) {
      if (!currentKeys.has(key)) {
        soldKeysToDelete.push(key);
      }
    }
    for (const key of soldKeysToDelete) {
      this.soldPositions.delete(key);
      cleanedSold++;
    }

    // Also clean up no-liquidity cache for tokens we no longer hold
    const tokensToRemove: string[] = [];
    for (const tokenId of this.noLiquidityTokens) {
      if (!currentTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      this.noLiquidityTokens.delete(tokenId);
    }

    if (cleanedFirstSeen > 0 || cleanedSold > 0) {
      this.logger.debug(
        `[AutoSell] Cleaned up ${cleanedFirstSeen} first-seen and ${cleanedSold} sold entries`,
      );
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    soldCount: number;
    enabled: boolean;
    threshold: number;
  } {
    return {
      soldCount: this.soldPositions.size,
      enabled: this.config.enabled,
      threshold: this.config.threshold,
    };
  }

  /**
   * Reset sold positions tracking (for testing or daily reset)
   */
  reset(): void {
    this.soldPositions.clear();
    this.positionFirstSeen.clear();
    this.noLiquidityTokens.clear();
  }
}
