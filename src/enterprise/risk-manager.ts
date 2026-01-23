/**
 * Risk Manager - Enterprise Grade Risk Engine
 *
 * Centralized risk management with:
 * - Portfolio exposure limits (total, per-market, per-category)
 * - Circuit breakers (consecutive rejects, API health, drawdown)
 * - Hard cooldownUntil cache (per token_id + side) - NO RETRY SPAM
 * - Kill switch support (global and per-strategy)
 * - 3-layer stop logic (local, volatility, portfolio)
 * - PANIC override: liquidation allowed regardless of tier when loss >= PANIC_LOSS_PCT
 * - DUST/RESOLVED position state exclusion from risk calculations
 * - Accounting reconciliation with PnL conflict detection
 * - Idempotency/in-flight locks to prevent stacking and flip-flopping
 * - Per-strategy attribution and kill switches
 *
 * All orders MUST pass through RiskManager.evaluate() before execution.
 * This includes stop-loss and hedging orders.
 */

import * as fs from "fs";
import type { ConsoleLogger } from "../utils/logger.util";
import type {
  RiskDecision,
  OrderRequest,
  CircuitBreakerState,
  CooldownEntry,
  StrategyId,
  InFlightLock,
  TrackedPosition,
  StrategyKillSwitch,
  ReconciliationResult,
  AllowanceInfo,
  TokenType,
  OrderSide,
} from "./types";

/**
 * Risk Manager Configuration
 * Sensible defaults built-in - only override what you need
 */
export interface RiskManagerConfig {
  // === Exposure Limits ===
  /** Max total portfolio exposure in USD (default: $500) */
  maxExposureUsd?: number;
  /** Max exposure per single market in USD (default: $100) */
  maxExposurePerMarketUsd?: number;
  /** Max exposure per category in USD (default: $200) */
  maxExposurePerCategoryUsd?: number;

  // === Drawdown Protection ===
  /** Max drawdown % before kill switch (default: 20%) */
  maxDrawdownPct?: number;
  /** Session starting balance for drawdown calc */
  sessionStartBalanceUsd?: number;

  // === PANIC Liquidation ===
  /** Loss % threshold for PANIC liquidation override (default: 30%) */
  panicLossPct?: number;

  // === Circuit Breakers ===
  /** Consecutive order rejects before pause (default: 5) */
  maxConsecutiveRejects?: number;
  /** Consecutive API errors before pause (default: 3) */
  maxConsecutiveApiErrors?: number;
  /** Seconds API can be unhealthy before pause (default: 60) */
  maxApiUnhealthySeconds?: number;
  /** Circuit breaker cooldown in seconds (default: 300) */
  circuitBreakerCooldownSeconds?: number;

  // === Order Constraints ===
  /** Minimum order size in USD (default: $1) */
  minOrderUsd?: number;
  /** Dust threshold - positions below this are ignored (default: $0.50) */
  dustThresholdUsd?: number;
  /** Max slippage in cents (default: 2¢) */
  maxSlippageCents?: number;

  // === In-Flight Lock Settings ===
  /** In-flight lock timeout in ms (default: 60000) */
  inFlightLockTimeoutMs?: number;
  /** Cooldown after order completion in ms (default: 15000) */
  postOrderCooldownMs?: number;

  // === Reconciliation ===
  /** PnL discrepancy % threshold to flag (default: 10%) */
  reconciliationThresholdPct?: number;
  /** Halt market on discrepancy (default: true) */
  haltOnReconciliationFailure?: boolean;

  // === Kill Switch ===
  /** File path - if exists, all trading stops */
  killSwitchFile?: string;

  // === Logging ===
  /** Log all risk decisions (default: false, set LOG_LEVEL=debug) */
  verboseLogging?: boolean;
}

/**
 * Default configuration values
 * Conservative but functional out of the box
 */
const DEFAULT_CONFIG: Required<RiskManagerConfig> = {
  maxExposureUsd: 500,
  maxExposurePerMarketUsd: 100,
  maxExposurePerCategoryUsd: 200,
  maxDrawdownPct: 20,
  sessionStartBalanceUsd: 0,
  panicLossPct: 30,
  maxConsecutiveRejects: 5,
  maxConsecutiveApiErrors: 3,
  maxApiUnhealthySeconds: 60,
  circuitBreakerCooldownSeconds: 300,
  minOrderUsd: 1,
  dustThresholdUsd: 0.5,
  maxSlippageCents: 2,
  inFlightLockTimeoutMs: 60000,
  postOrderCooldownMs: 15000,
  reconciliationThresholdPct: 10,
  haltOnReconciliationFailure: true,
  killSwitchFile: "",
  verboseLogging: false,
};

export class RiskManager {
  private config: Required<RiskManagerConfig>;
  private logger: ConsoleLogger;

  // State tracking
  private circuitBreaker: CircuitBreakerState = {
    triggered: false,
    consecutiveRejects: 0,
    consecutiveApiErrors: 0,
  };

  // Exposure tracking (excludes DUST/RESOLVED positions)
  private exposureByMarket: Map<string, number> = new Map();
  private exposureByCategory: Map<string, number> = new Map();
  private exposureByStrategy: Map<StrategyId, number> = new Map();
  private totalExposure: number = 0;

  // Hard cooldown cache: key = `${tokenId}:${side}` - NO RETRY SPAM
  private cooldownCache: Map<string, CooldownEntry> = new Map();

  // In-flight locks: key = `${tokenId}:${side}` - prevents stacking/flip-flopping
  private inFlightLocks: Map<string, InFlightLock> = new Map();

  // Per-strategy kill switches
  private strategyKillSwitches: Map<StrategyId, StrategyKillSwitch> = new Map();

  // Position tracking for DUST/RESOLVED exclusion
  private trackedPositions: Map<string, TrackedPosition> = new Map();

  // Halted markets (from reconciliation failures)
  private haltedMarkets: Set<string> = new Set();

  // Allowance tracking
  private allowanceCache: Map<string, AllowanceInfo> = new Map();

  // PnL tracking
  private sessionPnl: number = 0;
  private maxSessionDrawdown: number = 0;

  // API health
  private lastApiHealthy: number = Date.now();
  private apiHealthy: boolean = true;

  constructor(config: RiskManagerConfig, logger: ConsoleLogger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;

    this.logger.info(
      `[RiskManager] Initialized: maxExposure=$${this.config.maxExposureUsd}, ` +
        `maxPerMarket=$${this.config.maxExposurePerMarketUsd}, ` +
        `maxDrawdown=${this.config.maxDrawdownPct}%, panicLoss=${this.config.panicLossPct}%`,
    );
  }

  /**
   * Evaluate an order request against all risk rules.
   * ALL orders MUST pass through this gate, including stop-loss and hedging.
   *
   * Returns approval decision with reason.
   *
   * PANIC Override: If position loss >= PANIC_LOSS_PCT, liquidation is allowed
   * regardless of tier; hedging cannot block it.
   */
  evaluate(
    request: OrderRequest,
    category?: string,
    positionLossPct?: number,
  ): RiskDecision {
    const warnings: string[] = [];
    const cooldownKey = `${request.tokenId}:${request.side}`;

    // === PANIC LIQUIDATION OVERRIDE ===
    // If loss >= PANIC_LOSS_PCT and this is a SELL (liquidation), allow immediately
    const isPanicLiquidation =
      request.side === "SELL" &&
      request.strategyId === "PANIC_LIQUIDATION" &&
      positionLossPct !== undefined &&
      positionLossPct >= this.config.panicLossPct;

    if (isPanicLiquidation) {
      this.logger.warn(
        `[RiskManager] 🚨 PANIC LIQUIDATION OVERRIDE: ${request.tokenId} at ${positionLossPct.toFixed(1)}% loss`,
      );
      return {
        approved: true,
        reason: `PANIC_LIQUIDATION: ${positionLossPct.toFixed(1)}% >= ${this.config.panicLossPct}%`,
        warnings: ["PANIC override - hedging cannot block this liquidation"],
      };
    }

    // 1. Global kill switch check
    if (this.isKillSwitchActive()) {
      return {
        approved: false,
        reason: "KILL_SWITCH_ACTIVE",
      };
    }

    // 2. Per-strategy kill switch check
    const strategyKillSwitch = this.strategyKillSwitches.get(
      request.strategyId,
    );
    if (strategyKillSwitch?.killed) {
      return {
        approved: false,
        reason: `STRATEGY_KILLED: ${request.strategyId} - ${strategyKillSwitch.reason ?? "manually disabled"}`,
      };
    }

    // 3. Market halt check (from reconciliation failures)
    if (this.haltedMarkets.has(request.marketId)) {
      return {
        approved: false,
        reason: `MARKET_HALTED: ${request.marketId} - reconciliation failure`,
      };
    }

    // 4. Circuit breaker check
    if (this.circuitBreaker.triggered) {
      if (this.shouldResetCircuitBreaker()) {
        this.resetCircuitBreaker();
      } else {
        return {
          approved: false,
          reason: `CIRCUIT_BREAKER: ${this.circuitBreaker.reason}`,
        };
      }
    }

    // 5. HARD cooldown check (per token_id + side) - NO RETRY SPAM
    const cooldown = this.cooldownCache.get(cooldownKey);
    if (cooldown && Date.now() < cooldown.cooldownUntil) {
      return {
        approved: false,
        reason: `COOLDOWN_HARD: ${cooldown.reason} until ${new Date(cooldown.cooldownUntil).toISOString()} (${cooldown.attempts} attempts)`,
      };
    }

    // 6. In-flight lock check - prevents stacking and flip-flopping
    const inFlightCheck = this.checkInFlightLock(request.tokenId, request.side);
    if (inFlightCheck.blocked) {
      return {
        approved: false,
        reason: `IN_FLIGHT_LOCKED: ${inFlightCheck.reason}`,
      };
    }

    // 7. Minimum order size
    if (request.sizeUsd < this.config.minOrderUsd) {
      return {
        approved: false,
        reason: `ORDER_TOO_SMALL: $${request.sizeUsd.toFixed(2)} < min $${this.config.minOrderUsd}`,
      };
    }

    // 8. Slippage check
    if (
      request.expectedSlippage !== undefined &&
      request.expectedSlippage > this.config.maxSlippageCents
    ) {
      return {
        approved: false,
        reason: `SLIPPAGE_TOO_HIGH: ${request.expectedSlippage}¢ > max ${this.config.maxSlippageCents}¢`,
      };
    }

    // 9. Total exposure check (only for BUY orders)
    if (request.side === "BUY") {
      const projectedExposure = this.totalExposure + request.sizeUsd;
      if (projectedExposure > this.config.maxExposureUsd) {
        // Try to reduce size
        const availableExposure =
          this.config.maxExposureUsd - this.totalExposure;
        if (availableExposure >= this.config.minOrderUsd) {
          warnings.push(
            `Reduced size from $${request.sizeUsd.toFixed(2)} to $${availableExposure.toFixed(2)} due to exposure limit`,
          );
          return {
            approved: true,
            reason: "APPROVED_REDUCED_SIZE",
            adjustedSize: availableExposure / request.price,
            warnings,
          };
        }
        return {
          approved: false,
          reason: `EXPOSURE_LIMIT: $${projectedExposure.toFixed(2)} > max $${this.config.maxExposureUsd}`,
        };
      }

      // 10. Per-market exposure check
      const currentMarketExposure =
        this.exposureByMarket.get(request.marketId) ?? 0;
      const projectedMarketExposure = currentMarketExposure + request.sizeUsd;
      if (projectedMarketExposure > this.config.maxExposurePerMarketUsd) {
        const availableMarket =
          this.config.maxExposurePerMarketUsd - currentMarketExposure;
        if (availableMarket >= this.config.minOrderUsd) {
          warnings.push(
            `Reduced size due to per-market limit: $${availableMarket.toFixed(2)}`,
          );
          return {
            approved: true,
            reason: "APPROVED_REDUCED_SIZE",
            adjustedSize: availableMarket / request.price,
            warnings,
          };
        }
        return {
          approved: false,
          reason: `MARKET_EXPOSURE_LIMIT: $${projectedMarketExposure.toFixed(2)} > max $${this.config.maxExposurePerMarketUsd}`,
        };
      }

      // 11. Per-category exposure check
      if (category) {
        const currentCategoryExposure =
          this.exposureByCategory.get(category) ?? 0;
        const projectedCategoryExposure =
          currentCategoryExposure + request.sizeUsd;
        if (projectedCategoryExposure > this.config.maxExposurePerCategoryUsd) {
          warnings.push(
            `Category ${category} exposure high: $${projectedCategoryExposure.toFixed(2)}`,
          );
          // Don't block, just warn - category limits are softer
        }
      }
    }

    // 12. Drawdown check
    if (this.config.sessionStartBalanceUsd > 0) {
      const drawdownPct =
        (Math.abs(Math.min(0, this.sessionPnl)) /
          this.config.sessionStartBalanceUsd) *
        100;
      if (drawdownPct >= this.config.maxDrawdownPct) {
        this.triggerCircuitBreaker("MAX_DRAWDOWN_EXCEEDED");
        return {
          approved: false,
          reason: `DRAWDOWN_LIMIT: ${drawdownPct.toFixed(1)}% >= max ${this.config.maxDrawdownPct}%`,
        };
      }
    }

    // All checks passed - set in-flight lock
    this.setInFlightLock(request.tokenId, request.side, request.strategyId);

    if (this.config.verboseLogging) {
      this.logger.debug(
        `[RiskManager] APPROVED: ${request.strategyId} ${request.side} ` +
          `$${request.sizeUsd.toFixed(2)} on ${request.marketId.slice(0, 8)}...`,
      );
    }

    return {
      approved: true,
      reason: "APPROVED",
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Check in-flight lock status
   */
  private checkInFlightLock(
    tokenId: string,
    side: OrderSide,
  ): { blocked: boolean; reason?: string } {
    const key = `${tokenId}:${side}`;
    const lock = this.inFlightLocks.get(key);
    const now = Date.now();

    if (!lock) {
      return { blocked: false };
    }

    // Check if still in-flight (no completion time)
    if (!lock.completedAt) {
      const elapsed = now - lock.startedAt;
      // If it's been more than the timeout, assume it's stale
      if (elapsed > this.config.inFlightLockTimeoutMs) {
        this.inFlightLocks.delete(key);
        return { blocked: false };
      }
      return {
        blocked: true,
        reason: `${lock.strategyId} order in-flight since ${new Date(lock.startedAt).toISOString()}`,
      };
    }

    // Check cooldown after completion
    const timeSinceCompletion = now - lock.completedAt;
    if (timeSinceCompletion < this.config.postOrderCooldownMs) {
      return {
        blocked: true,
        reason: `POST_ORDER_COOLDOWN: ${Math.ceil((this.config.postOrderCooldownMs - timeSinceCompletion) / 1000)}s remaining`,
      };
    }

    // Cooldown expired, clean up
    this.inFlightLocks.delete(key);
    return { blocked: false };
  }

  /**
   * Set in-flight lock
   */
  private setInFlightLock(
    tokenId: string,
    side: OrderSide,
    strategyId: StrategyId,
  ): void {
    const key = `${tokenId}:${side}`;
    this.inFlightLocks.set(key, {
      tokenId,
      side,
      strategyId,
      startedAt: Date.now(),
    });
  }

  /**
   * Release in-flight lock (mark as completed)
   */
  releaseInFlightLock(tokenId: string, side: OrderSide): void {
    const key = `${tokenId}:${side}`;
    const lock = this.inFlightLocks.get(key);
    if (lock) {
      lock.completedAt = Date.now();
    }
  }

  /**
   * Record order result to update state
   * Also releases the in-flight lock
   */
  recordOrderResult(
    request: OrderRequest,
    success: boolean,
    rejectCode?: string,
    cooldownUntil?: number,
    allowancePath?: string,
  ): void {
    // Always release in-flight lock
    this.releaseInFlightLock(request.tokenId, request.side);

    if (success) {
      // Reset consecutive failures
      this.circuitBreaker.consecutiveRejects = 0;

      // Update exposure tracking for BUY orders
      if (request.side === "BUY") {
        this.totalExposure += request.sizeUsd;
        this.exposureByMarket.set(
          request.marketId,
          (this.exposureByMarket.get(request.marketId) ?? 0) + request.sizeUsd,
        );
        this.exposureByStrategy.set(
          request.strategyId,
          (this.exposureByStrategy.get(request.strategyId) ?? 0) +
            request.sizeUsd,
        );
      } else {
        // SELL reduces exposure
        this.totalExposure = Math.max(0, this.totalExposure - request.sizeUsd);
        const marketExp = this.exposureByMarket.get(request.marketId) ?? 0;
        this.exposureByMarket.set(
          request.marketId,
          Math.max(0, marketExp - request.sizeUsd),
        );
      }
    } else {
      // Track failure
      this.circuitBreaker.consecutiveRejects++;

      // HARD cooldown cache if provided - per token_id + side
      if (cooldownUntil) {
        const cooldownKey = `${request.tokenId}:${request.side}`;
        const existing = this.cooldownCache.get(cooldownKey);
        this.cooldownCache.set(cooldownKey, {
          tokenId: request.tokenId,
          side: request.side,
          cooldownUntil,
          reason: rejectCode ?? "UNKNOWN",
          attempts: (existing?.attempts ?? 0) + 1,
        });
        this.logger.warn(
          `[RiskManager] HARD cooldown set: ${cooldownKey} - ${rejectCode} until ${new Date(cooldownUntil).toISOString()}`,
        );
      }

      // Log allowance path on reject for debugging
      if (allowancePath && rejectCode?.includes("ALLOWANCE")) {
        this.logger.error(
          `[RiskManager] Allowance reject on ${allowancePath} path: ${rejectCode} for ${request.tokenId}`,
        );
      }

      // Check circuit breaker threshold
      if (
        this.circuitBreaker.consecutiveRejects >=
        this.config.maxConsecutiveRejects
      ) {
        this.triggerCircuitBreaker(
          `CONSECUTIVE_REJECTS: ${this.circuitBreaker.consecutiveRejects}`,
        );
      }
    }
  }

  /**
   * Record PnL change (from position close or realized gain/loss)
   */
  recordPnl(pnl: number): void {
    this.sessionPnl += pnl;
    if (this.sessionPnl < 0) {
      this.maxSessionDrawdown = Math.max(
        this.maxSessionDrawdown,
        Math.abs(this.sessionPnl),
      );
    }
  }

  /**
   * Update exposure directly (for position sync from tracker)
   */
  syncExposure(
    marketExposures: Map<string, number>,
    categoryExposures: Map<string, number>,
  ): void {
    this.exposureByMarket = new Map(marketExposures);
    this.exposureByCategory = new Map(categoryExposures);
    this.totalExposure = Array.from(marketExposures.values()).reduce(
      (sum, v) => sum + v,
      0,
    );
  }

  /**
   * Report API health status
   */
  reportApiHealth(healthy: boolean): void {
    if (healthy) {
      this.lastApiHealthy = Date.now();
      this.circuitBreaker.consecutiveApiErrors = 0;
      this.apiHealthy = true;
    } else {
      this.circuitBreaker.consecutiveApiErrors++;
      this.apiHealthy = false;

      // Check if unhealthy too long
      const unhealthyMs = Date.now() - this.lastApiHealthy;
      if (unhealthyMs > this.config.maxApiUnhealthySeconds * 1000) {
        this.triggerCircuitBreaker(
          `API_UNHEALTHY: ${(unhealthyMs / 1000).toFixed(0)}s`,
        );
      }

      // Check consecutive errors
      if (
        this.circuitBreaker.consecutiveApiErrors >=
        this.config.maxConsecutiveApiErrors
      ) {
        this.triggerCircuitBreaker(
          `API_ERRORS: ${this.circuitBreaker.consecutiveApiErrors} consecutive`,
        );
      }
    }
  }

  /**
   * Check if kill switch file exists
   */
  private isKillSwitchActive(): boolean {
    if (!this.config.killSwitchFile) return false;
    try {
      return fs.existsSync(this.config.killSwitchFile);
    } catch {
      return false;
    }
  }

  /**
   * Trigger circuit breaker
   */
  private triggerCircuitBreaker(reason: string): void {
    if (this.circuitBreaker.triggered) return;

    this.circuitBreaker.triggered = true;
    this.circuitBreaker.reason = reason;
    this.circuitBreaker.triggeredAt = Date.now();
    this.circuitBreaker.resumeAt =
      Date.now() + this.config.circuitBreakerCooldownSeconds * 1000;

    this.logger.error(
      `[RiskManager] 🚨 CIRCUIT BREAKER TRIGGERED: ${reason}. ` +
        `Resume at ${new Date(this.circuitBreaker.resumeAt).toISOString()}`,
    );
  }

  /**
   * Check if circuit breaker should auto-reset
   */
  private shouldResetCircuitBreaker(): boolean {
    if (!this.circuitBreaker.resumeAt) return false;
    return Date.now() >= this.circuitBreaker.resumeAt;
  }

  /**
   * Reset circuit breaker
   */
  private resetCircuitBreaker(): void {
    this.logger.info("[RiskManager] Circuit breaker reset");
    this.circuitBreaker = {
      triggered: false,
      consecutiveRejects: 0,
      consecutiveApiErrors: 0,
    };
  }

  /**
   * Manual circuit breaker reset (for operators)
   */
  forceResetCircuitBreaker(): void {
    this.resetCircuitBreaker();
  }

  // ============================================================
  // POSITION STATE TRACKING (DUST/RESOLVED exclusion)
  // ============================================================

  /**
   * Update tracked position state
   * DUST and RESOLVED positions are excluded from risk calculations
   */
  updatePosition(position: TrackedPosition): void {
    const { tokenId, state, currentValue } = position;

    // Determine state based on value and market status
    let effectiveState = state;
    if (state !== "RESOLVED" && currentValue < this.config.dustThresholdUsd) {
      effectiveState = "DUST";
    }

    position.state = effectiveState;
    this.trackedPositions.set(tokenId, position);

    // Update exposure - exclude DUST and RESOLVED
    if (effectiveState === "DUST" || effectiveState === "RESOLVED") {
      // Remove from exposure calculations
      const marketExp = this.exposureByMarket.get(position.marketId) ?? 0;
      this.exposureByMarket.set(
        position.marketId,
        Math.max(0, marketExp - currentValue),
      );
      this.totalExposure = Math.max(0, this.totalExposure - currentValue);

      if (this.config.verboseLogging) {
        this.logger.debug(
          `[RiskManager] Position ${tokenId} marked ${effectiveState}, excluded from risk calcs`,
        );
      }
    }
  }

  /**
   * Mark position as RESOLVED (market has resolved)
   */
  markPositionResolved(tokenId: string): void {
    const position = this.trackedPositions.get(tokenId);
    if (position) {
      position.state = "RESOLVED";
      this.trackedPositions.set(tokenId, position);
      this.logger.info(`[RiskManager] Position ${tokenId} marked RESOLVED`);
    }
  }

  /**
   * Check if position is DUST or RESOLVED (excluded from worst-loss calc)
   */
  isPositionExcluded(tokenId: string): boolean {
    const position = this.trackedPositions.get(tokenId);
    if (!position) return false;
    return position.state === "DUST" || position.state === "RESOLVED";
  }

  /**
   * Get worst loss positions (excludes DUST/RESOLVED)
   */
  getWorstLossPositions(limit: number = 5): TrackedPosition[] {
    const active = Array.from(this.trackedPositions.values()).filter(
      (p) => p.state !== "DUST" && p.state !== "RESOLVED" && p.size > 0,
    );
    return active
      .sort((a, b) => a.unrealizedPnlPct - b.unrealizedPnlPct)
      .slice(0, limit);
  }

  // ============================================================
  // PNL RECONCILIATION
  // ============================================================

  /**
   * Reconcile reported PnL with executable best-bid value
   * If discrepancy exceeds threshold, flag and optionally halt market
   */
  reconcilePnL(
    tokenId: string,
    reportedPnl: number,
    bestBid: number,
    positionSize: number,
  ): ReconciliationResult {
    const executableValue = bestBid * positionSize;
    const position = this.trackedPositions.get(tokenId);
    const costBasis = position?.costBasis ?? 0;

    // Calculate what PnL should be based on executable value
    const expectedPnl = executableValue - costBasis;
    const discrepancy = Math.abs(reportedPnl - expectedPnl);
    const discrepancyPct =
      costBasis > 0
        ? (discrepancy / costBasis) * 100
        : discrepancy > 0
          ? 100
          : 0;

    const flagged = discrepancyPct >= this.config.reconciliationThresholdPct;
    let halted = false;

    if (flagged) {
      this.logger.error(
        `[RiskManager] 🚨 PnL RECONCILIATION FAILURE: ${tokenId} ` +
          `reported=$${reportedPnl.toFixed(2)} vs executable=$${expectedPnl.toFixed(2)} ` +
          `(${discrepancyPct.toFixed(1)}% discrepancy)`,
      );

      if (this.config.haltOnReconciliationFailure && position) {
        this.haltedMarkets.add(position.marketId);
        halted = true;
        this.logger.error(
          `[RiskManager] Market ${position.marketId} HALTED due to reconciliation failure`,
        );
      }
    }

    return {
      tokenId,
      reportedPnl,
      executableValue,
      discrepancy,
      discrepancyPct,
      flagged,
      halted,
    };
  }

  /**
   * Unhalt a market (operator action)
   */
  unhaltMarket(marketId: string): void {
    this.haltedMarkets.delete(marketId);
    this.logger.info(`[RiskManager] Market ${marketId} unhalted`);
  }

  // ============================================================
  // PER-STRATEGY KILL SWITCHES
  // ============================================================

  /**
   * Kill a specific strategy
   */
  killStrategy(strategyId: StrategyId, reason?: string): void {
    this.strategyKillSwitches.set(strategyId, {
      strategyId,
      killed: true,
      reason,
      killedAt: Date.now(),
    });
    this.logger.warn(
      `[RiskManager] Strategy ${strategyId} KILLED: ${reason ?? "manual"}`,
    );
  }

  /**
   * Revive a killed strategy
   */
  reviveStrategy(strategyId: StrategyId): void {
    this.strategyKillSwitches.delete(strategyId);
    this.logger.info(`[RiskManager] Strategy ${strategyId} revived`);
  }

  /**
   * Check if strategy is killed
   */
  isStrategyKilled(strategyId: StrategyId): boolean {
    return this.strategyKillSwitches.get(strategyId)?.killed ?? false;
  }

  /**
   * Get all killed strategies
   */
  getKilledStrategies(): StrategyKillSwitch[] {
    return Array.from(this.strategyKillSwitches.values()).filter(
      (s) => s.killed,
    );
  }

  // ============================================================
  // ALLOWANCE TRACKING
  // ============================================================

  /**
   * Record allowance info for a token type
   * Used to log exact allowance path on rejects
   */
  recordAllowanceInfo(
    tokenType: TokenType,
    tokenId: string | undefined,
    allowance: number,
    balance: number,
    rejectReason?: string,
  ): void {
    const key = tokenType === "COLLATERAL" ? "COLLATERAL" : `COND:${tokenId}`;
    this.allowanceCache.set(key, {
      tokenType,
      tokenId,
      allowance,
      balance,
      lastCheck: Date.now(),
      lastRejectReason: rejectReason,
    });

    if (rejectReason) {
      this.logger.error(
        `[RiskManager] Allowance reject on ${tokenType} path: ${rejectReason} ` +
          `(allowance=$${allowance.toFixed(2)}, balance=$${balance.toFixed(2)})`,
      );
    }
  }

  /**
   * Get allowance info
   */
  getAllowanceInfo(
    tokenType: TokenType,
    tokenId?: string,
  ): AllowanceInfo | undefined {
    const key = tokenType === "COLLATERAL" ? "COLLATERAL" : `COND:${tokenId}`;
    return this.allowanceCache.get(key);
  }

  // ============================================================
  // STATE GETTERS
  // ============================================================

  /**
   * Get current risk state for monitoring
   */
  getState(): {
    circuitBreaker: CircuitBreakerState;
    totalExposure: number;
    exposureUtilization: number;
    sessionPnl: number;
    maxDrawdown: number;
    apiHealthy: boolean;
    activeCooldowns: number;
    activeInFlightLocks: number;
    killedStrategies: number;
    haltedMarkets: number;
    dustPositions: number;
    resolvedPositions: number;
  } {
    const dustCount = Array.from(this.trackedPositions.values()).filter(
      (p) => p.state === "DUST",
    ).length;
    const resolvedCount = Array.from(this.trackedPositions.values()).filter(
      (p) => p.state === "RESOLVED",
    ).length;

    return {
      circuitBreaker: { ...this.circuitBreaker },
      totalExposure: this.totalExposure,
      exposureUtilization: this.totalExposure / this.config.maxExposureUsd,
      sessionPnl: this.sessionPnl,
      maxDrawdown: this.maxSessionDrawdown,
      apiHealthy: this.apiHealthy,
      activeCooldowns: this.cooldownCache.size,
      activeInFlightLocks: this.inFlightLocks.size,
      killedStrategies: this.getKilledStrategies().length,
      haltedMarkets: this.haltedMarkets.size,
      dustPositions: dustCount,
      resolvedPositions: resolvedCount,
    };
  }

  /**
   * Clean up expired cooldowns
   */
  cleanupCooldowns(): void {
    const now = Date.now();
    for (const [tokenId, entry] of this.cooldownCache) {
      if (now >= entry.cooldownUntil) {
        this.cooldownCache.delete(tokenId);
      }
    }
  }
}

/**
 * Create RiskManager with preset-based configuration
 */
export function createRiskManager(
  preset: "conservative" | "balanced" | "aggressive",
  logger: ConsoleLogger,
  overrides?: Partial<RiskManagerConfig>,
): RiskManager {
  const presetConfigs: Record<string, Partial<RiskManagerConfig>> = {
    conservative: {
      maxExposureUsd: 200,
      maxExposurePerMarketUsd: 50,
      maxExposurePerCategoryUsd: 100,
      maxDrawdownPct: 10,
      maxSlippageCents: 1,
    },
    balanced: {
      maxExposureUsd: 500,
      maxExposurePerMarketUsd: 100,
      maxExposurePerCategoryUsd: 200,
      maxDrawdownPct: 15,
      maxSlippageCents: 2,
    },
    aggressive: {
      maxExposureUsd: 2000,
      maxExposurePerMarketUsd: 200,
      maxExposurePerCategoryUsd: 500,
      maxDrawdownPct: 25,
      maxSlippageCents: 3,
    },
  };

  const config = {
    ...presetConfigs[preset],
    ...overrides,
  };

  return new RiskManager(config, logger);
}
