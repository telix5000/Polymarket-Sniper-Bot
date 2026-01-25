/**
 * Sell Signal Monitor Service
 *
 * Monitors sell signals from tracked traders to detect systematic losses
 * we might be missing. This provides an EXTRA LAYER of protection by:
 *
 * 1. NOT copying sell trades blindly (we don't know their entry price)
 * 2. Checking if we hold the same position being sold
 * 3. If our position is LOSING, evaluating if hedging/stop-loss should trigger
 * 4. NEVER selling if our position is PROFITABLE (knee deep in a positive position)
 *
 * This is a PASSIVE SAFETY NET that complements (not replaces) the existing
 * Hedging and StopLoss strategies which run on their regular schedules.
 */

import type { TradeSignal } from "../domain/trade.types";
import type { Logger } from "../utils/logger.util";
import type { PositionTracker, Position } from "../strategies/position-tracker";
import { LogDeduper, HEARTBEAT_INTERVAL_MS } from "../utils/log-deduper.util";

/**
 * Configuration for sell signal monitoring
 */
export interface SellSignalMonitorConfig {
  /** Enable sell signal monitoring (default: true) */
  enabled: boolean;

  /**
   * Minimum loss percentage to trigger protective action (default: 15)
   * When a tracked trader sells a position we also hold, and our loss
   * is at least this %, consider triggering early hedging/stop-loss.
   *
   * This is LOWER than the standard hedging trigger (20%) to provide
   * EARLIER protection when we see smart traders exiting.
   */
  minLossPctToAct: number;

  /**
   * Maximum profit percentage to skip action (default: 5)
   * If our position is profitable by more than this %, we're "knee deep"
   * in a positive position and should NOT sell just because others are.
   *
   * Set to 0 to skip action on ANY profitable position.
   */
  maxProfitPctToSkip: number;

  /**
   * Minimum position size (USD) to monitor (default: 5)
   * Ignore tiny positions where action overhead exceeds potential loss.
   */
  minPositionUsd: number;

  /**
   * Cooldown between actions on the same position (ms) (default: 60000)
   * Prevents rapid-fire hedging/stop-loss triggers from multiple sell signals.
   */
  actionCooldownMs: number;
}

/**
 * Default configuration - conservative to avoid false positives
 */
export const DEFAULT_SELL_SIGNAL_MONITOR_CONFIG: SellSignalMonitorConfig = {
  enabled: true,
  minLossPctToAct: 15, // Lower than standard 20% to catch early exits
  maxProfitPctToSkip: 5, // Skip if we're up more than 5%
  minPositionUsd: 5, // Ignore positions worth less than $5
  actionCooldownMs: 60_000, // 1 minute cooldown per position
};

/**
 * Result of evaluating a sell signal against our position
 */
export interface SellSignalEvaluation {
  /** Whether any protective action is recommended */
  shouldAct: boolean;

  /** Recommended action type */
  action: "NONE" | "TRIGGER_HEDGE" | "TRIGGER_STOP_LOSS";

  /** Reason for the decision */
  reason: string;

  /** Our position data (if we hold it) */
  ourPosition?: Position;

  /** The tracked trader's sell signal */
  signal: TradeSignal;
}

/**
 * Dependencies for SellSignalMonitor
 */
export interface SellSignalMonitorDeps {
  logger: Logger;
  positionTracker: PositionTracker;
  config?: Partial<SellSignalMonitorConfig>;

  /**
   * Callback to trigger early hedging evaluation for a position.
   * This should notify the Hedging strategy to evaluate this position
   * with priority, potentially using a lower threshold than normal.
   */
  onTriggerHedge?: (position: Position, signal: TradeSignal) => Promise<void>;

  /**
   * Callback to trigger early stop-loss evaluation for a position.
   * This should notify the StopLoss strategy to evaluate this position
   * with priority.
   */
  onTriggerStopLoss?: (position: Position, signal: TradeSignal) => Promise<void>;
}

/**
 * Sell Signal Monitor Service
 *
 * Monitors sell signals from tracked traders and triggers protective actions
 * when we detect they're exiting positions we also hold at a loss.
 */
export class SellSignalMonitorService {
  private readonly config: SellSignalMonitorConfig;
  private readonly logger: Logger;
  private readonly positionTracker: PositionTracker;
  private readonly onTriggerHedge?: (
    position: Position,
    signal: TradeSignal,
  ) => Promise<void>;
  private readonly onTriggerStopLoss?: (
    position: Position,
    signal: TradeSignal,
  ) => Promise<void>;

  // === LOG DEDUPLICATION ===
  private logDeduper = new LogDeduper();

  // === COOLDOWN TRACKING ===
  // Tracks last action time per tokenId to prevent rapid-fire triggers
  private lastActionTime: Map<string, number> = new Map();

  // === STATISTICS ===
  private stats = {
    signalsProcessed: 0,
    signalsMatched: 0, // We hold the same position
    signalsTriggeredHedge: 0,
    signalsTriggeredStopLoss: 0,
    signalsSkippedProfitable: 0,
    signalsSkippedCooldown: 0,
    signalsSkippedSmallPosition: 0,
    signalsSkippedUntrustedPnl: 0,
  };

  constructor(deps: SellSignalMonitorDeps) {
    this.config = {
      ...DEFAULT_SELL_SIGNAL_MONITOR_CONFIG,
      ...deps.config,
    };
    this.logger = deps.logger;
    this.positionTracker = deps.positionTracker;
    this.onTriggerHedge = deps.onTriggerHedge;
    this.onTriggerStopLoss = deps.onTriggerStopLoss;

    this.logger.info(
      `[SellSignalMonitor] Initialized: enabled=${this.config.enabled}, ` +
        `minLossPct=${this.config.minLossPctToAct}%, maxProfitPctToSkip=${this.config.maxProfitPctToSkip}%`,
    );
  }

  /**
   * Process a sell signal from a tracked trader.
   * Called by TradeMonitorService when a SELL is detected.
   *
   * @returns Evaluation result indicating what action (if any) was triggered
   */
  async processSellSignal(signal: TradeSignal): Promise<SellSignalEvaluation> {
    this.stats.signalsProcessed++;

    // Skip if disabled
    if (!this.config.enabled) {
      return {
        shouldAct: false,
        action: "NONE",
        reason: "MONITORING_DISABLED",
        signal,
      };
    }

    // Only process SELL signals
    if (signal.side !== "SELL") {
      return {
        shouldAct: false,
        action: "NONE",
        reason: "NOT_A_SELL_SIGNAL",
        signal,
      };
    }

    // Check if we hold this position
    const ourPosition = this.positionTracker.getPositionByTokenId(
      signal.tokenId,
    );

    if (!ourPosition || ourPosition.size <= 0) {
      // We don't hold this position - nothing to protect
      return {
        shouldAct: false,
        action: "NONE",
        reason: "NO_MATCHING_POSITION",
        signal,
      };
    }

    this.stats.signalsMatched++;

    // Evaluate whether protective action is needed
    return this.evaluatePosition(ourPosition, signal);
  }

  /**
   * Evaluate whether to trigger protective action for our position
   * based on a tracked trader's sell signal.
   */
  private async evaluatePosition(
    position: Position,
    signal: TradeSignal,
  ): Promise<SellSignalEvaluation> {
    const tokenIdShort = position.tokenId.slice(0, 12);

    // === CHECK: P&L Trust ===
    // NEVER act on positions with untrusted P&L - we might be selling winners
    if (!position.pnlTrusted) {
      this.stats.signalsSkippedUntrustedPnl++;
      if (
        this.logDeduper.shouldLog(
          `SellSignalMonitor:untrusted:${position.tokenId}`,
          HEARTBEAT_INTERVAL_MS,
        )
      ) {
        this.logger.debug(
          `[SellSignalMonitor] ⚠️ Skipping ${tokenIdShort}... - untrusted P&L (${position.pnlUntrustedReason ?? "unknown"})`,
        );
      }
      return {
        shouldAct: false,
        action: "NONE",
        reason: "UNTRUSTED_PNL",
        ourPosition: position,
        signal,
      };
    }

    // === CHECK: Position Size ===
    const positionValueUsd = position.size * position.currentPrice;
    if (positionValueUsd < this.config.minPositionUsd) {
      this.stats.signalsSkippedSmallPosition++;
      return {
        shouldAct: false,
        action: "NONE",
        reason: `POSITION_TOO_SMALL_${positionValueUsd.toFixed(2)}USD`,
        ourPosition: position,
        signal,
      };
    }

    // === CHECK: Profitable Position ("knee deep in positive") ===
    // If we're profitable by more than maxProfitPctToSkip, don't sell
    if (position.pnlPct > this.config.maxProfitPctToSkip) {
      this.stats.signalsSkippedProfitable++;

      // Rate-limit logging for profitable skips
      if (
        this.logDeduper.shouldLog(
          `SellSignalMonitor:profitable:${position.tokenId}`,
          HEARTBEAT_INTERVAL_MS,
        )
      ) {
        this.logger.info(
          `[SellSignalMonitor] ✅ Tracked trader sold ${tokenIdShort}... but we're UP ${position.pnlPct.toFixed(1)}% - NOT selling (knee deep in positive)`,
        );
      }

      return {
        shouldAct: false,
        action: "NONE",
        reason: `PROFITABLE_${position.pnlPct.toFixed(1)}PCT`,
        ourPosition: position,
        signal,
      };
    }

    // === CHECK: Cooldown ===
    const now = Date.now();
    const lastAction = this.lastActionTime.get(position.tokenId) ?? 0;
    if (now - lastAction < this.config.actionCooldownMs) {
      this.stats.signalsSkippedCooldown++;
      return {
        shouldAct: false,
        action: "NONE",
        reason: "COOLDOWN_ACTIVE",
        ourPosition: position,
        signal,
      };
    }

    // === CHECK: Loss Threshold ===
    // At this point, position is either losing or barely profitable
    const isLosing = position.pnlPct < 0;
    const lossPct = Math.abs(position.pnlPct);

    if (!isLosing) {
      // Position is neutral or slightly profitable (within maxProfitPctToSkip)
      // Log but don't take action - let regular strategies handle it
      if (
        this.logDeduper.shouldLog(
          `SellSignalMonitor:neutral:${position.tokenId}`,
          HEARTBEAT_INTERVAL_MS,
        )
      ) {
        this.logger.debug(
          `[SellSignalMonitor] 📊 Tracked trader sold ${tokenIdShort}... - we're at ${position.pnlPct.toFixed(1)}% (neutral/small gain) - monitoring only`,
        );
      }
      return {
        shouldAct: false,
        action: "NONE",
        reason: `NEUTRAL_OR_SMALL_GAIN_${position.pnlPct.toFixed(1)}PCT`,
        ourPosition: position,
        signal,
      };
    }

    // Position is LOSING - evaluate if we should trigger protective action
    if (lossPct < this.config.minLossPctToAct) {
      // Loss not severe enough yet - let regular strategies catch it later
      if (
        this.logDeduper.shouldLog(
          `SellSignalMonitor:smallloss:${position.tokenId}`,
          HEARTBEAT_INTERVAL_MS,
        )
      ) {
        this.logger.debug(
          `[SellSignalMonitor] 📉 Tracked trader sold ${tokenIdShort}... - we're at ${position.pnlPct.toFixed(1)}% (below ${this.config.minLossPctToAct}% threshold) - monitoring only`,
        );
      }
      return {
        shouldAct: false,
        action: "NONE",
        reason: `LOSS_BELOW_THRESHOLD_${lossPct.toFixed(1)}PCT`,
        ourPosition: position,
        signal,
      };
    }

    // === TRIGGER PROTECTIVE ACTION ===
    // We're losing at least minLossPctToAct% AND a tracked trader is selling
    // This is a strong signal we should exit or hedge

    // Update cooldown
    this.lastActionTime.set(position.tokenId, now);

    // Determine action: hedge (if available) or stop-loss
    // Use hedge for moderate losses, stop-loss for severe losses
    const STOP_LOSS_THRESHOLD = 40; // Use stop-loss if loss > 40%

    if (lossPct >= STOP_LOSS_THRESHOLD) {
      // Severe loss - trigger immediate stop-loss
      this.stats.signalsTriggeredStopLoss++;

      this.logger.warn(
        `[SellSignalMonitor] 🚨 TRIGGER STOP-LOSS: Tracked trader sold ${tokenIdShort}... ` +
          `and we're DOWN ${position.pnlPct.toFixed(1)}% ($${position.pnlUsd.toFixed(2)}) - ` +
          `severe loss exceeds ${STOP_LOSS_THRESHOLD}% threshold`,
      );

      // Call the stop-loss trigger callback if configured
      if (this.onTriggerStopLoss) {
        try {
          await this.onTriggerStopLoss(position, signal);
        } catch (err) {
          this.logger.error(
            `[SellSignalMonitor] ❌ Failed to trigger stop-loss: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        shouldAct: true,
        action: "TRIGGER_STOP_LOSS",
        reason: `SEVERE_LOSS_${lossPct.toFixed(1)}PCT_TRIGGERED_BY_SELL_SIGNAL`,
        ourPosition: position,
        signal,
      };
    } else {
      // Moderate loss - trigger hedge evaluation
      this.stats.signalsTriggeredHedge++;

      this.logger.warn(
        `[SellSignalMonitor] 🛡️ TRIGGER HEDGE: Tracked trader sold ${tokenIdShort}... ` +
          `and we're DOWN ${position.pnlPct.toFixed(1)}% ($${position.pnlUsd.toFixed(2)}) - ` +
          `loss exceeds ${this.config.minLossPctToAct}% monitoring threshold`,
      );

      // Call the hedge trigger callback if configured
      if (this.onTriggerHedge) {
        try {
          await this.onTriggerHedge(position, signal);
        } catch (err) {
          this.logger.error(
            `[SellSignalMonitor] ❌ Failed to trigger hedge: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return {
        shouldAct: true,
        action: "TRIGGER_HEDGE",
        reason: `LOSS_${lossPct.toFixed(1)}PCT_TRIGGERED_BY_SELL_SIGNAL`,
        ourPosition: position,
        signal,
      };
    }
  }

  /**
   * Get statistics about sell signal monitoring
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Reset statistics (useful for testing)
   */
  resetStats(): void {
    this.stats = {
      signalsProcessed: 0,
      signalsMatched: 0,
      signalsTriggeredHedge: 0,
      signalsTriggeredStopLoss: 0,
      signalsSkippedProfitable: 0,
      signalsSkippedCooldown: 0,
      signalsSkippedSmallPosition: 0,
      signalsSkippedUntrustedPnl: 0,
    };
    this.lastActionTime.clear();
  }
}

/**
 * Create a SellSignalMonitor with the given dependencies
 */
export function createSellSignalMonitor(
  deps: SellSignalMonitorDeps,
): SellSignalMonitorService {
  return new SellSignalMonitorService(deps);
}
