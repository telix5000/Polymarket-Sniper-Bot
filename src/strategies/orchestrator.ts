/**
 * Strategy Orchestrator
 *
 * Runs all strategies SEQUENTIALLY in priority order.
 * No parallel execution = no race conditions = no order stacking.
 *
 * SINGLE-FLIGHT GUARANTEE:
 * - Only ONE orchestrator cycle runs at a time (global lock)
 * - If a timer tick fires while a cycle is running, it is SKIPPED
 * - Each strategy also has its own in-flight guard to prevent re-entrancy
 * - PositionTracker refresh is single-flight and awaitable
 *
 * EXECUTION ORDER:
 * 1. Refresh PositionTracker (single-flight, awaited by all strategies)
 * 2. SellEarly - CAPITAL EFFICIENCY: Sell near-$1 ACTIVE positions (99.9¢+)
 * 3. AutoSell - NEAR-RESOLUTION EXIT: Sell ACTIVE positions at 99¢+ (dispute exit at 99.9¢)
 * 4. OnChainExit - Route NOT_TRADABLE positions to on-chain redemption (≥99¢)
 * 5. Auto-Redeem - Claim REDEEMABLE positions (get money back!)
 * 6. Hedging - Hedge losing positions
 * 7. Stop-Loss - Sell positions at max loss
 * 8. Scalp Take-Profit - Time-based profit taking with momentum checks
 * 9. Position Stacking - Double down on winning positions
 * 10. Endgame Sweep - Buy high-confidence positions
 * 11. Arbitrage - Scan markets for yes+no < $1 opportunities (optional)
 */

import { randomUUID } from "crypto";
import type { ClobClient } from "@polymarket/clob-client";
import type { ConsoleLogger } from "../utils/logger.util";
import { PositionTracker } from "./position-tracker";
import { LogDeduper, HEARTBEAT_INTERVAL_MS } from "../utils/log-deduper.util";
import {
  HedgingStrategy,
  type HedgingConfig,
  DEFAULT_HEDGING_CONFIG,
} from "./hedging";
import {
  EndgameSweepStrategy,
  type EndgameSweepConfig,
  DEFAULT_ENDGAME_CONFIG,
} from "./endgame-sweep";
// Quick Flip module removed - functionality covered by ScalpTrade
// SellEarly module removed - functionality consolidated into AutoSell
import {
  ScalpTradeStrategy,
  type ScalpTradeConfig,
  DEFAULT_SCALP_TRADE_CONFIG,
} from './scalp-trade';
import { AutoRedeemStrategy, type AutoRedeemConfig } from "./auto-redeem";
import {
  AutoSellStrategy,
  type AutoSellConfig,
  DEFAULT_AUTO_SELL_CONFIG,
} from "./auto-sell";
import {
  OnChainExitStrategy,
  type OnChainExitConfig,
  DEFAULT_ON_CHAIN_EXIT_CONFIG,
} from "./on-chain-exit";
import {
  StopLossStrategy,
  type StopLossConfig,
} from "./stop-loss";
import {
  PositionStackingStrategy,
  type PositionStackingConfig,
  DEFAULT_POSITION_STACKING_CONFIG,
} from "./position-stacking";
import {
  ArbitrageStrategy,
  type ArbitrageStrategyConfig,
  DEFAULT_ARBITRAGE_STRATEGY_CONFIG,
} from "./arbitrage";
import { RiskManager, createRiskManager } from "./risk-manager";
import { PnLLedger, type LedgerSummary } from "./pnl-ledger";
import type { RelayerContext } from "../polymarket/relayer";
import {
  DynamicReservesController,
  createDynamicReservesController,
  type DynamicReservesConfig,
  type ReservePlan,
  type WalletBalances,
} from "../risk";

const POSITION_REFRESH_MS = 5000; // 5 seconds
const EXECUTION_INTERVAL_MS = 2000; // 2 seconds
const TICK_SKIPPED_LOG_INTERVAL_MS = 60_000; // Log "tick skipped" at most once per minute

export interface OrchestratorConfig {
  client: ClobClient;
  logger: ConsoleLogger;
  maxPositionUsd: number; // From MAX_POSITION_USD env
  riskPreset?: "conservative" | "balanced" | "aggressive";
  hedgingConfig?: Partial<HedgingConfig>;
  endgameConfig?: Partial<EndgameSweepConfig>;
  // quickFlipConfig removed - module deprecated
  // sellEarlyConfig removed - consolidated into autoSellConfig
  scalpConfig?: Partial<ScalpTradeConfig>;
  autoRedeemConfig?: Partial<AutoRedeemConfig>;
  autoSellConfig?: Partial<AutoSellConfig>;
  onChainExitConfig?: Partial<OnChainExitConfig>;
  stopLossConfig?: Partial<StopLossConfig>;
  dynamicReservesConfig?: Partial<DynamicReservesConfig>;
  positionStackingConfig?: Partial<PositionStackingConfig>;
  arbitrageConfig?: Partial<ArbitrageStrategyConfig>;
  /** Wallet balance fetcher for dynamic reserves (optional - if not provided, reserves are disabled) */
  getWalletBalances?: () => Promise<WalletBalances>;
}

export class Orchestrator {
  private client: ClobClient;
  private logger: ConsoleLogger;
  private positionTracker: PositionTracker;
  private riskManager: RiskManager;
  private pnlLedger: PnLLedger;
  private dynamicReserves: DynamicReservesController;
  private getWalletBalances?: () => Promise<WalletBalances>;

  // All strategies
  // sellEarlyStrategy removed - consolidated into autoSellStrategy
  private autoSellStrategy: AutoSellStrategy;
  private onChainExitStrategy: OnChainExitStrategy;
  private autoRedeemStrategy: AutoRedeemStrategy;
  private hedgingStrategy: HedgingStrategy;
  private stopLossStrategy: StopLossStrategy;
  private scalpStrategy: ScalpTradeStrategy;
  private endgameStrategy: EndgameSweepStrategy;
  private positionStackingStrategy: PositionStackingStrategy;
  private arbitrageStrategy?: ArbitrageStrategy;
  // quickFlipStrategy removed - module deprecated

  private executionTimer?: NodeJS.Timeout;
  private isRunning = false;

  // === SINGLE-FLIGHT CYCLE LOCK ===
  // Prevents overlapping orchestrator cycles (re-entrancy protection)
  private cycleInFlight = false;
  private cycleId = 0;

  // Unique boot ID to detect multiple orchestrator instances
  private readonly bootId: string;

  // === OBSERVABILITY COUNTERS ===
  private ticksFired = 0;
  private cyclesRun = 0;
  private ticksSkippedDueToInflight = 0;
  private lastTickSkippedLogAt = 0;

  // === LOG DEDUPLICATION ===
  // Prevents repetitive logging of slow strategies
  private logDeduper = new LogDeduper();
  // Track last logged slow strategies for change detection
  private lastSlowStrategiesFingerprint = "";

  // === CURRENT RESERVE PLAN ===
  // Computed once per cycle and passed to strategies that need it
  private currentReservePlan: ReservePlan | null = null;

  constructor(config: OrchestratorConfig) {
    this.client = config.client;
    this.logger = config.logger;

    // Generate unique boot ID to detect multiple orchestrator instances
    this.bootId = randomUUID().slice(0, 8);
    this.logger.info(
      `[Orchestrator] Boot ID: ${this.bootId} - only ONE instance should exist`,
    );

    // Initialize core components
    const riskPreset = config.riskPreset ?? "balanced";
    this.riskManager = createRiskManager(riskPreset, this.logger, {
      maxExposurePerMarketUsd: config.maxPositionUsd,
      maxExposureUsd: config.maxPositionUsd * 10,
    });

    this.pnlLedger = new PnLLedger(this.logger);

    this.positionTracker = new PositionTracker({
      client: config.client,
      logger: config.logger,
      refreshIntervalMs: POSITION_REFRESH_MS,
    });

    // Initialize Dynamic Reserves Controller
    // Aligns hedgeCapUsd with HEDGING_ABSOLUTE_MAX_USD (or DEFAULT_RESERVES_CONFIG default)
    this.dynamicReserves = createDynamicReservesController(this.logger, {
      hedgeCapUsd: config.hedgingConfig?.absoluteMaxUsd,
      ...config.dynamicReservesConfig,
    });
    this.getWalletBalances = config.getWalletBalances;

    // === INITIALIZE ALL STRATEGIES ===

    // Extract relayer context from client (set by preflight if available)
    const relayerContext = (
      config.client as { relayerContext?: RelayerContext }
    ).relayerContext;

    // 1. AutoSell - CAPITAL EFFICIENCY: Sell near-$1 ACTIVE positions (99.9¢+)
    // Consolidated strategy handling: dispute window exit (99.9¢), stale positions, quick wins
    // Only applies to ACTIVE (non-redeemable) positions with valid execution status
    this.autoSellStrategy = new AutoSellStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_AUTO_SELL_CONFIG,
        minOrderUsd: config.maxPositionUsd * 0.01, // 1% of max position as min order
        ...config.autoSellConfig,
      },
    });

    // 2. OnChainExit - Route NOT_TRADABLE positions to on-chain redemption
    // When positions can't be sold via CLOB (executionStatus=NOT_TRADABLE_ON_CLOB)
    // but have high currentPrice (≥99¢), check if they can be redeemed on-chain.
    // Runs BEFORE Auto-Redeem to prepare positions for redemption.
    this.onChainExitStrategy = new OnChainExitStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_ON_CHAIN_EXIT_CONFIG,
        ...config.onChainExitConfig,
      },
    });

    // 3. Auto-Redeem - Claim REDEEMABLE positions (get money back!)
    // AutoRedeem fetches positions directly from Data API and checks on-chain
    // payoutDenominator - it does NOT use PositionTracker.
    this.autoRedeemStrategy = new AutoRedeemStrategy({
      client: config.client,
      logger: config.logger,
      relayer: relayerContext,
      config: {
        enabled: true,
        minPositionUsd: 0, // Default: redeem anything (no minimum threshold)
        checkIntervalMs: 30000, // Check every 30s
        ...config.autoRedeemConfig,
      },
      // Provide callback to get position P&L data for realized gains calculation
      getPositionPnL: (tokenId: string) => {
        const snapshot = this.positionTracker.getSnapshot();
        if (!snapshot) return undefined;

        // Check both active and redeemable positions
        const allPositions = [
          ...snapshot.activePositions,
          ...snapshot.redeemablePositions,
        ];
        const position = allPositions.find((p) => p.tokenId === tokenId);
        if (!position) return undefined;

        return {
          entryPrice: position.entryPrice,
          pnlUsd: position.pnlUsd,
        };
      },
    });

    // 4. Hedging - Hedge losing positions
    const hedgingConfig = {
      ...DEFAULT_HEDGING_CONFIG,
      maxHedgeUsd: config.maxPositionUsd,
      ...config.hedgingConfig,
    };
    this.hedgingStrategy = new HedgingStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: hedgingConfig,
      // Inject reserve plan getter for reserve-aware hedging
      getReservePlan: () => this.currentReservePlan,
    });

    // 5. Stop-Loss - Protect against big losses
    // When Hedging is enabled, skip positions it handles (entry < maxEntryPrice)
    const hedgingEnabled = hedgingConfig.enabled;
    this.stopLossStrategy = new StopLossStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        enabled: true,
        maxStopLossPct: 25, // Max 25% loss
        useDynamicTiers: true,
        minHoldSeconds: 60, // Wait 60s before stop-loss
        // Skip positions that Hedging handles (below its maxEntryPrice)
        skipForSmartHedging: hedgingEnabled,
        hedgingMaxEntryPrice: hedgingConfig.maxEntryPrice,
        ...config.stopLossConfig,
      },
    });

    // 6. Endgame Sweep - Buy high-confidence positions
    this.endgameStrategy = new EndgameSweepStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_ENDGAME_CONFIG,
        maxPositionUsd: config.maxPositionUsd,
        ...config.endgameConfig,
      },
    });

    // 7. Scalp Take-Profit - Time-and-momentum-based profit taking
    // Enabled by default - takes profits on positions after holding 45-90 min
    // with 5%+ profit, or captures sudden spikes (15%+ in 10 min)
    // CRITICAL: Never forces time-exit on ≤60¢ entries that reach 90¢+
    this.scalpStrategy = new ScalpTradeStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_SCALP_TRADE_CONFIG,
        ...config.scalpConfig,
      },
    });

    // 8. Position Stacking - Double down on winning positions
    // Stack once at MAX_POSITION_USD when position is up 20+ cents from entry
    // Enabled by default - capitalizes on momentum in winning positions
    this.positionStackingStrategy = new PositionStackingStrategy({
      client: config.client,
      logger: config.logger,
      positionTracker: this.positionTracker,
      config: {
        ...DEFAULT_POSITION_STACKING_CONFIG,
        maxStackUsd: config.maxPositionUsd,
        ...config.positionStackingConfig,
      },
    });

    // 9. Arbitrage - Scan markets for yes+no < $1 opportunities
    // Only initialize if config is provided (requires arbConfig with all settings)
    if (config.arbitrageConfig?.enabled && config.arbitrageConfig?.arbConfig) {
      // Cast client to include wallet (required by ArbitrageStrategy)
      const clientWithWallet = config.client as ClobClient & { wallet: import("ethers").Wallet };
      if (clientWithWallet.wallet) {
        this.arbitrageStrategy = new ArbitrageStrategy({
          client: clientWithWallet,
          logger: config.logger,
          config: {
            ...DEFAULT_ARBITRAGE_STRATEGY_CONFIG,
            ...config.arbitrageConfig,
          } as ArbitrageStrategyConfig,
        });
      } else {
        config.logger.warn(
          "[Orchestrator] Arbitrage enabled but client.wallet not available - skipping",
        );
      }
    }

    // Quick Flip module removed - ScalpTrade handles profit-taking

    this.logger.info(
      `[Orchestrator] Initialized with maxPosition=$${config.maxPositionUsd}`,
    );
  }

  /**
   * Start the orchestrator
   * Creates exactly ONE timer for the execution loop.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(
        `[Orchestrator] Already running (bootId=${this.bootId}), ignoring duplicate start()`,
      );
      return;
    }

    this.logger.info(`[Orchestrator] 🚀 Starting... (bootId=${this.bootId})`);

    // Start position tracking
    await this.positionTracker.start();

    // Start strategy execution loop - SINGLE TIMER
    this.isRunning = true;
    this.executionTimer = setInterval(
      () => this.onTick(),
      EXECUTION_INTERVAL_MS,
    );

    this.logger.info(
      `[Orchestrator] ✅ Started with ${EXECUTION_INTERVAL_MS}ms interval (bootId=${this.bootId})`,
    );
  }

  /**
   * Timer tick handler
   * Implements single-flight protection: skips if a cycle is already running
   */
  private onTick(): void {
    this.ticksFired++;

    // SINGLE-FLIGHT GUARD: Skip if cycle already in flight
    if (this.cycleInFlight) {
      this.ticksSkippedDueToInflight++;

      // Rate-limit "tick skipped" logging to once per minute
      const now = Date.now();
      if (now - this.lastTickSkippedLogAt >= TICK_SKIPPED_LOG_INTERVAL_MS) {
        this.logger.debug(
          `[Orchestrator] Tick skipped - cycle in flight (skipped=${this.ticksSkippedDueToInflight} total)`,
        );
        this.lastTickSkippedLogAt = now;
      }
      return;
    }

    // Start a new cycle (fire-and-forget, but guarded)
    this.executeStrategies().catch((err) => {
      this.logger.error(
        `[Orchestrator] Cycle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Execute all strategies sequentially
   * ORDER MATTERS - higher priority strategies run first
   *
   * SINGLE-FLIGHT GUARANTEE:
   * - Sets cycleInFlight=true at start, false at end
   * - If already in flight (should not happen due to onTick guard), returns immediately
   * - Each strategy is invoked exactly once per cycle
   */
  private async executeStrategies(): Promise<void> {
    if (!this.isRunning) return;

    // Double-check single-flight (belt-and-suspenders with onTick guard)
    if (this.cycleInFlight) {
      this.logger.warn(
        `[Orchestrator] executeStrategies called while cycle in flight - skipping`,
      );
      return;
    }

    // Acquire cycle lock
    this.cycleInFlight = true;
    this.cycleId++;
    this.cyclesRun++;
    const currentCycleId = this.cycleId;
    const cycleStartTime = Date.now();

    this.logger.debug(
      `[Orchestrator] cycle=${currentCycleId} start (ticksFired=${this.ticksFired}, skipped=${this.ticksSkippedDueToInflight})`,
    );

    const strategyTimings: Array<{ name: string; durationMs: number }> = [];

    try {
      // Phase 1: Refresh positions (single-flight, shared by all strategies)
      // This ensures all strategies see consistent position data
      const refreshStart = Date.now();
      // Set cycle ID before refresh so snapshot is tagged correctly
      this.positionTracker.setCycleId(currentCycleId);
      await this.positionTracker.awaitCurrentRefresh();
      strategyTimings.push({
        name: "PositionRefresh",
        durationMs: Date.now() - refreshStart,
      });

      // Get the immutable snapshot for this cycle
      // All strategies MUST use this snapshot, not call PositionTracker methods directly
      const snapshot = this.positionTracker.getSnapshot();
      if (!snapshot) {
        this.logger.error(
          `[Orchestrator] cycle=${currentCycleId} ERROR: No snapshot available after refresh`,
        );
        return;
      }

      // Phase 1.5: Compute reserve plan for this cycle
      // This gates BUY strategies when reserves are insufficient
      if (this.getWalletBalances) {
        try {
          const balances = await this.getWalletBalances();
          this.currentReservePlan = this.dynamicReserves.computeReservePlan(
            snapshot,
            balances,
          );
        } catch (err) {
          this.logger.debug(
            `[Orchestrator] Failed to compute reserve plan: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Continue without reserve gating if balance fetch fails
          this.currentReservePlan = null;
        }
      }

      // Phase 2: Capital efficiency and redemption
      // 1. AutoSell - CAPITAL EFFICIENCY - sell near-$1 ACTIVE positions (99.9¢+)
      //    Consolidated strategy: handles dispute window exit, stale positions, quick wins
      await this.runStrategyTimed(
        "AutoSell",
        () => this.autoSellStrategy.execute(),
        strategyTimings,
      );

      // 2. OnChainExit - Route NOT_TRADABLE positions to on-chain redemption
      //    Handles positions that AutoSell skips (executionStatus=NOT_TRADABLE_ON_CLOB)
      //    but have high currentPrice (≥99¢) and can be redeemed on-chain
      await this.runStrategyTimed(
        "OnChainExit",
        () => this.onChainExitStrategy.execute(),
        strategyTimings,
      );

      // 3. Auto-Redeem - get money back from REDEEMABLE positions
      await this.runStrategyTimed(
        "AutoRedeem",
        () => this.autoRedeemStrategy.execute(),
        strategyTimings,
      );

      // Phase 3: Risk management
      // 4. Hedging - protect losing positions by buying opposite side
      await this.runStrategyTimed(
        "Hedging",
        () => this.hedgingStrategy.execute(),
        strategyTimings,
      );

      // 5. Stop-Loss - sell positions exceeding max loss threshold
      await this.runStrategyTimed(
        "StopLoss",
        () => this.stopLossStrategy.execute(),
        strategyTimings,
      );

      // Phase 4: Trading strategies
      // 6. Scalp Take-Profit - time-based profit taking with momentum checks
      // CRITICAL: Pass snapshot to ensure ScalpTrade uses same data as PositionTracker
      await this.runStrategyTimed(
        "ScalpTrade",
        () => this.scalpStrategy.execute(snapshot),
        strategyTimings,
      );

      // 7. Position Stacking - double down on winning positions
      // Stack once per position at MAX_POSITION_USD when up 20+ cents from entry
      // Pass snapshot and reserve plan for RISK_OFF gating
      await this.runStrategyTimed(
        "PositionStacking",
        () =>
          this.positionStackingStrategy.execute(
            snapshot,
            this.currentReservePlan ?? undefined,
          ),
        strategyTimings,
      );

      // 8. Endgame Sweep - buy high-confidence positions (85-99¢)
      // Pass reserve plan for RISK_OFF gating (blocks BUYs when reserves insufficient)
      await this.runStrategyTimed(
        "Endgame",
        () =>
          this.endgameStrategy.execute(this.currentReservePlan ?? undefined),
        strategyTimings,
      );

      // 9. Arbitrage - Scan markets for yes+no < $1 opportunities
      // Runs last as it scans ALL markets (not just positions)
      if (this.arbitrageStrategy) {
        await this.runStrategyTimed(
          "Arbitrage",
          () => this.arbitrageStrategy!.execute(),
          strategyTimings,
        );
      }

      // Quick Flip removed - functionality covered by ScalpTrade
    } catch (err) {
      this.logger.error(
        `[Orchestrator] Error in cycle=${currentCycleId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Release cycle lock
      this.cycleInFlight = false;

      const cycleDuration = Date.now() - cycleStartTime;
      this.logger.debug(
        `[Orchestrator] cycle=${currentCycleId} end duration=${cycleDuration}ms (skippedTicks=${this.ticksSkippedDueToInflight})`,
      );

      // Log slow strategies (> 500ms) for diagnostics - rate-limited with change detection
      const slowStrategies = strategyTimings.filter((s) => s.durationMs > 500);
      if (slowStrategies.length > 0) {
        // Create fingerprint from slow strategy names (not durations, to avoid constant change)
        const slowNamesFingerprint = slowStrategies
          .map((s) => s.name)
          .sort()
          .join(",");

        // Log only if the set of slow strategies changed or TTL expired
        if (
          this.logDeduper.shouldLog(
            "Orchestrator:slow_strategies",
            HEARTBEAT_INTERVAL_MS,
            slowNamesFingerprint,
          )
        ) {
          this.logger.debug(
            `[Orchestrator] Slow strategies: ${slowStrategies.map((s) => `${s.name}=${s.durationMs}ms`).join(", ")}`,
          );
        }
      }
    }
  }

  /**
   * Run a single strategy with timing and error handling
   */
  private async runStrategyTimed(
    name: string,
    execute: () => Promise<number>,
    timings: Array<{ name: string; durationMs: number }>,
  ): Promise<void> {
    const start = Date.now();
    try {
      const count = await execute();
      if (count > 0) {
        this.logger.info(`[Orchestrator] ${name}: ${count} action(s)`);
      }
    } catch (err) {
      this.logger.error(
        `[Orchestrator] ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      timings.push({ name, durationMs: Date.now() - start });
    }
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    if (!this.isRunning) return;

    this.logger.info(`[Orchestrator] 🛑 Stopping... (bootId=${this.bootId})`);

    if (this.executionTimer) {
      clearInterval(this.executionTimer);
      this.executionTimer = undefined;
    }

    this.positionTracker.stop();
    this.isRunning = false;

    this.logger.info(
      `[Orchestrator] ✅ Stopped. Stats: ticksFired=${this.ticksFired}, cyclesRun=${this.cyclesRun}, skipped=${this.ticksSkippedDueToInflight}`,
    );
  }

  /**
   * Get orchestrator statistics for observability
   */
  getStats(): {
    bootId: string;
    ticksFired: number;
    cyclesRun: number;
    ticksSkippedDueToInflight: number;
    cycleInFlight: boolean;
    currentCycleId: number;
  } {
    return {
      bootId: this.bootId,
      ticksFired: this.ticksFired,
      cyclesRun: this.cyclesRun,
      ticksSkippedDueToInflight: this.ticksSkippedDueToInflight,
      cycleInFlight: this.cycleInFlight,
      currentCycleId: this.cycleId,
    };
  }

  /**
   * Get components for external access
   */
  getPositionTracker(): PositionTracker {
    return this.positionTracker;
  }

  getRiskManager(): RiskManager {
    return this.riskManager;
  }

  getPnLLedger(): PnLLedger {
    return this.pnlLedger;
  }

  getDynamicReserves(): DynamicReservesController {
    return this.dynamicReserves;
  }

  /**
   * Get the current reserve plan (computed once per cycle)
   */
  getCurrentReservePlan(): ReservePlan | null {
    return this.currentReservePlan;
  }

  /**
   * Get P&L summary enriched with balance information.
   *
   * This method provides a full picture of portfolio status:
   * - P&L metrics from the ledger (realized P&L)
   * - Unrealized P&L calculated from position tracker snapshot (pnlUsd from active positions)
   * - USDC balance (reserves)
   * - Holdings value (sum of position values)
   * - Total portfolio value
   *
   * If balance fetch fails, returns the base summary without balance info.
   *
   * NOTE: Since strategies don't record trades to the PnL ledger, we calculate
   * unrealized P&L directly from the position tracker snapshot, which has
   * accurate pnlUsd values for each position based on entry price vs current price.
   */
  async getSummaryWithBalances(): Promise<LedgerSummary> {
    const summary = this.pnlLedger.getSummary();

    // Try to add balance and unrealized P&L information from position tracker
    try {
      const snapshot = this.positionTracker.getSnapshot();

      // Calculate unrealized P&L and holdings value from all positions (active + redeemable)
      // The position tracker's pnlUsd is authoritative for unrealized P&L since
      // it's calculated from actual entry prices and current bid prices.
      // Include redeemablePositions because they represent unrealized P&L until actually redeemed.
      if (snapshot) {
        let holdingsValue = 0;
        let unrealizedPnl = 0;
        let profitableCount = 0;
        let losingCount = 0;
        // Combine active and redeemable positions for complete P&L picture
        const allPositions = [
          ...snapshot.activePositions,
          ...snapshot.redeemablePositions,
        ];
        for (const pos of allPositions) {
          // Use current price (bid price for what we can sell at)
          holdingsValue += pos.size * pos.currentPrice;
          // Sum unrealized P&L from ALL positions for accurate reporting
          // The pnlTrusted flag is for strategy decision-making (whether to act),
          // not for portfolio reporting. Users need to see their total P&L.
          // pnlUsd is always calculated from (currentPrice - entryPrice) * size
          if (typeof pos.pnlUsd === "number") {
            unrealizedPnl += pos.pnlUsd;
            // Count profitable vs losing positions
            if (pos.pnlUsd > 0) {
              profitableCount++;
            } else if (pos.pnlUsd < 0) {
              losingCount++;
            }
          }
        }

        // Override the ledger's unrealized P&L with the position tracker's value
        // since the ledger isn't being populated with trades by strategies
        summary.totalUnrealizedPnl = unrealizedPnl;
        // Recalculate net P&L: realized (from ledger) + unrealized (from positions)
        summary.netPnl = summary.totalRealizedPnl + unrealizedPnl;
        summary.holdingsValue = holdingsValue;

        // Add position counts for portfolio status
        summary.activePositionCount = snapshot.activePositions.length;
        summary.profitablePositionCount = profitableCount;
        summary.losingPositionCount = losingCount;

        // Add USDC balance and total value if wallet balance fetcher is available
        // Only set totalValue when we have a valid snapshot to avoid incorrect calculations
        if (this.getWalletBalances) {
          const balances = await this.getWalletBalances();
          summary.usdcBalance = balances.usdcBalance;
          summary.totalValue = balances.usdcBalance + holdingsValue;

          // Calculate overall return if INITIAL_INVESTMENT_USD is set
          this.enrichWithInitialInvestment(summary, summary.totalValue);
        }
      } else if (this.getWalletBalances) {
        // If no snapshot available, set USDC balance and totalValue (but not holdingsValue)
        const balances = await this.getWalletBalances();
        summary.usdcBalance = balances.usdcBalance;

        // Without holdings, total value is just USDC balance
        summary.totalValue = balances.usdcBalance;
        this.enrichWithInitialInvestment(summary, balances.usdcBalance);
      }
    } catch (err) {
      this.logger.debug(
        `[Orchestrator] Failed to enrich summary with balances: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Return summary without balance info if fetch fails
    }

    return summary;
  }

  /**
   * Enrich summary with initial investment tracking if INITIAL_INVESTMENT_USD is set.
   * Calculates overall gain/loss and return percentage.
   */
  private enrichWithInitialInvestment(
    summary: LedgerSummary,
    totalValue: number,
  ): void {
    const initialInvestmentStr = process.env.INITIAL_INVESTMENT_USD;
    if (!initialInvestmentStr) return;

    const initialInvestment = parseFloat(initialInvestmentStr);
    if (isNaN(initialInvestment) || initialInvestment <= 0) return;

    summary.initialInvestment = initialInvestment;
    summary.overallGainLoss = totalValue - initialInvestment;
    summary.overallReturnPct = (summary.overallGainLoss / initialInvestment) * 100;
  }
}

/**
 * Create an orchestrator from env config
 */
export function createOrchestrator(
  client: ClobClient,
  logger: ConsoleLogger,
  maxPositionUsd: number,
  riskPreset: "conservative" | "balanced" | "aggressive" = "balanced",
): Orchestrator {
  return new Orchestrator({
    client,
    logger,
    maxPositionUsd,
    riskPreset,
  });
}
