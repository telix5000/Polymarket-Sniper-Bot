import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import { QuickFlipStrategy } from "./quick-flip";
import { AutoSellStrategy } from "./auto-sell";
import { EndgameSweepStrategy } from "./endgame-sweep";
import { AutoRedeemStrategy } from "./auto-redeem";
import {
  UniversalStopLossStrategy,
  type UniversalStopLossConfig,
} from "./universal-stop-loss";
import {
  SmartHedgingStrategy,
  type SmartHedgingConfig,
  DEFAULT_SMART_HEDGING_CONFIG,
} from "./smart-hedging";
import { getPerformanceTracker } from "./strategy-performance";
import type { QuickFlipConfig } from "./quick-flip";
import type { AutoSellConfig } from "./auto-sell";
import type { EndgameSweepConfig } from "./endgame-sweep";
import type { AutoRedeemConfig } from "./auto-redeem";
import {
  POSITION_TRACKER_REFRESH_INTERVAL_MS,
  STRATEGY_EXECUTION_INTERVAL_MS,
} from "./constants";
// === INTEGRATED ENTERPRISE COMPONENTS ===
import { RiskManager, createRiskManager } from "./risk-manager";
import { PnLLedger } from "./pnl-ledger";
import { ExecutionEngine, createExecutionEngine } from "./execution-engine";
import { MarketSelector, createMarketSelector } from "./market-selector";

/**
 * Default Universal Stop-Loss configuration
 * Used when universalStopLossConfig is not provided to the orchestrator
 */
export const DEFAULT_UNIVERSAL_STOP_LOSS_CONFIG: UniversalStopLossConfig = {
  enabled: true,
  maxStopLossPct: 25, // Absolute ceiling - no position should lose more than 25%
  useDynamicTiers: true, // Use entry-price-based stop-loss tiers
  minHoldSeconds: 60, // Prevent premature sells due to bid-ask spread - wait 60s before stop-loss can trigger
};

export interface StrategyOrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  arbEnabled: boolean;
  monitorEnabled: boolean;
  quickFlipConfig: QuickFlipConfig;
  autoSellConfig: AutoSellConfig;
  endgameSweepConfig: EndgameSweepConfig;
  autoRedeemConfig: AutoRedeemConfig;
  universalStopLossConfig?: UniversalStopLossConfig;
  smartHedgingConfig?: SmartHedgingConfig;
  executionIntervalMs?: number;
  /**
   * Risk management preset - uses enterprise RiskManager for centralized risk control
   * If not provided, a default "balanced" RiskManager is created
   */
  riskPreset?: "conservative" | "balanced" | "aggressive";
}

/**
 * Strategy Orchestrator
 *
 * UNIFIED TRADING SYSTEM with integrated enterprise-grade risk management
 *
 * KEY FEATURES:
 * - Centralized RiskManager: ALL orders go through risk evaluation
 * - MAX_POSITION_USD enforcement: Per-market exposure limits
 * - Circuit breakers: Auto-halt on consecutive failures or drawdown
 * - In-flight tracking: Prevents order stacking race conditions
 *
 * EXECUTION MODEL:
 * - Phase 1 (Sequential): Capital-critical strategies that need guaranteed funds
 *   - Auto-Redeem: Frees up capital from resolved positions
 *   - Smart Hedging: Sells positions AND buys hedges atomically
 * - Phase 2 (Parallel): All other strategies compete for available capital
 *
 * Strategy Priority:
 * 1. Auto-Redeem - Claim resolved positions (capital recovery) [SEQUENTIAL]
 * 2. Smart Hedging - Hedge risky positions (sells + buys atomically) [SEQUENTIAL]
 * 3. Universal Stop-Loss - Protect higher-tier positions [SEQUENTIAL]
 * 4. Endgame Sweep - Buy high-confidence positions [SEQUENTIAL]
 * 5. Auto-Sell - Sell at threshold (free up capital) [SEQUENTIAL]
 * 6. Quick Flip - Take profits at target % [SEQUENTIAL]
 */
export class StrategyOrchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;

  // === CORE ENTERPRISE COMPONENTS ===
  private riskManager: RiskManager;
  private pnlLedger: PnLLedger;
  private executionEngine: ExecutionEngine;
  private marketSelector: MarketSelector;
  private positionTracker: PositionTracker;

  // === STRATEGIES ===
  private universalStopLossStrategy: UniversalStopLossStrategy;
  private smartHedgingStrategy: SmartHedgingStrategy;
  private quickFlipStrategy: QuickFlipStrategy;
  private autoSellStrategy: AutoSellStrategy;
  private endgameSweepStrategy: EndgameSweepStrategy;
  private autoRedeemStrategy: AutoRedeemStrategy;

  // === STATE ===
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

    // === INITIALIZE ENTERPRISE CORE COMPONENTS ===
    const riskPreset = config.riskPreset ?? "balanced";
    const maxPositionUsd = config.endgameSweepConfig.maxPositionUsd;

    // 1. Risk Manager - ALL orders go through this for approval
    this.riskManager = createRiskManager(riskPreset, this.logger, {
      maxExposurePerMarketUsd: maxPositionUsd,
      maxExposureUsd: maxPositionUsd * 10,
    });

    // 2. PnL Ledger - Track all profits and losses
    this.pnlLedger = new PnLLedger(this.logger);

    // 3. Execution Engine - Handles order execution with retries
    this.executionEngine = createExecutionEngine(
      this.client,
      this.logger,
      this.riskManager,
      riskPreset,
    );

    // 4. Market Selector - Filters markets by quality
    this.marketSelector = createMarketSelector(
      this.client,
      this.logger,
      riskPreset,
    );

    this.logger.info(
      `[Orchestrator] 🏢 Enterprise components initialized: RiskManager(${riskPreset}), PnLLedger, ExecutionEngine, MarketSelector`,
    );
    this.logger.info(
      `[Orchestrator] 💰 Position limits: maxPerMarket=$${maxPositionUsd}, maxTotal=$${maxPositionUsd * 10}`,
    );

    // Initialize position tracker
    this.positionTracker = new PositionTracker({
      client: config.client,
      logger: config.logger,
      refreshIntervalMs: POSITION_TRACKER_REFRESH_INTERVAL_MS,
    });

    // Initialize Smart Hedging FIRST (so we know if it's enabled for stop-loss config)
    const smartHedgingConfig =
      config.smartHedgingConfig ?? DEFAULT_SMART_HEDGING_CONFIG;
    this.smartHedgingStrategy = new SmartHedgingStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: smartHedgingConfig,
    });

    if (smartHedgingConfig.enabled) {
      // When allowExceedMaxForProtection is true, the effective max is absoluteMaxHedgeUsd
      const effectiveMaxHedge = smartHedgingConfig.allowExceedMaxForProtection
        ? smartHedgingConfig.absoluteMaxHedgeUsd
        : smartHedgingConfig.maxHedgeUsd;
      const exceedMsg = smartHedgingConfig.allowExceedMaxForProtection
        ? `allowExceed=true, base=$${smartHedgingConfig.maxHedgeUsd}`
        : `allowExceed=false`;
      this.logger.info(
        `[Orchestrator] 🛡️ Smart Hedging: ENABLED (trigger: -${smartHedgingConfig.triggerLossPct}%, max hedge: $${effectiveMaxHedge}, ${exceedMsg}, reserve: ${smartHedgingConfig.reservePct}%)`,
      );
    }

    // Initialize Universal Stop-Loss (SAFETY NET - runs on higher-tier positions)
    // When smart hedging is enabled, skip risky tier positions (they'll be hedged instead)
    const universalStopLossConfig =
      config.universalStopLossConfig ?? DEFAULT_UNIVERSAL_STOP_LOSS_CONFIG;

    // Auto-configure: skip risky tier if smart hedging is enabled
    const stopLossConfigWithHedging = {
      ...universalStopLossConfig,
      skipRiskyTierForHedging: smartHedgingConfig.enabled,
    };

    this.universalStopLossStrategy = new UniversalStopLossStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: stopLossConfigWithHedging,
    });

    if (universalStopLossConfig.enabled) {
      const hedgingNote = smartHedgingConfig.enabled
        ? " (risky tier → smart hedging)"
        : "";
      this.logger.info(
        `[Orchestrator] 🛡️ Universal Stop-Loss: ENABLED (max: ${universalStopLossConfig.maxStopLossPct}%, dynamic tiers: ${universalStopLossConfig.useDynamicTiers ? "ON" : "OFF"})${hedgingNote}`,
      );
    }

    // Initialize strategies
    // Auto-configure: skip risky tier if smart hedging is enabled (same as Universal Stop-Loss)
    // Use nullish coalescing to allow explicit override, but default to smart hedging status
    // Also ensure skipRiskyTierForHedging cannot be true when smart hedging is disabled
    const skipRiskyTier =
      config.quickFlipConfig.skipRiskyTierForHedging ??
      smartHedgingConfig.enabled;
    const quickFlipConfigWithHedging = {
      ...config.quickFlipConfig,
      skipRiskyTierForHedging: skipRiskyTier && smartHedgingConfig.enabled,
    };

    this.quickFlipStrategy = new QuickFlipStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: quickFlipConfigWithHedging,
    });

    if (
      config.quickFlipConfig.enabled &&
      quickFlipConfigWithHedging.skipRiskyTierForHedging
    ) {
      this.logger.info(
        `[Orchestrator] 🛡️ QuickFlip: risky-tier stop-loss deferred to Smart Hedging when eligible (may hedge instead of selling at loss)`,
      );
    }

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
      positionTracker: this.positionTracker, // Pass position tracker to check existing positions
      // Pass callback to get reserved balance from Smart Hedging
      // This ensures Endgame Sweep doesn't spend capital that Smart Hedging needs for hedges
      getReservedBalance: smartHedgingConfig.enabled
        ? () => this.smartHedgingStrategy.getRequiredReserve()
        : undefined,
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

    // Register strategies for performance tracking
    this.initializePerformanceTracking(config);
  }

  /**
   * Initialize performance tracking for dynamic allocation
   */
  private initializePerformanceTracking(
    config: StrategyOrchestratorConfig,
  ): void {
    const tracker = getPerformanceTracker();

    // Register each strategy with base allocation
    // Allocations are percentages that will be dynamically adjusted based on ROI
    if (config.autoRedeemConfig.enabled) {
      tracker.registerStrategy("auto-redeem", 20, 100);
    }
    // Register smart hedging for risky tier positions
    const smartHedgingConfig =
      config.smartHedgingConfig ?? DEFAULT_SMART_HEDGING_CONFIG;
    if (smartHedgingConfig.enabled) {
      tracker.registerStrategy(
        "smart-hedging",
        25,
        smartHedgingConfig.maxHedgeUsd,
      );
    }
    if (config.endgameSweepConfig.enabled) {
      tracker.registerStrategy(
        "endgame-sweep",
        30,
        config.endgameSweepConfig.maxPositionUsd,
      );
    }
    if (config.autoSellConfig.enabled) {
      tracker.registerStrategy("auto-sell", 20, 100);
    }
    if (config.quickFlipConfig.enabled) {
      tracker.registerStrategy("quick-flip", 30, 100);
    }

    this.logger.info(
      "[Orchestrator] 📊 Performance tracking initialized for dynamic allocation",
    );
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

    // Log performance summary periodically
    setInterval(
      () => {
        const tracker = getPerformanceTracker();
        const summary = tracker.getSummary();
        if (summary !== "No strategies tracked") {
          this.logger.info(`[Orchestrator] 📊 Performance:\n${summary}`);
        }
        tracker.pruneHistory(); // Clean up old data

        // Also log PnL summary
        const pnlSummary = this.pnlLedger.getSummary();
        this.logger.info(
          `[Orchestrator] 💰 PnL: realized=$${pnlSummary.totalRealizedPnl.toFixed(2)}, ` +
            `unrealized=$${pnlSummary.totalUnrealizedPnl.toFixed(2)}, ` +
            `fees=$${pnlSummary.totalFees.toFixed(2)}, ` +
            `net=$${pnlSummary.netPnl.toFixed(2)}, ` +
            `winRate=${(pnlSummary.winRate * 100).toFixed(1)}%`,
        );
      },
      5 * 60 * 1000,
    ); // Every 5 minutes

    this.logger.info(
      `[Orchestrator] ✅ Started (execution interval: ${this.executionIntervalMs}ms)`,
    );
  }

  /**
   * Get the position tracker instance
   * Used by TradeExecutorService to check existing positions before buying
   */
  getPositionTracker(): PositionTracker {
    return this.positionTracker;
  }

  /**
   * Get the risk manager instance
   * Used for centralized risk evaluation across all strategies
   */
  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  /**
   * Get the PnL ledger instance
   * Used for tracking profits and losses
   */
  getPnLLedger(): PnLLedger {
    return this.pnlLedger;
  }

  /**
   * Get the execution engine instance
   * Used for executing orders with risk checks
   */
  getExecutionEngine(): ExecutionEngine {
    return this.executionEngine;
  }

  /**
   * Get the market selector instance
   * Used for filtering markets by quality criteria
   */
  getMarketSelector(): MarketSelector {
    return this.marketSelector;
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
   *
   * EXECUTION MODEL:
   * - Phase 1 (Sequential): Capital-critical strategies that need guaranteed funds
   *   - Auto-Redeem: Frees up capital from resolved positions
   *   - Smart Hedging: Sells positions AND buys hedges (needs capital reservation)
   * - Phase 2 (Parallel): All other strategies that compete for available capital
   *
   * ALL SEQUENTIAL - No parallel execution to prevent race conditions and order stacking
   */
  private async executeStrategies(): Promise<void> {
    this.logger.debug("[Orchestrator] Executing strategies (all sequential)");

    try {
      // ALL strategies run sequentially to prevent race conditions
      // This ensures position checks are accurate before each strategy runs
      // Each strategy is wrapped in try-catch to prevent blocking subsequent execution

      // Priority 1: Auto-Redeem (claim resolved positions - highest priority for capital recovery)
      try {
        await this.executeWithLogging(
          "Auto-Redeem",
          1,
          () => this.autoRedeemStrategy.execute(),
          this.autoRedeemStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Auto-Redeem failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Priority 2: Smart Hedging (HEDGE risky tier positions instead of selling at loss)
      try {
        await this.executeWithLogging(
          "Smart Hedging",
          2,
          () => this.smartHedgingStrategy.execute(),
          this.smartHedgingStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Smart Hedging failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Priority 3: Universal Stop-Loss (protect positions from excessive loss)
      try {
        await this.executeWithLogging(
          "Universal Stop-Loss",
          3,
          () => this.universalStopLossStrategy.execute(),
          this.universalStopLossStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Universal Stop-Loss failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Priority 4: Endgame Sweep (buy high-confidence positions)
      try {
        await this.executeWithLogging(
          "Endgame Sweep",
          4,
          () => this.endgameSweepStrategy.execute(),
          this.endgameSweepStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Endgame Sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Priority 5: Auto-Sell (sell positions near resolution)
      try {
        await this.executeWithLogging(
          "Auto-Sell",
          5,
          () => this.autoSellStrategy.execute(),
          this.autoSellStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Auto-Sell failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Priority 6: Quick Flip (take profits on winning positions)
      try {
        await this.executeWithLogging(
          "Quick Flip",
          6,
          () => this.quickFlipStrategy.execute(),
          this.quickFlipStrategy.getStats().enabled,
        );
      } catch (err) {
        this.logger.error(
          `[Orchestrator] Quick Flip failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Note: ARB engine and Monitor run in their own loops alongside this orchestrator
      this.logger.debug(
        `[Orchestrator] ARB=${this.arbEnabled ? "active" : "off"} Monitor=${this.monitorEnabled ? "active" : "off"}`,
      );
    } catch (err) {
      this.logger.error(
        "[Orchestrator] Error during strategy execution",
        err as Error,
      );
    }
  }

  /**
   * Execute a strategy with logging
   */
  private async executeWithLogging(
    name: string,
    priority: number,
    execute: () => Promise<number>,
    enabled: boolean,
  ): Promise<number> {
    if (!enabled) {
      this.logger.debug(
        `[Orchestrator] ${name} is disabled (Priority ${priority})`,
      );
      return 0;
    }

    try {
      const count = await execute();
      if (count > 0) {
        this.logger.info(
          `[Orchestrator] 💰 Priority ${priority}: ${name} executed ${count} trade(s)`,
        );
      }
      return count;
    } catch (err) {
      this.logger.error(`[Orchestrator] ${name} failed`, err as Error);
      throw err;
    }
  }

  /**
   * Get orchestrator statistics
   */
  getStats(): {
    isRunning: boolean;
    arbEnabled: boolean;
    monitorEnabled: boolean;
    universalStopLossStats: ReturnType<UniversalStopLossStrategy["getStats"]>;
    smartHedgingStats: ReturnType<SmartHedgingStrategy["getStats"]>;
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
      universalStopLossStats: this.universalStopLossStrategy.getStats(),
      smartHedgingStats: this.smartHedgingStrategy.getStats(),
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
