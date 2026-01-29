/**
 * Dynamic Reserve Manager
 *
 * Manages dynamic reserves for trading by adapting reserve fractions
 * based on missed opportunities and hedge needs.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface MissedOpportunity {
  tokenId: string;
  sizeUsd: number;
  reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED";
  timestamp: number;
}

export interface DynamicReserveState {
  baseReserveFraction: number;
  adaptedReserveFraction: number;
  missedOpportunitiesUsd: number;
  hedgeNeedsUsd: number;
  missedCount: number;
  hedgesMissed: number;
}

/**
 * Configuration interface for DynamicReserveManager
 * Contains only the fields needed from ChurnConfig
 */
export interface ReserveManagerConfig {
  dynamicReservesEnabled: boolean;
  reserveFraction: number;
  minReserveUsd: number;
  missedOpportunityWeight: number;
  hedgeCoverageWeight: number;
  maxReserveFraction: number;
  reserveAdaptationRate: number;
  maxTradeUsd: number;
  hedgeRatio: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC RESERVE MANAGER
// ═══════════════════════════════════════════════════════════════════════════

export class DynamicReserveManager {
  private readonly config: ReserveManagerConfig;
  private missedOpportunities: MissedOpportunity[] = [];
  private hedgesMissed = 0;
  private adaptedReserveFraction: number;
  private readonly WINDOW_MS = 30 * 60 * 1000; // 30 minute window

  constructor(config: ReserveManagerConfig) {
    this.config = config;
    this.adaptedReserveFraction = config.reserveFraction;
  }

  /**
   * Record a missed trading opportunity due to insufficient reserves
   */
  recordMissedOpportunity(
    tokenId: string,
    sizeUsd: number,
    reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED",
  ): void {
    if (!this.config.dynamicReservesEnabled) return;

    this.missedOpportunities.push({
      tokenId,
      sizeUsd,
      reason,
      timestamp: Date.now(),
    });

    // Prune old entries
    this.pruneOldEntries();

    // Adapt reserves
    this.adaptReserves();
  }

  /**
   * Record a missed hedge opportunity
   */
  recordMissedHedge(sizeUsd: number): void {
    if (!this.config.dynamicReservesEnabled) return;
    this.hedgesMissed++;
    this.adaptReserves();
  }

  /**
   * Get the dynamically calculated effective reserve fraction
   * Balances between:
   * - Base reserve fraction (configured minimum)
   * - Missed opportunities (need more capital available)
   * - Hedge needs (need reserve for hedging)
   */
  getEffectiveReserveFraction(): number {
    if (!this.config.dynamicReservesEnabled) {
      return this.config.reserveFraction;
    }
    return this.adaptedReserveFraction;
  }

  /**
   * Calculate effective bankroll with dynamic reserves
   */
  getEffectiveBankroll(balance: number): {
    effectiveBankroll: number;
    reserveUsd: number;
  } {
    const reserveFraction = this.getEffectiveReserveFraction();
    const reserveUsd = Math.max(
      balance * reserveFraction,
      this.config.minReserveUsd,
    );
    return {
      effectiveBankroll: Math.max(0, balance - reserveUsd),
      reserveUsd,
    };
  }

  /**
   * Adapt reserves based on missed opportunities and hedge needs
   */
  private adaptReserves(): void {
    this.pruneOldEntries();

    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;

    // Count recent missed opportunities
    const recentMissed = this.missedOpportunities.filter(
      (m) => m.timestamp >= windowStart,
    );
    const missedCount = recentMissed.length;

    // Calculate adjustment factors
    // More missed opportunities → LOWER reserves (need more capital available)
    // More missed hedges → HIGHER reserves (need capital for hedging)

    const missedFactor = Math.min(missedCount * 0.02, 0.15); // Up to 15% reduction
    const hedgeFactor = Math.min(this.hedgesMissed * 0.03, 0.1); // Up to 10% increase

    // Apply weighted adjustments
    const missedAdjustment = missedFactor * this.config.missedOpportunityWeight;
    const hedgeAdjustment = hedgeFactor * this.config.hedgeCoverageWeight;

    // Calculate target reserve fraction
    const targetFraction =
      this.config.reserveFraction - missedAdjustment + hedgeAdjustment;

    // Clamp to valid range
    const clampedTarget = Math.max(
      0.1,
      Math.min(this.config.maxReserveFraction, targetFraction),
    );

    // Smooth adaptation
    this.adaptedReserveFraction =
      this.adaptedReserveFraction +
      (clampedTarget - this.adaptedReserveFraction) *
        this.config.reserveAdaptationRate;
  }

  /**
   * Remove old entries outside the window
   */
  private pruneOldEntries(): void {
    const cutoff = Date.now() - this.WINDOW_MS;
    this.missedOpportunities = this.missedOpportunities.filter(
      (m) => m.timestamp >= cutoff,
    );

    // Decay hedges missed over time
    if (this.hedgesMissed > 0 && this.missedOpportunities.length === 0) {
      this.hedgesMissed = Math.max(0, this.hedgesMissed - 1);
    }
  }

  /**
   * Get current state for logging
   */
  getState(): DynamicReserveState {
    this.pruneOldEntries();
    const recentMissed = this.missedOpportunities;

    return {
      baseReserveFraction: this.config.reserveFraction,
      adaptedReserveFraction: this.adaptedReserveFraction,
      missedOpportunitiesUsd: recentMissed.reduce(
        (sum, m) => sum + m.sizeUsd,
        0,
      ),
      hedgeNeedsUsd:
        this.hedgesMissed * this.config.maxTradeUsd * this.config.hedgeRatio,
      missedCount: recentMissed.length,
      hedgesMissed: this.hedgesMissed,
    };
  }

  /**
   * Reset state (for testing or after liquidation)
   */
  reset(): void {
    this.missedOpportunities = [];
    this.hedgesMissed = 0;
    this.adaptedReserveFraction = this.config.reserveFraction;
  }
}
