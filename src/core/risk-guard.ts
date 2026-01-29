/**
 * Risk Guard Module - Financial Bleed Prevention
 *
 * Provides comprehensive safeguards against edge cases that could cause
 * financial bleed from the wallet:
 *
 * 1. Global hedge exposure tracking - Prevents taking too many reverse hedging positions
 * 2. Capital deployment limits - Prevents system from depleting wallet
 * 3. Position health monitoring - Enables quick bi-directional action
 * 4. Entry/exit validation - Ensures sound buy/sell process
 *
 * This module acts as a "circuit breaker" for the trading system, providing
 * an additional layer of protection beyond individual position limits.
 */

import type {
  ManagedPosition,
  BiasDirection,
  EvMetrics,
} from "./decision-engine";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

export interface RiskGuardConfig {
  /**
   * Maximum total hedge exposure across ALL positions (0-1).
   * This is the sum of all hedge ratios across all open positions divided by
   * the number of positions. Prevents excessive reverse hedging.
   * Default: 0.5 (50% average hedge exposure across portfolio)
   */
  maxGlobalHedgeExposure: number;

  /**
   * Maximum total capital deployed as a fraction of wallet balance (0-1).
   * Provides a hard limit to prevent wallet depletion.
   * Default: 0.7 (70% max deployment)
   */
  maxTotalDeploymentFraction: number;

  /**
   * Minimum wallet balance to maintain (USD).
   * System will refuse new entries if balance would fall below this.
   * Default: 50 USD
   */
  minWalletBalanceUsd: number;

  /**
   * Maximum number of hedged positions allowed simultaneously.
   * Prevents "hedge cascading" where too many positions are hedged at once.
   * Default: 5
   */
  maxHedgedPositionsCount: number;

  /**
   * Maximum total hedge USD deployed across all positions.
   * Hard cap on how much capital can be used for hedging.
   * Default: 200 USD
   */
  maxTotalHedgeUsd: number;

  /**
   * Position staleness threshold in milliseconds.
   * Positions not updated within this window are flagged for review.
   * Default: 60000 (1 minute)
   */
  positionStaleThresholdMs: number;

  /**
   * Maximum unrealized loss per position before forced action (cents).
   * Default: 35 cents
   */
  maxUnrealizedLossPerPositionCents: number;

  /**
   * Maximum portfolio-wide unrealized loss (USD).
   * If exceeded, system enters protective mode.
   * Default: 100 USD
   */
  maxPortfolioUnrealizedLossUsd: number;

  /**
   * Cooldown between hedge actions on the same position (ms).
   * Prevents rapid hedge stacking.
   * Default: 30000 (30 seconds)
   */
  hedgeCooldownMs: number;
}

export const DEFAULT_RISK_GUARD_CONFIG: RiskGuardConfig = {
  maxGlobalHedgeExposure: 0.5,
  maxTotalDeploymentFraction: 0.7,
  minWalletBalanceUsd: 50,
  maxHedgedPositionsCount: 5,
  maxTotalHedgeUsd: 200,
  positionStaleThresholdMs: 60000,
  maxUnrealizedLossPerPositionCents: 35,
  maxPortfolioUnrealizedLossUsd: 100,
  hedgeCooldownMs: 30000,
};

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of a risk check
 */
export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  severity?: "INFO" | "WARNING" | "CRITICAL";
}

/**
 * Portfolio health status
 */
export interface PortfolioHealth {
  status: "HEALTHY" | "CAUTION" | "CRITICAL";
  openPositions: number;
  hedgedPositions: number;
  totalDeployedUsd: number;
  totalHedgeUsd: number;
  globalHedgeExposure: number;
  portfolioUnrealizedPnlUsd: number;
  stalePositionCount: number;
  issues: string[];
  recommendations: string[];
}

/**
 * Position health for monitoring
 */
export interface PositionHealth {
  positionId: string;
  status: "HEALTHY" | "MONITORING" | "ACTION_REQUIRED" | "CRITICAL";
  unrealizedPnlCents: number;
  holdTimeSeconds: number;
  hedgeRatio: number;
  isStale: boolean;
  canSellQuickly: boolean;
  canHedgeQuickly: boolean;
  issues: string[];
}

/**
 * Entry validation result
 */
export interface EntryValidation {
  allowed: boolean;
  adjustedSizeUsd?: number;
  reason?: string;
  warnings: string[];
}

/**
 * Hedge validation result
 */
export interface HedgeValidation {
  allowed: boolean;
  adjustedSizeUsd?: number;
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// RISK GUARD CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class RiskGuard {
  private readonly config: RiskGuardConfig;
  private hedgeCooldowns: Map<string, number> = new Map();
  private lastHealthCheck: PortfolioHealth | null = null;

  constructor(config: Partial<RiskGuardConfig> = {}) {
    this.config = { ...DEFAULT_RISK_GUARD_CONFIG, ...config };
  }

  /**
   * Validate if a new entry is allowed given current portfolio state.
   * This is the primary gate for preventing wallet depletion.
   */
  validateEntry(params: {
    proposedSizeUsd: number;
    walletBalanceUsd: number;
    currentPositions: ManagedPosition[];
    totalDeployedUsd: number;
  }): EntryValidation {
    const warnings: string[] = [];
    const {
      proposedSizeUsd,
      walletBalanceUsd,
      currentPositions,
      totalDeployedUsd,
    } = params;

    // 1. Check if wallet would fall below minimum
    const projectedBalance = walletBalanceUsd - proposedSizeUsd;
    if (projectedBalance < this.config.minWalletBalanceUsd) {
      return {
        allowed: false,
        reason: `Entry would reduce wallet below minimum ($${projectedBalance.toFixed(2)} < $${this.config.minWalletBalanceUsd})`,
        warnings,
      };
    }

    // 2. Check total deployment fraction
    const projectedDeployment = totalDeployedUsd + proposedSizeUsd;
    const projectedDeploymentFraction = projectedDeployment / walletBalanceUsd;
    if (projectedDeploymentFraction > this.config.maxTotalDeploymentFraction) {
      // Calculate maximum allowed entry size
      const maxAllowedDeployment =
        walletBalanceUsd * this.config.maxTotalDeploymentFraction;
      const maxAllowedEntry = Math.max(
        0,
        maxAllowedDeployment - totalDeployedUsd,
      );

      if (maxAllowedEntry <= 0) {
        return {
          allowed: false,
          reason: `Max deployment fraction reached (${(projectedDeploymentFraction * 100).toFixed(1)}% > ${(this.config.maxTotalDeploymentFraction * 100).toFixed(1)}%)`,
          warnings,
        };
      }

      // Allow with reduced size
      warnings.push(
        `Entry size reduced to stay within deployment limits: $${maxAllowedEntry.toFixed(2)}`,
      );
      return {
        allowed: true,
        adjustedSizeUsd: maxAllowedEntry,
        warnings,
      };
    }

    // 3. Check portfolio-wide unrealized loss
    const portfolioUnrealizedPnlUsd =
      this.calculatePortfolioUnrealizedPnl(currentPositions);
    if (
      portfolioUnrealizedPnlUsd < -this.config.maxPortfolioUnrealizedLossUsd
    ) {
      warnings.push(
        `Portfolio in drawdown: $${portfolioUnrealizedPnlUsd.toFixed(2)}`,
      );
      // Allow but flag - we don't block entries due to current losses (might be recovery opportunity)
    }

    // 4. Check global hedge exposure - if too high, warn
    const globalHedgeExposure =
      this.calculateGlobalHedgeExposure(currentPositions);
    if (globalHedgeExposure > this.config.maxGlobalHedgeExposure * 0.8) {
      warnings.push(
        `High global hedge exposure: ${(globalHedgeExposure * 100).toFixed(1)}%`,
      );
    }

    return {
      allowed: true,
      adjustedSizeUsd: proposedSizeUsd,
      warnings,
    };
  }

  /**
   * Validate if a hedge is allowed for a specific position.
   * Prevents excessive reverse hedging that could bleed the wallet.
   */
  validateHedge(params: {
    positionId: string;
    position: ManagedPosition;
    proposedHedgeSizeUsd: number;
    walletBalanceUsd: number;
    currentPositions: ManagedPosition[];
  }): HedgeValidation {
    const {
      positionId,
      position,
      proposedHedgeSizeUsd,
      walletBalanceUsd,
      currentPositions,
    } = params;

    // 1. Check hedge cooldown
    const cooldownUntil = this.hedgeCooldowns.get(positionId) || 0;
    if (Date.now() < cooldownUntil) {
      return {
        allowed: false,
        reason: `Hedge cooldown active (${Math.round((cooldownUntil - Date.now()) / 1000)}s remaining)`,
      };
    }

    // 2. Check maximum hedged positions count
    const hedgedPositionCount = currentPositions.filter(
      (p) => p.hedges.length > 0,
    ).length;
    const isAlreadyHedged = position.hedges.length > 0;
    if (
      !isAlreadyHedged &&
      hedgedPositionCount >= this.config.maxHedgedPositionsCount
    ) {
      return {
        allowed: false,
        reason: `Max hedged positions reached (${hedgedPositionCount}/${this.config.maxHedgedPositionsCount})`,
      };
    }

    // 3. Check total hedge USD across all positions
    const currentTotalHedgeUsd = this.calculateTotalHedgeUsd(currentPositions);
    const projectedTotalHedgeUsd = currentTotalHedgeUsd + proposedHedgeSizeUsd;
    if (projectedTotalHedgeUsd > this.config.maxTotalHedgeUsd) {
      const maxAllowedHedge = Math.max(
        0,
        this.config.maxTotalHedgeUsd - currentTotalHedgeUsd,
      );
      if (maxAllowedHedge <= 0) {
        return {
          allowed: false,
          reason: `Max total hedge USD reached ($${currentTotalHedgeUsd.toFixed(2)}/$${this.config.maxTotalHedgeUsd})`,
        };
      }
      return {
        allowed: true,
        adjustedSizeUsd: maxAllowedHedge,
      };
    }

    // 4. Check global hedge exposure
    const currentGlobalExposure =
      this.calculateGlobalHedgeExposure(currentPositions);
    if (currentGlobalExposure >= this.config.maxGlobalHedgeExposure) {
      return {
        allowed: false,
        reason: `Global hedge exposure at limit (${(currentGlobalExposure * 100).toFixed(1)}%)`,
      };
    }

    // 5. Check if hedge would deplete wallet below minimum
    const projectedBalance = walletBalanceUsd - proposedHedgeSizeUsd;
    if (projectedBalance < this.config.minWalletBalanceUsd) {
      const maxAllowedHedge = Math.max(
        0,
        walletBalanceUsd - this.config.minWalletBalanceUsd,
      );
      if (maxAllowedHedge <= 0) {
        return {
          allowed: false,
          reason: `Hedge would deplete wallet below minimum`,
        };
      }
      return {
        allowed: true,
        adjustedSizeUsd: maxAllowedHedge,
      };
    }

    return {
      allowed: true,
      adjustedSizeUsd: proposedHedgeSizeUsd,
    };
  }

  /**
   * Record that a hedge was placed (for cooldown tracking)
   */
  recordHedgePlaced(positionId: string): void {
    this.hedgeCooldowns.set(
      positionId,
      Date.now() + this.config.hedgeCooldownMs,
    );
  }

  /**
   * Get comprehensive portfolio health status.
   * Use this for monitoring and alerting.
   */
  getPortfolioHealth(params: {
    currentPositions: ManagedPosition[];
    walletBalanceUsd: number;
    totalDeployedUsd: number;
  }): PortfolioHealth {
    const { currentPositions, walletBalanceUsd, totalDeployedUsd } = params;
    const now = Date.now();
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Calculate metrics
    const openPositions = currentPositions.filter(
      (p) => p.state !== "CLOSED",
    ).length;
    const hedgedPositions = currentPositions.filter(
      (p) => p.hedges.length > 0 && p.state !== "CLOSED",
    ).length;
    const totalHedgeUsd = this.calculateTotalHedgeUsd(currentPositions);
    const globalHedgeExposure =
      this.calculateGlobalHedgeExposure(currentPositions);
    const portfolioUnrealizedPnlUsd =
      this.calculatePortfolioUnrealizedPnl(currentPositions);

    // Check for stale positions
    const stalePositions = currentPositions.filter(
      (p) =>
        p.state !== "CLOSED" &&
        now - p.lastUpdateTime > this.config.positionStaleThresholdMs,
    );
    const stalePositionCount = stalePositions.length;

    // Determine health status
    let status: "HEALTHY" | "CAUTION" | "CRITICAL" = "HEALTHY";

    // Critical conditions
    if (
      portfolioUnrealizedPnlUsd < -this.config.maxPortfolioUnrealizedLossUsd
    ) {
      status = "CRITICAL";
      issues.push(
        `Portfolio drawdown exceeds limit: $${portfolioUnrealizedPnlUsd.toFixed(2)}`,
      );
      recommendations.push("Consider exiting worst-performing positions");
    }

    if (globalHedgeExposure > this.config.maxGlobalHedgeExposure) {
      status = "CRITICAL";
      issues.push(
        `Global hedge exposure too high: ${(globalHedgeExposure * 100).toFixed(1)}%`,
      );
      recommendations.push("Stop adding hedges, consider unwinding some");
    }

    if (
      totalDeployedUsd / walletBalanceUsd >
      this.config.maxTotalDeploymentFraction
    ) {
      if (status !== "CRITICAL") status = "CAUTION";
      issues.push(
        `Over-deployed: ${((totalDeployedUsd / walletBalanceUsd) * 100).toFixed(1)}%`,
      );
      recommendations.push("Reduce position count or sizes");
    }

    // Caution conditions
    if (hedgedPositions > this.config.maxHedgedPositionsCount * 0.8) {
      if (status === "HEALTHY") status = "CAUTION";
      issues.push(`High hedged position count: ${hedgedPositions}`);
    }

    if (stalePositionCount > 0) {
      if (status === "HEALTHY") status = "CAUTION";
      issues.push(`${stalePositionCount} position(s) need price updates`);
      recommendations.push("Check market data connectivity");
    }

    if (totalHedgeUsd > this.config.maxTotalHedgeUsd * 0.8) {
      if (status === "HEALTHY") status = "CAUTION";
      issues.push(`High hedge capital deployed: $${totalHedgeUsd.toFixed(2)}`);
    }

    // Check for positions requiring action
    for (const pos of currentPositions) {
      if (pos.state === "CLOSED") continue;
      if (
        pos.unrealizedPnlCents < -this.config.maxUnrealizedLossPerPositionCents
      ) {
        if (status === "HEALTHY") status = "CAUTION";
        issues.push(
          `Position ${pos.id.slice(0, 8)}... has large loss: ${pos.unrealizedPnlCents}¢`,
        );
      }
    }

    const health: PortfolioHealth = {
      status,
      openPositions,
      hedgedPositions,
      totalDeployedUsd,
      totalHedgeUsd,
      globalHedgeExposure,
      portfolioUnrealizedPnlUsd,
      stalePositionCount,
      issues,
      recommendations,
    };

    this.lastHealthCheck = health;
    return health;
  }

  /**
   * Get health status for a specific position.
   * Enables quick bi-directional action decisions.
   */
  getPositionHealth(position: ManagedPosition): PositionHealth {
    const now = Date.now();
    const issues: string[] = [];

    // Calculate metrics
    const holdTimeSeconds = (now - position.entryTime) / 1000;
    const isStale =
      now - position.lastUpdateTime > this.config.positionStaleThresholdMs;

    // Determine if position can be actioned quickly
    // A position can sell quickly if it's not already exiting
    const canSellQuickly =
      position.state !== "EXITING" && position.state !== "CLOSED";

    // A position can hedge quickly if it hasn't reached max hedge ratio
    // and isn't on hedge cooldown
    const cooldownUntil = this.hedgeCooldowns.get(position.id) || 0;
    const canHedgeQuickly =
      position.state === "OPEN" &&
      position.totalHedgeRatio < 0.7 && // Default max hedge ratio
      Date.now() >= cooldownUntil;

    // Determine status
    let status: PositionHealth["status"] = "HEALTHY";

    if (
      position.unrealizedPnlCents <
      -this.config.maxUnrealizedLossPerPositionCents
    ) {
      status = "CRITICAL";
      issues.push(`Large unrealized loss: ${position.unrealizedPnlCents}¢`);
    }

    if (isStale) {
      if (status === "HEALTHY") status = "MONITORING";
      issues.push("Position price data is stale");
    }

    if (position.state === "HEDGED" && position.unrealizedPnlCents < 0) {
      if (status === "HEALTHY") status = "ACTION_REQUIRED";
      issues.push("Hedged position still losing");
    }

    // Near hedge trigger should be monitored
    if (position.state === "OPEN") {
      const distanceToHedgeTrigger = Math.abs(
        position.currentPriceCents - position.hedgeTriggerPriceCents,
      );
      if (distanceToHedgeTrigger < 3) {
        // Within 3 cents of trigger
        if (status === "HEALTHY") status = "MONITORING";
        issues.push("Approaching hedge trigger");
      }
    }

    return {
      positionId: position.id,
      status,
      unrealizedPnlCents: position.unrealizedPnlCents,
      holdTimeSeconds,
      hedgeRatio: position.totalHedgeRatio,
      isStale,
      canSellQuickly,
      canHedgeQuickly,
      issues,
    };
  }

  /**
   * Check if the system should enter "protective mode".
   * In protective mode, new entries are blocked and exits are prioritized.
   */
  isProtectiveModeActive(params: {
    currentPositions: ManagedPosition[];
    walletBalanceUsd: number;
    totalDeployedUsd: number;
  }): { active: boolean; reason?: string } {
    const health = this.getPortfolioHealth(params);

    if (health.status === "CRITICAL") {
      return {
        active: true,
        reason: health.issues.join("; "),
      };
    }

    // Additional trigger: wallet balance critically low
    if (params.walletBalanceUsd < this.config.minWalletBalanceUsd * 1.5) {
      return {
        active: true,
        reason: `Wallet balance critically low: $${params.walletBalanceUsd.toFixed(2)}`,
      };
    }

    return { active: false };
  }

  /**
   * Get positions that require immediate action (for monitoring dashboard)
   */
  getPositionsRequiringAction(
    currentPositions: ManagedPosition[],
  ): PositionHealth[] {
    return currentPositions
      .filter((p) => p.state !== "CLOSED")
      .map((p) => this.getPositionHealth(p))
      .filter((h) => h.status === "ACTION_REQUIRED" || h.status === "CRITICAL");
  }

  /**
   * Get last health check result (for quick access without recalculation)
   */
  getLastHealthCheck(): PortfolioHealth | null {
    return this.lastHealthCheck;
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.hedgeCooldowns.clear();
    this.lastHealthCheck = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private calculateGlobalHedgeExposure(positions: ManagedPosition[]): number {
    const openPositions = positions.filter((p) => p.state !== "CLOSED");
    if (openPositions.length === 0) return 0;

    const totalHedgeRatio = openPositions.reduce(
      (sum, p) => sum + p.totalHedgeRatio,
      0,
    );
    return totalHedgeRatio / openPositions.length;
  }

  private calculateTotalHedgeUsd(positions: ManagedPosition[]): number {
    return positions
      .filter((p) => p.state !== "CLOSED")
      .reduce((sum, p) => {
        const hedgeUsd = p.hedges.reduce((hSum, h) => hSum + h.sizeUsd, 0);
        return sum + hedgeUsd;
      }, 0);
  }

  private calculatePortfolioUnrealizedPnl(
    positions: ManagedPosition[],
  ): number {
    return positions
      .filter((p) => p.state !== "CLOSED")
      .reduce((sum, p) => sum + p.unrealizedPnlUsd, 0);
  }

  /**
   * Convert to JSON for logging
   */
  toLogEntry(): object {
    return {
      type: "risk_guard",
      timestamp: new Date().toISOString(),
      config: {
        maxGlobalHedgeExposure: this.config.maxGlobalHedgeExposure,
        maxTotalDeploymentFraction: this.config.maxTotalDeploymentFraction,
        minWalletBalanceUsd: this.config.minWalletBalanceUsd,
        maxHedgedPositionsCount: this.config.maxHedgedPositionsCount,
        maxTotalHedgeUsd: this.config.maxTotalHedgeUsd,
      },
      activeCooldowns: this.hedgeCooldowns.size,
      lastHealthStatus: this.lastHealthCheck?.status || "UNKNOWN",
    };
  }
}
