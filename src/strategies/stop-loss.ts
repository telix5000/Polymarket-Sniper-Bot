import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { PositionTracker, Position } from "./position-tracker";
import { getDynamicStopLoss, PRICE_TIERS } from "./trade-quality";
import { notifyStopLoss } from "../services/trade-notification.service";
import { calculateMinAcceptablePrice, FALLING_KNIFE_SLIPPAGE_PCT } from "./constants";

/**
 * Minimum acceptable price for emergency exit orders (stop-loss, liquidation).
 * Set to 1¢ to accept any price rather than optimizing exit.
 * The goal is to EXIT the position and salvage whatever value remains.
 *
 * NOTE: This is kept as a fallback for extreme scenarios. For most stop-loss
 * and liquidation scenarios, use calculateMinAcceptablePrice with
 * FALLING_KNIFE_SLIPPAGE_PCT (25%) which provides more graceful degradation.
 */
export const EMERGENCY_EXIT_MIN_PRICE = 0.01;

export interface StopLossConfig {
  enabled: boolean;
  /**
   * Maximum stop-loss percentage allowed for ANY position.
   * Acts as an absolute ceiling regardless of entry price tier.
   * Default: 25% - no position should ever lose more than this.
   */
  maxStopLossPct: number;
  /**
   * Use dynamic stop-loss tiers based on entry price.
   * If false, uses maxStopLossPct for all positions.
   */
  useDynamicTiers: boolean;
  /**
   * Skip positions that Hedging will handle (entry < hedgingMaxEntryPrice).
   * When enabled, Stop-Loss defers to Hedging for low-entry positions.
   *
   * Default: true when smart hedging is enabled
   */
  skipForSmartHedging?: boolean;
  /**
   * Entry price threshold for determining which strategy handles a position.
   * Should match Hedging's maxEntryPrice (default: 1.0 = 100¢).
   *
   * When skipForSmartHedging is true:
   * - Positions with entry < this threshold: Handled by Hedging (skipped by Stop-Loss)
   * - Positions with entry >= this threshold: Handled by Stop-Loss
   *
   * This matches Hedging's logic which skips positions where entry >= maxEntryPrice.
   *
   * Default: 1.0 (100¢) - matches Hedging default (handles ALL positions)
   */
  hedgingMaxEntryPrice?: number;
  /**
   * Minimum time (in seconds) a position must be held before stop-loss can trigger.
   * This prevents selling positions immediately after buying due to bid-ask spread.
   * The initial "loss" from spread is NOT a real loss - give the market time to move.
   *
   * Default: 60 seconds - prevents premature sells from spread-induced "losses"
   *
   * IMPORTANT: Without this, positions bought at 75¢ might immediately show
   * a 2-3% "loss" due to bid-ask spread and trigger a stop-loss sell before
   * the market has any chance to move in our favor.
   */
  minHoldSeconds?: number;
}

export interface StopLossStrategyConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  positionTracker: PositionTracker;
  config: StopLossConfig;
}

/**
 * Stop-Loss Strategy
 *
 * A SAFETY NET that runs on ALL positions regardless of which strategy created them.
 * This ensures no position can "fall through the cracks" and exceed its stop-loss threshold.
 *
 * Stop-Loss Tiers (when useDynamicTiers=true):
 * - Premium tier (90¢+): 3% stop-loss
 * - Quality tier (80-90¢): 5% stop-loss
 * - Standard tier (70-80¢): 8% stop-loss
 * - Speculative tier (60-70¢): 12% stop-loss
 * - Risky tier (< 60¢): 20% stop-loss
 *
 * The maxStopLossPct acts as an absolute ceiling (default 25%).
 *
 * NOTE: When Hedging is enabled (skipForSmartHedging=true), positions with
 * entry price below hedgingMaxEntryPrice (default 75¢) are SKIPPED by this strategy.
 * Hedging handles them by buying the opposing side instead of selling at a loss,
 * which can turn losers into winners.
 *
 * This strategy is designed to catch positions from:
 * - ARB trades (which have no built-in stop-loss)
 * - Monitor/Mempool trades (which have no built-in stop-loss)
 * - Endgame Sweep trades (which have no built-in stop-loss)
 * - Any other source of positions
 */
export class StopLossStrategy {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private config: StopLossConfig;

  // === SINGLE-FLIGHT GUARD ===
  // Prevents concurrent execution if called multiple times
  private inFlight = false;

  /**
   * Tracks tokenIds with no liquidity to suppress repeated warnings.
   * Key: tokenId (string)
   * Cleared when position is sold or no longer held.
   */
  private noLiquidityTokens: Set<string> = new Set();

  /**
   * Tracks positions currently being processed for stop-loss sell.
   * Key format: "marketId-tokenId"
   * Used to prevent duplicate sell attempts within the same execution cycle.
   * Entries are removed after sell attempt completes (success or failure).
   */
  private pendingSells: Set<string> = new Set();

  /**
   * Tracks when stop-loss was triggered for each position (for logging/diagnostics).
   * Key format: "marketId-tokenId"
   * Value: timestamp (ms) when stop-loss was triggered
   * Cleaned up when position no longer exists.
   */
  private stopLossTriggered: Map<string, number> = new Map();

  /**
   * Timestamp of last diagnostic log to rate-limit log spam
   */
  private lastDiagnosticLogAt = 0;

  constructor(strategyConfig: StopLossStrategyConfig) {
    this.client = strategyConfig.client;
    this.logger = strategyConfig.logger;
    this.positionTracker = strategyConfig.positionTracker;
    this.config = strategyConfig.config;
  }

  /**
   * Check if a position has catastrophic loss (>= maxStopLossPct).
   * Used to bypass safety checks like entry time and hold time verification.
   */
  private isCatastrophicLoss(position: Position): boolean {
    return position.pnlPct < 0 && Math.abs(position.pnlPct) >= this.config.maxStopLossPct;
  }

  /**
   * Execute the stop-loss strategy
   * Returns number of positions sold
   *
   * SINGLE-FLIGHT: Skips if already running (returns 0)
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard: prevent concurrent execution
    if (this.inFlight) {
      this.logger.debug("[StopLoss] Skipped - already in flight");
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
    // Clean up stale entries
    this.cleanupStaleEntries();

    let soldCount = 0;
    const allPositions = this.positionTracker.getPositions();
    const now = Date.now();

    // Skip resolved/redeemable positions (they can't be sold, only redeemed)
    let activePositions = allPositions.filter((pos) => !pos.redeemable);

    // === DIAGNOSTIC: Log high-loss positions before filtering (rate-limited) ===
    // This helps debug why positions aren't being acted upon
    const highLossPositions = activePositions.filter(
      (p) => p.pnlPct < 0 && Math.abs(p.pnlPct) >= this.config.maxStopLossPct
    );
    // Rate-limit diagnostic logging to once per minute to prevent log spam
    const DIAGNOSTIC_LOG_INTERVAL_MS = 60_000;
    if (highLossPositions.length > 0 && now - this.lastDiagnosticLogAt >= DIAGNOSTIC_LOG_INTERVAL_MS) {
      this.lastDiagnosticLogAt = now;
      for (const pos of highLossPositions) {
        const lossPct = Math.abs(pos.pnlPct);
        this.logger.info(
          `[StopLoss] 🔍 Diagnostic: High-loss position ${pos.side ?? "?"} ${pos.tokenId.slice(0, 16)}... ` +
            `entry=${(pos.entryPrice * 100).toFixed(1)}¢ current=${(pos.currentPrice * 100).toFixed(1)}¢ ` +
            `loss=${lossPct.toFixed(1)}% pnlTrusted=${pos.pnlTrusted} ` +
            `execStatus=${pos.executionStatus ?? "unknown"} ` +
            `${pos.pnlUntrustedReason ? `reason=${pos.pnlUntrustedReason}` : ""}`,
        );
      }
    }

    // === CRITICAL: P&L TRUST FILTER ===
    // NEVER trigger stop-loss on positions with untrusted P&L.
    // We might be selling winners that only APPEAR to be losing due to bad data.
    // EXCEPTION: For CATASTROPHIC losses (>= maxStopLossPct), allow action even with
    // untrusted P&L because the risk of inaction is greater than the risk of acting.
    activePositions = activePositions.filter((pos) => {
      if (!pos.pnlTrusted) {
        // Check for catastrophic loss exception using helper method
        if (this.isCatastrophicLoss(pos)) {
          // CATASTROPHIC LOSS with untrusted P&L - ALLOW stop-loss with warning
          // The risk of doing nothing is greater than the risk of acting on imperfect data
          const lossPctMagnitude = Math.abs(pos.pnlPct);
          this.logger.warn(
            `[StopLoss] 🚨 CATASTROPHIC LOSS (${lossPctMagnitude.toFixed(1)}% >= ${this.config.maxStopLossPct}%) with untrusted P&L ` +
            `(${pos.pnlUntrustedReason ?? "unknown reason"}) - PROCEEDING WITH STOP-LOSS despite data uncertainty`,
          );
          return true; // Keep the position for stop-loss processing
        }
        
        this.logger.debug(
          `[StopLoss] 📋 Skip (UNTRUSTED_PNL): ${pos.tokenId.slice(0, 16)}... has untrusted P&L (${pos.pnlUntrustedReason ?? "unknown reason"})`,
        );
        return false;
      }
      return true;
    });

    // Skip positions that Hedging will handle
    // When skipForSmartHedging is true, defer to Hedging for positions it can act on.
    // CRITICAL FIX (Jan 2025): Do NOT skip positions that Hedging would also skip!
    // If a position has executionStatus === NOT_TRADABLE_ON_CLOB, Hedging skips it,
    // so Stop-Loss MUST handle it as a last line of defense.
    if (this.config.skipForSmartHedging) {
      // Use configured threshold or default to 100¢ (matches Hedging default - handles ALL positions)
      const hedgingThreshold = this.config.hedgingMaxEntryPrice ?? 1.0;
      activePositions = activePositions.filter((pos) => {
        // Keep positions with entry >= hedgingThreshold (Hedging won't handle these)
        if (pos.entryPrice >= hedgingThreshold) {
          return true;
        }
        
        // CRITICAL: Also keep positions that Hedging would skip due to NOT_TRADABLE_ON_CLOB
        // These positions can't be hedged (no orderbook), so Stop-Loss must try to sell them.
        // This prevents positions from falling through the cracks when both strategies skip them.
        if (
          pos.executionStatus === "NOT_TRADABLE_ON_CLOB" ||
          pos.executionStatus === "EXECUTION_BLOCKED"
        ) {
          this.logger.debug(
            `[StopLoss] 📋 Including position despite skipForSmartHedging: ${pos.tokenId.slice(0, 16)}... ` +
              `(executionStatus=${pos.executionStatus}, entry=${(pos.entryPrice * 100).toFixed(1)}¢) - ` +
              `Hedging cannot act on NOT_TRADABLE positions`,
          );
          return true;
        }
        
        // Defer to Hedging for tradable positions below hedgingThreshold
        return false;
      });

      // NOTE: We intentionally don't log skipped positions here.
      // Hedging handles tradable positions with its own fallback mechanism
      // (liquidation if hedge fails), so this skip is expected and silent.
    }

    if (activePositions.length === 0) {
      return 0;
    }

    // Get minimum hold time from config (default to 60 seconds if not set)
    const minHoldSeconds = this.config.minHoldSeconds ?? 60;

    // Find positions exceeding their stop-loss threshold
    const positionsToStop: Array<{ position: Position; stopLossPct: number }> =
      [];

    for (const position of activePositions) {
      const stopLossPct = this.getStopLossThreshold(position.entryPrice);

      // Check if position exceeds stop-loss (negative P&L beyond threshold)
      if (position.pnlPct <= -stopLossPct) {
        // Use helper method to check for catastrophic loss
        const isCatastrophic = this.isCatastrophicLoss(position);
        
        // Check minimum hold time before allowing stop-loss
        // Use PositionTracker's entry time as single source of truth
        const entryTime = this.positionTracker.getPositionEntryTime(
          position.marketId,
          position.tokenId,
        );

        // CRITICAL FIX (Jan 2025): For CATASTROPHIC losses, skip entry time and hold time checks.
        // If Data API says we're down 25%+, we should act immediately.
        // The original conservative approach prevented action on positions after container restart,
        // but it also prevented action on legitimately losing positions.
        if (!entryTime) {
          if (isCatastrophic) {
            // CATASTROPHIC LOSS with no entry time - ACT ANYWAY
            const lossPctMagnitude = Math.abs(position.pnlPct);
            this.logger.warn(
              `[StopLoss] 🚨 CATASTROPHIC LOSS (${lossPctMagnitude.toFixed(1)}%) with no entry time - PROCEEDING ANYWAY (Data API is source of truth)`,
            );
            // Fall through to add to positionsToStop
          } else {
            this.logger.debug(
              `[StopLoss] ⏳ Position at ${position.pnlPct.toFixed(2)}% loss but no entry time - skipping stop-loss (will check after next refresh)`,
            );
            continue;
          }
        }

        // Check hold time (but skip for catastrophic losses)
        if (entryTime && !isCatastrophic) {
          const holdTimeSeconds = (now - entryTime) / 1000;

          if (holdTimeSeconds < minHoldSeconds) {
            // Position hasn't been held long enough - skip stop-loss for now
            // This prevents selling positions immediately after buying due to bid-ask spread
            this.logger.debug(
              `[StopLoss] ⏳ Position at ${position.pnlPct.toFixed(2)}% loss (threshold: -${stopLossPct}%) held for ${holdTimeSeconds.toFixed(0)}s, need ${minHoldSeconds}s before stop-loss can trigger`,
            );
            continue;
          }
        }

        positionsToStop.push({ position, stopLossPct });
      }
    }

    // Log summary of positions being monitored
    if (positionsToStop.length > 0) {
      this.logger.warn(
        `[StopLoss] 🚨 ${positionsToStop.length} position(s) exceeding stop-loss threshold!`,
      );
    }

    // Process stop-loss sells
    for (const { position, stopLossPct } of positionsToStop) {
      const positionKey = `${position.marketId}-${position.tokenId}`;

      // Skip if we're already trying to sell this position
      if (this.pendingSells.has(positionKey)) {
        continue;
      }

      // Log the stop-loss trigger
      const tierName = this.getTierName(position.entryPrice);
      this.logger.warn(
        `[StopLoss] 🔻 STOP-LOSS TRIGGERED: ${position.pnlPct.toFixed(2)}% loss ` +
          `(threshold: -${stopLossPct}%, tier: ${tierName}, entry: ${(position.entryPrice * 100).toFixed(1)}¢) ` +
          `Market: ${position.marketId.slice(0, 16)}...`,
      );

      this.pendingSells.add(positionKey);
      this.stopLossTriggered.set(positionKey, Date.now());

      try {
        const sold = await this.sellPosition(
          position.marketId,
          position.tokenId,
          position.size,
          position.pnlPct,
          position.entryPrice,
          position.pnlUsd,
          position.currentPrice, // Pass Data API price as fallback for illiquid positions
        );

        if (sold) {
          soldCount++;
          this.logger.info(
            `[StopLoss] ✅ Stop-loss executed: sold ${position.size.toFixed(2)} shares ` +
              `at ${position.pnlPct.toFixed(2)}% loss`,
          );
        }
      } catch (err) {
        this.logger.error(
          `[StopLoss] ❌ Failed to execute stop-loss for ${position.marketId}`,
          err as Error,
        );
      } finally {
        // Remove from pending after attempt (success or failure)
        this.pendingSells.delete(positionKey);
      }
    }

    if (soldCount > 0) {
      this.logger.info(
        `[StopLoss] 💰 Executed ${soldCount} stop-loss sell(s)`,
      );
    }

    return soldCount;
  }

  /**
   * Get stop-loss threshold for a position based on entry price
   */
  private getStopLossThreshold(entryPrice: number): number {
    if (!this.config.useDynamicTiers) {
      return this.config.maxStopLossPct;
    }

    // Get dynamic stop-loss based on entry price tier
    const dynamicStopLoss = getDynamicStopLoss(entryPrice);

    // Apply the absolute ceiling
    return Math.min(dynamicStopLoss, this.config.maxStopLossPct);
  }

  /**
   * Get human-readable tier name for logging
   */
  private getTierName(entryPrice: number): string {
    if (entryPrice >= PRICE_TIERS.PREMIUM_MIN) return "Premium";
    if (entryPrice >= PRICE_TIERS.QUALITY_MIN) return "Quality";
    if (entryPrice >= PRICE_TIERS.STANDARD_MIN) return "Standard";
    if (entryPrice >= PRICE_TIERS.SPECULATIVE_MIN) return "Speculative";
    return "Risky";
  }

  /**
   * Sell a position using postOrder utility
   * 
   * CRITICAL FIX (Jan 2025): Now accepts dataApiPrice as fallback when orderbook unavailable.
   * If Data API provided curPrice, we can use that for sell pricing even without an orderbook.
   * This allows stop-loss to work on illiquid positions where the Data API still tracks value.
   */
  private async sellPosition(
    marketId: string,
    tokenId: string,
    size: number,
    currentLossPct: number,
    entryPrice: number,
    pnlUsd: number,
    dataApiPrice?: number, // Data API curPrice as fallback
  ): Promise<boolean> {
    try {
      const { postOrder } = await import("../utils/post-order.util");

      let sellPrice: number;
      let priceSource: "orderbook" | "data_api";

      // Try to get orderbook price first (most accurate for execution)
      try {
        const orderbook = await this.client.getOrderBook(tokenId);

        if (orderbook.bids && orderbook.bids.length > 0) {
          sellPrice = parseFloat(orderbook.bids[0].price);
          priceSource = "orderbook";
          // Clear no-liquidity flag if liquidity returned
          this.noLiquidityTokens.delete(tokenId);
        } else {
          // Empty orderbook - try Data API fallback
          if (dataApiPrice !== undefined && dataApiPrice > 0) {
            sellPrice = dataApiPrice;
            priceSource = "data_api";
            this.logger.info(
              `[StopLoss] 📊 Empty orderbook for ${tokenId.slice(0, 16)}... - using Data API price ${(dataApiPrice * 100).toFixed(1)}¢ for stop-loss`,
            );
          } else {
            if (!this.noLiquidityTokens.has(tokenId)) {
              this.logger.warn(
                `[StopLoss] ⚠️ No bids for token ${tokenId.slice(0, 16)}... and no Data API price - cannot execute stop-loss (illiquid)`,
              );
              this.noLiquidityTokens.add(tokenId);
            }
            return false;
          }
        }
      } catch (orderbookErr) {
        // Orderbook fetch failed (404, timeout, etc.) - try Data API fallback
        const errMsg = orderbookErr instanceof Error ? orderbookErr.message : String(orderbookErr);
        
        if (dataApiPrice !== undefined && dataApiPrice > 0) {
          sellPrice = dataApiPrice;
          priceSource = "data_api";
          this.logger.info(
            `[StopLoss] 📊 Orderbook fetch failed (${errMsg}) - using Data API price ${(dataApiPrice * 100).toFixed(1)}¢ for stop-loss`,
          );
        } else {
          if (!this.noLiquidityTokens.has(tokenId)) {
            this.logger.warn(
              `[StopLoss] ⚠️ Orderbook fetch failed (${errMsg}) and no Data API price - cannot execute stop-loss`,
            );
            this.noLiquidityTokens.add(tokenId);
          }
          return false;
        }
      }

      const sizeUsd = size * sellPrice;

      // Extract wallet if available
      const wallet = (this.client as { wallet?: Wallet }).wallet;

      this.logger.info(
        `[StopLoss] 🔄 Executing stop-loss sell: ${size.toFixed(2)} shares ` +
          `at ~${(sellPrice * 100).toFixed(1)}¢ ($${sizeUsd.toFixed(2)}, loss: ${currentLossPct.toFixed(2)}%) [source: ${priceSource}]`,
      );

      // Execute sell order with liberal slippage tolerance for stop-loss
      // Using FALLING_KNIFE_SLIPPAGE_PCT (25%) instead of hardcoded 1¢ floor
      // This is more liberal than normal sells but still recovers meaningful value
      // Example: At 50¢ bid, accepts down to 37.5¢ (still 75% of bid value)
      const result = await postOrder({
        client: this.client,
        wallet,
        marketId,
        tokenId,
        outcome: "YES",
        side: "SELL",
        sizeUsd,
        minAcceptablePrice: calculateMinAcceptablePrice(sellPrice, FALLING_KNIFE_SLIPPAGE_PCT),
        logger: this.logger,
        priority: true, // High priority for stop-loss
        skipDuplicatePrevention: true, // Stop-loss must bypass duplicate prevention
        orderConfig: { minOrderUsd: 0 }, // Bypass minimum for stop-loss
      });

      if (result.status === "submitted") {
        // Send telegram notification for stop-loss trigger
        void notifyStopLoss(
          marketId,
          tokenId,
          size,
          sellPrice,
          sizeUsd,
          {
            entryPrice,
            pnl: pnlUsd,
          },
        ).catch(() => {
          // Ignore notification errors - logging is handled by the service
        });

        return true;
      } else if (result.status === "skipped") {
        this.logger.warn(
          `[StopLoss] ⏭️ Stop-loss sell skipped: ${result.reason ?? "unknown"}`,
        );
        return false;
      } else if (result.reason === "FOK_ORDER_KILLED") {
        // FOK order was submitted but killed (no fill) - market has insufficient liquidity
        this.logger.warn(
          `[StopLoss] ⚠️ Stop-loss sell not filled (FOK killed) - market has insufficient liquidity`,
        );
        return false;
      } else {
        this.logger.error(
          `[StopLoss] ❌ Stop-loss sell failed: ${result.reason ?? "unknown"}`,
        );
        return false;
      }
    } catch (err) {
      this.logger.error(
        `[StopLoss] ❌ Error selling position: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  /**
   * Clean up stale entries from tracking sets
   */
  private cleanupStaleEntries(): void {
    const currentPositions = this.positionTracker.getPositions();
    const currentKeys = new Set(
      currentPositions.map((pos) => `${pos.marketId}-${pos.tokenId}`),
    );
    const currentTokenIds = new Set(currentPositions.map((pos) => pos.tokenId));

    // Clean up stop-loss triggers for positions that no longer exist
    const triggersToRemove: string[] = [];
    for (const key of this.stopLossTriggered.keys()) {
      if (!currentKeys.has(key)) {
        triggersToRemove.push(key);
      }
    }
    for (const key of triggersToRemove) {
      this.stopLossTriggered.delete(key);
    }

    // Clean up no-liquidity cache for tokens we no longer hold
    const tokensToRemove: string[] = [];
    for (const tokenId of this.noLiquidityTokens) {
      if (!currentTokenIds.has(tokenId)) {
        tokensToRemove.push(tokenId);
      }
    }
    for (const tokenId of tokensToRemove) {
      this.noLiquidityTokens.delete(tokenId);
    }
  }

  /**
   * Get strategy statistics
   */
  getStats(): {
    enabled: boolean;
    maxStopLossPct: number;
    useDynamicTiers: boolean;
    activeStopLossTriggers: number;
    minHoldSeconds: number;
  } {
    return {
      enabled: this.config.enabled,
      maxStopLossPct: this.config.maxStopLossPct,
      useDynamicTiers: this.config.useDynamicTiers,
      activeStopLossTriggers: this.stopLossTriggered.size,
      minHoldSeconds: this.config.minHoldSeconds ?? 60,
    };
  }
}
