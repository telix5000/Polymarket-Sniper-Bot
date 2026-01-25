/**
 * Sell Signal Monitor Service
 *
 * Monitors SELL signals from tracked traders and triggers protective actions
 * on our positions when appropriate.
 *
 * LOGIC:
 * 1. When a tracked trader SELLS a position we also hold
 * 2. Check if our position is LOSING (pnlPct < 0)
 * 3. Only act if loss exceeds threshold (default 15%)
 * 4. Do NOT act if position is profitable (>20% profit = "knee deep in positive")
 * 5. Trigger hedge for moderate losses (15-40%), stop-loss for severe losses (>40%)
 * 6. Cooldown prevents repeated actions on the same position
 */

import type { Logger } from "../utils/logger.util";
import type { TradeSignal } from "../domain/trade.types";
import type { PositionTracker, Position } from "../strategies/position-tracker";

/**
 * Configuration for the Sell Signal Monitor Service
 */
export interface SellSignalMonitorConfig {
  /** Enable/disable the service */
  enabled: boolean;

  /**
   * Minimum loss percentage to trigger any protective action (default: 15)
   * Positions losing less than this are ignored
   */
  minLossPctToAct: number;

  /**
   * Profit percentage threshold to skip action (default: 20)
   * Positions with profit >= this percentage are considered "knee deep in positive"
   * and are not acted upon regardless of sell signals
   */
  profitThresholdToSkip: number;

  /**
   * Loss percentage threshold for severe losses (default: 40)
   * Losses >= this trigger stop-loss (sell immediately)
   * Losses between minLossPctToAct and this trigger hedging
   */
  severeLossPct: number;

  /**
   * Cooldown period in milliseconds per position (default: 60000 = 60 seconds)
   * Prevents repeated actions on the same position within this window
   */
  cooldownMs: number;
}

/**
 * Default configuration for Sell Signal Monitor
 */
export const DEFAULT_SELL_SIGNAL_MONITOR_CONFIG: SellSignalMonitorConfig = {
  enabled: true,
  minLossPctToAct: 15,
  profitThresholdToSkip: 20,
  severeLossPct: 40,
  cooldownMs: 60_000, // 60 seconds
};

/**
 * Dependencies for the Sell Signal Monitor Service
 */
export interface SellSignalMonitorDeps {
  logger: Logger;
  positionTracker: PositionTracker;
  config?: Partial<SellSignalMonitorConfig>;
  /**
   * Callback to trigger a hedge on a position
   * Returns true if hedge was successful
   */
  onTriggerHedge?: (position: Position, signal: TradeSignal) => Promise<boolean>;
  /**
   * Callback to trigger a stop-loss (immediate sell) on a position
   * Returns true if stop-loss was successful
   */
  onTriggerStopLoss?: (position: Position, signal: TradeSignal) => Promise<boolean>;
}

/**
 * Result of processing a sell signal
 */
export interface SellSignalResult {
  processed: boolean;
  action: "NONE" | "HEDGE" | "STOP_LOSS" | "SKIPPED";
  reason: string;
  position?: Position;
}

/**
 * Sell Signal Monitor Service
 *
 * Monitors SELL signals from tracked traders and triggers protective actions
 * when we hold the same position and are in a losing state.
 */
export class SellSignalMonitorService {
  private readonly logger: Logger;
  private readonly positionTracker: PositionTracker;
  private readonly config: SellSignalMonitorConfig;
  private readonly onTriggerHedge?: (position: Position, signal: TradeSignal) => Promise<boolean>;
  private readonly onTriggerStopLoss?: (position: Position, signal: TradeSignal) => Promise<boolean>;

  // Track cooldowns per position (tokenId -> expiry timestamp)
  private readonly cooldowns: Map<string, number> = new Map();

  // Track actions taken for logging/monitoring
  private actionsTriggered = 0;
  private signalsProcessed = 0;

  constructor(deps: SellSignalMonitorDeps) {
    this.logger = deps.logger;
    this.positionTracker = deps.positionTracker;
    this.config = {
      ...DEFAULT_SELL_SIGNAL_MONITOR_CONFIG,
      ...deps.config,
    };
    this.onTriggerHedge = deps.onTriggerHedge;
    this.onTriggerStopLoss = deps.onTriggerStopLoss;

    this.logger.info(
      `[SellSignalMonitor] Initialized: enabled=${this.config.enabled}, ` +
        `minLoss=${this.config.minLossPctToAct}%, ` +
        `severeLoss=${this.config.severeLossPct}%, ` +
        `profitSkip=${this.config.profitThresholdToSkip}%, ` +
        `cooldown=${this.config.cooldownMs}ms`,
    );
  }

  /**
   * Process a SELL signal from a tracked trader.
   *
   * @param signal The trade signal detected from a tracked trader
   * @returns Result of processing the signal
   */
  async processSellSignal(signal: TradeSignal): Promise<SellSignalResult> {
    this.signalsProcessed++;

    if (!this.config.enabled) {
      return {
        processed: false,
        action: "NONE",
        reason: "Service disabled",
      };
    }

    // Only process SELL signals
    if (signal.side !== "SELL") {
      return {
        processed: false,
        action: "NONE",
        reason: "Not a SELL signal",
      };
    }

    // Check if we hold this position
    const position = this.positionTracker.getPositionByTokenId(signal.tokenId);
    if (!position) {
      this.logger.debug(
        `[SellSignalMonitor] No position found for tokenId=${signal.tokenId.slice(0, 12)}...`,
      );
      return {
        processed: true,
        action: "NONE",
        reason: "No matching position held",
      };
    }

    // Check cooldown
    const now = Date.now();
    const cooldownExpiry = this.cooldowns.get(signal.tokenId);
    if (cooldownExpiry && now < cooldownExpiry) {
      const remainingMs = cooldownExpiry - now;
      this.logger.debug(
        `[SellSignalMonitor] Cooldown active for tokenId=${signal.tokenId.slice(0, 12)}... ` +
          `(${Math.ceil(remainingMs / 1000)}s remaining)`,
      );
      return {
        processed: true,
        action: "SKIPPED",
        reason: `Cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)`,
        position,
      };
    }

    // Check if P&L is trusted
    if (!position.pnlTrusted) {
      this.logger.debug(
        `[SellSignalMonitor] Skipping position with untrusted P&L: ` +
          `tokenId=${signal.tokenId.slice(0, 12)}..., reason=${position.pnlUntrustedReason}`,
      );
      return {
        processed: true,
        action: "SKIPPED",
        reason: `P&L not trusted: ${position.pnlUntrustedReason || "unknown"}`,
        position,
      };
    }

    const pnlPct = position.pnlPct;

    // Check if position is profitable - "knee deep in positive"
    if (pnlPct >= this.config.profitThresholdToSkip) {
      this.logger.info(
        `[SellSignalMonitor] ✅ Position profitable (+${pnlPct.toFixed(1)}% >= ${this.config.profitThresholdToSkip}%), ` +
          `ignoring sell signal. tokenId=${signal.tokenId.slice(0, 12)}... trader=${signal.trader.slice(0, 10)}...`,
      );
      return {
        processed: true,
        action: "NONE",
        reason: `Position profitable (+${pnlPct.toFixed(1)}% >= ${this.config.profitThresholdToSkip}%)`,
        position,
      };
    }

    // Check if loss is below minimum threshold
    const lossPct = Math.abs(pnlPct);
    if (pnlPct >= 0 || lossPct < this.config.minLossPctToAct) {
      this.logger.debug(
        `[SellSignalMonitor] Loss too small to act: ${lossPct.toFixed(1)}% < ${this.config.minLossPctToAct}% threshold. ` +
          `tokenId=${signal.tokenId.slice(0, 12)}...`,
      );
      return {
        processed: true,
        action: "NONE",
        reason: `Loss (${lossPct.toFixed(1)}%) below threshold (${this.config.minLossPctToAct}%)`,
        position,
      };
    }

    // Determine action based on severity of loss
    let action: "HEDGE" | "STOP_LOSS";
    if (lossPct >= this.config.severeLossPct) {
      action = "STOP_LOSS";
      this.logger.warn(
        `[SellSignalMonitor] 🚨 SEVERE LOSS detected: ${lossPct.toFixed(1)}% >= ${this.config.severeLossPct}%. ` +
          `Triggering STOP-LOSS on tokenId=${signal.tokenId.slice(0, 12)}... ` +
          `triggered by trader=${signal.trader.slice(0, 10)}...`,
      );
    } else {
      action = "HEDGE";
      this.logger.info(
        `[SellSignalMonitor] ⚠️ MODERATE LOSS detected: ${lossPct.toFixed(1)}% ` +
          `(${this.config.minLossPctToAct}%-${this.config.severeLossPct}%). ` +
          `Triggering HEDGE on tokenId=${signal.tokenId.slice(0, 12)}... ` +
          `triggered by trader=${signal.trader.slice(0, 10)}...`,
      );
    }

    // Set cooldown before action to prevent rapid retries
    this.cooldowns.set(signal.tokenId, now + this.config.cooldownMs);
    this.cleanupExpiredCooldowns();

    // Execute action
    let success = false;
    try {
      if (action === "STOP_LOSS" && this.onTriggerStopLoss) {
        success = await this.onTriggerStopLoss(position, signal);
      } else if (action === "HEDGE" && this.onTriggerHedge) {
        success = await this.onTriggerHedge(position, signal);
      } else {
        this.logger.warn(
          `[SellSignalMonitor] No callback configured for action=${action}. Position not protected.`,
        );
      }

      if (success) {
        this.actionsTriggered++;
        this.logger.info(
          `[SellSignalMonitor] ✅ ${action} executed successfully for tokenId=${signal.tokenId.slice(0, 12)}...`,
        );
      } else {
        this.logger.warn(
          `[SellSignalMonitor] ⚠️ ${action} callback returned false for tokenId=${signal.tokenId.slice(0, 12)}...`,
        );
      }
    } catch (err) {
      this.logger.error(
        `[SellSignalMonitor] ❌ ${action} failed for tokenId=${signal.tokenId.slice(0, 12)}...: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      processed: true,
      action,
      reason: success
        ? `${action} executed successfully`
        : `${action} attempted (check logs for result)`,
      position,
    };
  }

  /**
   * Clean up expired cooldowns to prevent memory leaks
   */
  private cleanupExpiredCooldowns(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [tokenId, expiry] of this.cooldowns) {
      if (now >= expiry) {
        this.cooldowns.delete(tokenId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`[SellSignalMonitor] Cleaned up ${cleaned} expired cooldown(s)`);
    }
  }

  /**
   * Get service statistics
   */
  getStats(): {
    signalsProcessed: number;
    actionsTriggered: number;
    activeCooldowns: number;
  } {
    return {
      signalsProcessed: this.signalsProcessed,
      actionsTriggered: this.actionsTriggered,
      activeCooldowns: this.cooldowns.size,
    };
  }

  /**
   * Check if a specific position is currently in cooldown
   */
  isInCooldown(tokenId: string): boolean {
    const expiry = this.cooldowns.get(tokenId);
    return expiry !== undefined && Date.now() < expiry;
  }

  /**
   * Manually clear cooldown for a position (useful for testing)
   */
  clearCooldown(tokenId: string): void {
    this.cooldowns.delete(tokenId);
  }

  /**
   * Clear all cooldowns (useful for testing or reset)
   */
  clearAllCooldowns(): void {
    this.cooldowns.clear();
  }
}
