import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import { QuickFlipStrategy } from "./quick-flip";
import { AutoSellStrategy } from "./auto-sell";
import { EndgameSweepStrategy } from "./endgame-sweep";
import { AutoRedeemStrategy } from "./auto-redeem";
import type { QuickFlipConfig } from "./quick-flip";
import type { AutoSellConfig } from "./auto-sell";
import type { EndgameSweepConfig } from "./endgame-sweep";
import type { AutoRedeemConfig } from "./auto-redeem";
import {
  POSITION_TRACKER_REFRESH_INTERVAL_MS,
  STRATEGY_EXECUTION_INTERVAL_MS,
} from "./constants";

export interface StrategyOrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  arbEnabled: boolean;
  monitorEnabled: boolean;
  quickFlipConfig: QuickFlipConfig;
  autoSellConfig: AutoSellConfig;
  endgameSweepConfig: EndgameSweepConfig;
  autoRedeemConfig: AutoRedeemConfig;
  executionIntervalMs?: number;
}

/**
 * Strategy Orchestrator
 * Executes strategies in priority order to maximize returns while managing risk
 *
 * Priority Order:
 * 1. Auto-Redeem (claim resolved positions - highest priority for capital recovery)
 * 2. Risk-Free Arb (existing YES/NO < $1.00)
 * 3. Endgame Sweep (buy 98-99¢)
 * 4. Auto-Sell near $1.00 (configurable threshold, frees up capital)
 * 5. Quick Flip (sell at +5% gain)
 * 6. Whale Copy (existing monitor strategy)
 */
export class StrategyOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private quickFlipStrategy: QuickFlipStrategy;
  private autoSellStrategy: AutoSellStrategy;
  private endgameSweepStrategy: EndgameSweepStrategy;
  private autoRedeemStrategy: AutoRedeemStrategy;
  private arbEnabled: boolean;
  private monitorEnabled: boolean;
  private executionIntervalMs: number;
  private executionTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(config: StrategyOrchestratorConfig) {
    this.client = config.client;
    this.logger = config.logger;
    this.arbEnabled = config.arbEnabled;
    this.monitorEnabled = config.monitorEnabled;
    this.executionIntervalMs =
      config.executionIntervalMs ?? STRATEGY_EXECUTION_INTERVAL_MS;

    // Initialize position tracker
    this.positionTracker = new PositionTracker({
      client: config.client,
      logger: config.logger,
      refreshIntervalMs: POSITION_TRACKER_REFRESH_INTERVAL_MS,
    });

    // Initialize strategies
    this.quickFlipStrategy = new QuickFlipStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: config.quickFlipConfig,
    });

    this.autoSellStrategy = new AutoSellStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: config.autoSellConfig,
    });

    // Log safety warning about position sizing
    if (config.endgameSweepConfig.enabled) {
      const maxPos = config.endgameSweepConfig.maxPositionUsd;
      if (maxPos > 50) {
        this.logger.warn(
          `⚠️  MAX_POSITION_USD is set to $${maxPos} - this is VERY HIGH and may deplete your wallet quickly!`,
        );
      }
      this.logger.info(
        `[Orchestrator] Endgame Sweep: Max $${maxPos} per position (can buy multiple positions simultaneously)`,
      );
    }

    this.endgameSweepStrategy = new EndgameSweepStrategy({
      client: config.client,
      logger: config.logger,
      config: config.endgameSweepConfig,
    });

    // Initialize auto-redeem strategy (claims resolved positions)
    this.autoRedeemStrategy = new AutoRedeemStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: config.autoRedeemConfig,
    });

    if (config.autoRedeemConfig.enabled) {
      this.logger.info(
        `[Orchestrator] Auto-Redeem: Enabled (min position: $${config.autoRedeemConfig.minPositionUsd})`,
      );
    }
  }

  /**
   * Start the strategy orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("[Orchestrator] ⚠️ Already running");
      return;
    }

    this.logger.info("[Orchestrator] 🚀 Starting strategy orchestrator");
    this.isRunning = true;

    // Start position tracker and await initial refresh to ensure data is available
    await this.positionTracker.start();

    // Run initial execution
    await this.executeStrategies();

    // Set up periodic execution
    this.executionTimer = setInterval(() => {
      this.executeStrategies().catch((err) => {
        this.logger.error("[Orchestrator] Execution failed", err as Error);
      });
    }, this.executionIntervalMs);

    this.logger.info(
      `[Orchestrator] ✅ Started (execution interval: ${this.executionIntervalMs}ms)`,
    );
  }

  /**
   * Stop the strategy orchestrator
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.logger.info("[Orchestrator] 🛑 Stopping strategy orchestrator");

    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.positionTracker.stop();
    this.isRunning = false;

    this.logger.info("[Orchestrator] ✅ Stopped");
  }

  /**
   * Execute all strategies in priority order
   */
  private async executeStrategies(): Promise<void> {
    this.logger.debug("[Orchestrator] Executing strategies");

    try {
      // Priority 1: Auto-Redeem (claim resolved positions - highest priority for capital recovery)
      const autoRedeemEnabled = this.autoRedeemStrategy.getStats().enabled;
      this.logger.debug(
        `[Orchestrator] Auto-Redeem is ${autoRedeemEnabled ? "active" : "disabled"} (Priority 1)`,
      );
      const redeemCount = await this.autoRedeemStrategy.execute();
      if (redeemCount > 0) {
        this.logger.info(
          `[Orchestrator] 💵 Priority 1: Auto-Redeem claimed ${redeemCount} resolved position(s)`,
        );
      }

      // Priority 2: Risk-Free Arb (handled by existing arbitrage engine)
      // This runs continuously in its own loop
      this.logger.debug(
        `[Orchestrator] ARB engine is ${this.arbEnabled ? "active" : "disabled"} (Priority 2)`,
      );

      // Priority 3: Endgame Sweep (buy 98-99¢)
      const endgameEnabled = this.endgameSweepStrategy.getStats().enabled;
      this.logger.debug(
        `[Orchestrator] Endgame Sweep is ${endgameEnabled ? "active" : "disabled"} (Priority 3)`,
      );
      const endgameCount = await this.endgameSweepStrategy.execute();
      if (endgameCount > 0) {
        this.logger.info(
          `[Orchestrator] 💰 Priority 3: Endgame Sweep executed ${endgameCount} trades`,
        );
      }

      // Priority 4: Auto-Sell at 99¢ (free up capital)
      const autoSellEnabled = this.autoSellStrategy.getStats().enabled;
      this.logger.debug(
        `[Orchestrator] Auto-Sell is ${autoSellEnabled ? "active" : "disabled"} (Priority 4)`,
      );
      const autoSellCount = await this.autoSellStrategy.execute();
      if (autoSellCount > 0) {
        this.logger.info(
          `[Orchestrator] 📤 Priority 4: Auto-Sell executed ${autoSellCount} trades`,
        );
      }

      // Priority 5: Quick Flip (sell at +5% gain)
      const quickFlipEnabled = this.quickFlipStrategy.getStats().enabled;
      this.logger.debug(
        `[Orchestrator] Quick Flip is ${quickFlipEnabled ? "active" : "disabled"} (Priority 5)`,
      );
      const quickFlipCount = await this.quickFlipStrategy.execute();
      if (quickFlipCount > 0) {
        this.logger.info(
          `[Orchestrator] 💹 Priority 5: Quick Flip executed ${quickFlipCount} trades`,
        );
      }

      // Priority 6: Whale Copy (handled by existing monitor service)
      // This runs continuously in its own loop
      this.logger.debug(
        `[Orchestrator] Monitor service is ${this.monitorEnabled ? "active" : "disabled"} (Priority 6)`,
      );

      this.logger.debug("[Orchestrator] Strategy execution complete");
    } catch (err) {
      this.logger.error(
        "[Orchestrator] Error during strategy execution",
        err as Error,
      );
    }
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    isRunning: boolean;
    arbEnabled: boolean;
    monitorEnabled: boolean;
    quickFlipStats: ReturnType<QuickFlipStrategy["getStats"]>;
    autoSellStats: ReturnType<AutoSellStrategy["getStats"]>;
    endgameSweepStats: ReturnType<EndgameSweepStrategy["getStats"]>;
    autoRedeemStats: ReturnType<AutoRedeemStrategy["getStats"]>;
    trackedPositions: number;
  } {
    return {
      isRunning: this.isRunning,
      arbEnabled: this.arbEnabled,
      monitorEnabled: this.monitorEnabled,
      quickFlipStats: this.quickFlipStrategy.getStats(),
      autoSellStats: this.autoSellStrategy.getStats(),
      endgameSweepStats: this.endgameSweepStrategy.getStats(),
      autoRedeemStats: this.autoRedeemStrategy.getStats(),
      trackedPositions: this.positionTracker.getPositions().length,
    };
  }

  /**
   * Get access to the auto-redeem strategy for manual redemptions
   */
  getAutoRedeemStrategy(): AutoRedeemStrategy {
    return this.autoRedeemStrategy;
  }

  /**
   * Check if a trade should be executed based on orchestrator state
   * This can be called by ARB engine to check if it should proceed
   */
  canExecuteTrade(strategyName: string): boolean {
    // Always allow if orchestrator is not running
    if (!this.isRunning) {
      return true;
    }

    // ARB and MONITOR strategies can always execute
    // They run independently but are coordinated by priority
    if (strategyName === "arb" || strategyName === "monitor") {
      return true;
    }

    return false;
  }
}
