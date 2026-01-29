/**
 * Decision Engine
 *
 * Central decision-making module for trading operations.
 * Evaluates entry and exit conditions based on market data, bias signals,
 * and risk parameters.
 *
 * This module is side-effect free - it only makes decisions, not trades.
 * The execution layer is responsible for acting on these decisions.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orderbook state for decision making
 */
export interface OrderbookState {
  bestBidCents: number;
  bestAskCents: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadCents: number;
  midPriceCents: number;
  /** Source of the orderbook data (WS = WebSocket, REST = REST API, STALE_CACHE = stale cached data) */
  source?: "WS" | "REST" | "STALE_CACHE";
}

/**
 * Market activity metrics
 */
export interface MarketActivity {
  tradesInWindow: number;
  bookUpdatesInWindow: number;
  lastTradeTime: number;
  lastUpdateTime: number;
}

/**
 * Bias direction for trading decisions
 */
export type BiasDirection = "LONG" | "SHORT" | "NONE";

/**
 * Position state in the lifecycle
 */
export type PositionState = "OPEN" | "HEDGED" | "EXITING" | "CLOSED";

/**
 * Reason for exiting a position
 */
export type ExitReason =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TIME_STOP"
  | "HARD_EXIT"
  | "BIAS_FLIP"
  | "EV_DEGRADED"
  | "MANUAL";

/**
 * A hedge leg on a position
 */
export interface HedgeLeg {
  tokenId: string; // Opposite side token
  sizeUsd: number;
  entryPriceCents: number;
  entryTime: number;
  pnlCents: number;
}

/**
 * State transition record
 */
export interface StateTransition {
  positionId: string;
  fromState: PositionState;
  toState: PositionState;
  reason: string;
  timestamp: number;
  pnlCents: number;
  pnlUsd: number;
  evSnapshot: EvMetrics | null;
  biasDirection: BiasDirection;
  // Outcome info for display (Telegram notifications)
  outcomeLabel?: string;
  marketQuestion?: string;
  // Entry details for display (Telegram notifications)
  entrySizeUsd?: number;
  entryPriceCents?: number;
}

/**
 * A managed position with full lifecycle tracking
 */
export interface ManagedPosition {
  id: string;
  tokenId: string;
  marketId?: string;
  side: "LONG" | "SHORT";
  state: PositionState;

  // Outcome info for display (e.g., Telegram notifications)
  // Supports any 2-outcome market (YES/NO, team names, etc.)
  outcomeLabel?: string; // The outcome label (e.g., "Lakers", "Yes", "Over")
  outcomeIndex?: 1 | 2; // 1-based index (1 = first outcome, 2 = second outcome)
  marketQuestion?: string; // The market question for context

  // Entry
  entryPriceCents: number;
  entrySizeUsd: number;
  entryTime: number;

  // Current
  currentPriceCents: number;
  unrealizedPnlCents: number;
  unrealizedPnlUsd: number;

  // Targets
  takeProfitPriceCents: number;
  hedgeTriggerPriceCents: number;
  hardExitPriceCents: number;

  // Hedge - including opposite token for proper hedging
  // Works with ANY 2-outcome market, not just YES/NO
  hedges: HedgeLeg[];
  totalHedgeRatio: number;
  oppositeTokenId?: string; // The sibling outcome token for hedging (outcomeIndex 1 ↔ 2)
  oppositeOutcomeLabel?: string; // The opposite outcome label for display

  // Reference
  referencePriceCents: number;

  // History
  transitions: StateTransition[];
  lastUpdateTime: number;

  // External position flag - true if not opened by the bot
  isExternal?: boolean;
}

/**
 * EV metrics for trading decisions
 */
export interface EvMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinCents: number;
  avgLossCents: number;
  evCents: number;
  profitFactor: number;
  totalPnlUsd: number;
  lastUpdated: number;
}

/**
 * Entry decision result
 */
export interface EntryDecision {
  allowed: boolean;
  side?: "LONG" | "SHORT";
  priceCents?: number;
  sizeUsd?: number;
  reason?: string;
  checks: {
    bias: { passed: boolean; value: BiasDirection; reason?: string };
    liquidity: { passed: boolean; reason?: string };
    priceDeviation: { passed: boolean; reason?: string };
    priceBounds: { passed: boolean; reason?: string };
    riskLimits: { passed: boolean; reason?: string };
    evAllowed: { passed: boolean; reason?: string };
  };
}

/**
 * Exit decision result
 */
export interface ExitDecision {
  shouldExit: boolean;
  reason?:
    | "TAKE_PROFIT"
    | "STOP_LOSS"
    | "TIME_STOP"
    | "HARD_EXIT"
    | "BIAS_FLIP"
    | "EV_DEGRADED";
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

/**
 * Configuration for the decision engine
 */
export interface DecisionEngineConfig {
  // Entry/Exit Bands (cents)
  entryBandCents: number;
  tpCents: number;
  hedgeTriggerCents: number;
  maxAdverseCents: number;
  maxHoldSeconds: number;

  // Hedge Behavior
  hedgeRatio: number;
  maxHedgeRatio: number;

  // Entry Price Bounds (cents)
  minEntryPriceCents: number;
  maxEntryPriceCents: number;
  preferredEntryLowCents: number;
  preferredEntryHighCents: number;
  entryBufferCents: number;

  // Liquidity Gates
  minSpreadCents: number;
  minDepthUsdAtExit: number;
  minTradesLastX: number;
  minBookUpdatesLastX: number;

  // Position Limits
  maxOpenPositionsTotal: number;
  maxOpenPositionsPerMarket: number;
  maxDeployedFractionTotal: number;

  // Capital sizing
  tradeFraction: number;
  maxTradeUsd: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Decision Engine Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decision engine for evaluating trading opportunities.
 *
 * This class is stateless and side-effect free. It evaluates conditions
 * and returns decisions - the execution layer acts on them.
 */
export class DecisionEngine {
  private readonly config: DecisionEngineConfig;
  private debugEnabled = false;

  constructor(config: DecisionEngineConfig) {
    this.config = config;
  }

  /**
   * Enable debug logging
   */
  setDebug(enabled: boolean): void {
    this.debugEnabled = enabled;
  }

  private debug(message: string): void {
    if (this.debugEnabled) {
      console.log(`🔍 [DecisionEngine] ${message}`);
    }
  }

  /**
   * Evaluate entry conditions
   */
  evaluateEntry(params: {
    tokenId: string;
    bias: BiasDirection;
    orderbook: OrderbookState;
    activity: MarketActivity;
    referencePriceCents: number;
    evMetrics: EvMetrics;
    evAllowed: { allowed: boolean; reason?: string };
    currentPositions: ManagedPosition[];
    effectiveBankroll: number;
    totalDeployedUsd: number;
  }): EntryDecision {
    const checks: EntryDecision["checks"] = {
      bias: { passed: false, value: params.bias },
      liquidity: { passed: false },
      priceDeviation: { passed: false },
      priceBounds: { passed: false },
      riskLimits: { passed: false },
      evAllowed: { passed: false },
    };

    // 1) Check bias
    // CRITICAL: SHORT entries are NOT supported on Polymarket.
    // The exchange only supports buying YES or NO tokens (both are LONG positions).
    // A "short" on YES would mean buying NO, which is still a LONG position on NO.
    // Reject any SHORT bias to prevent invalid SELL entry attempts.
    if (params.bias === "NONE") {
      checks.bias.reason = "No bias signal";
    } else if (params.bias === "SHORT") {
      checks.bias.reason =
        "SHORT entries not supported on Polymarket (LONG-only)";
    } else {
      checks.bias.passed = true;
    }

    // 2) Check liquidity gates
    const liquidityCheck = this.checkLiquidity(
      params.orderbook,
      params.activity,
    );
    checks.liquidity = liquidityCheck;

    // 3) Check price deviation from reference
    // NOTE: For NEW entries, referencePriceCents equals current midPrice (no historical reference)
    // The deviation check is only meaningful for RE-ENTRY after exiting a position.
    // For new entries triggered by whale signals or scanner, we skip this check since:
    // - Price bounds check (30-82¢) ensures we enter at reasonable prices
    // - Whale signals provide the "edge" that replaces price deviation requirement
    const currentPriceCents = params.orderbook.midPriceCents;
    const deviation = Math.abs(currentPriceCents - params.referencePriceCents);

    // Threshold for considering prices equal (accounts for floating point imprecision)
    const priceEqualityThresholdCents = 0.01;

    // If reference equals current (new entry), skip this check - the bias signal is our edge
    // If reference differs (re-entry), require minimum deviation
    if (deviation < priceEqualityThresholdCents) {
      // New entry: reference price equals current price, skip deviation check
      checks.priceDeviation.passed = true;
      checks.priceDeviation.reason = "New entry (whale/scanner signal)";
    } else if (deviation >= this.config.entryBandCents) {
      checks.priceDeviation.passed = true;
    } else {
      checks.priceDeviation.reason = `Deviation ${deviation.toFixed(1)}¢ < ${this.config.entryBandCents}¢`;
    }

    // 4) Check entry price bounds with buffer
    // Entry bounds ensure room to win (TP at +14¢) and room to be wrong (up to -30¢)
    // The buffer (4¢) provides margin for slippage and ensures we don't enter too close to bounds
    const entryPriceCents =
      params.bias === "LONG"
        ? params.orderbook.bestAskCents
        : params.orderbook.bestBidCents;

    const minBound =
      this.config.minEntryPriceCents + this.config.entryBufferCents;
    const maxBound =
      this.config.maxEntryPriceCents - this.config.entryBufferCents;

    if (entryPriceCents >= minBound && entryPriceCents <= maxBound) {
      checks.priceBounds.passed = true;
    } else if (
      entryPriceCents >= this.config.minEntryPriceCents &&
      entryPriceCents <= this.config.maxEntryPriceCents
    ) {
      // Within bounds but outside buffer - allow with warning
      checks.priceBounds.passed = true;
      checks.priceBounds.reason = `Price ${entryPriceCents.toFixed(1)}¢ near bounds [${this.config.minEntryPriceCents}, ${this.config.maxEntryPriceCents}] (buffer: ${this.config.entryBufferCents}¢)`;
    } else {
      checks.priceBounds.reason = `Price ${entryPriceCents.toFixed(1)}¢ outside bounds [${this.config.minEntryPriceCents}, ${this.config.maxEntryPriceCents}]`;
    }

    // 5) Check risk limits
    const riskCheck = this.checkRiskLimits(
      params.tokenId,
      params.currentPositions,
      params.effectiveBankroll,
      params.totalDeployedUsd,
    );
    checks.riskLimits = riskCheck;

    // 6) Check EV allows trading
    if (params.evAllowed.allowed) {
      checks.evAllowed.passed = true;
    } else {
      checks.evAllowed.reason = params.evAllowed.reason;
    }

    // All checks must pass
    const allPassed = Object.values(checks).every((c) => c.passed);

    if (!allPassed) {
      const failedChecks = Object.entries(checks)
        .filter(([_, v]) => !v.passed)
        .map(([k, v]) => `${k}: ${v.reason || "failed"}`)
        .join("; ");

      return {
        allowed: false,
        reason: failedChecks,
        checks,
      };
    }

    // Calculate size
    const sizeUsd = this.calculateSize(params.effectiveBankroll);

    return {
      allowed: true,
      side: params.bias as "LONG" | "SHORT",
      priceCents: entryPriceCents,
      sizeUsd,
      checks,
    };
  }

  /**
   * Check liquidity gates
   */
  private checkLiquidity(
    orderbook: OrderbookState,
    activity: MarketActivity,
  ): { passed: boolean; reason?: string } {
    // Use ONLY MIN_SPREAD_CENTS from config for the liquidity gate
    const effectiveMaxSpread = this.config.minSpreadCents;

    this.debug(
      `[Liquidity Gate] Spread check: ${orderbook.spreadCents.toFixed(1)}¢ vs max ${effectiveMaxSpread}¢`,
    );

    if (orderbook.spreadCents > effectiveMaxSpread) {
      return {
        passed: false,
        reason: `Spread ${orderbook.spreadCents.toFixed(1)}¢ > max ${effectiveMaxSpread}¢`,
      };
    }

    // Depth check (need enough depth to exit)
    const minDepth = Math.min(orderbook.bidDepthUsd, orderbook.askDepthUsd);
    if (minDepth < this.config.minDepthUsdAtExit) {
      return {
        passed: false,
        reason: `Depth $${minDepth.toFixed(0)} < $${this.config.minDepthUsdAtExit}`,
      };
    }

    // Activity check
    if (
      activity.tradesInWindow < this.config.minTradesLastX &&
      activity.bookUpdatesInWindow < this.config.minBookUpdatesLastX
    ) {
      return {
        passed: false,
        reason: `Activity too low (${activity.tradesInWindow} trades, ${activity.bookUpdatesInWindow} updates)`,
      };
    }

    return { passed: true };
  }

  /**
   * Check risk limits
   */
  private checkRiskLimits(
    tokenId: string,
    currentPositions: ManagedPosition[],
    effectiveBankroll: number,
    totalDeployedUsd: number,
  ): { passed: boolean; reason?: string } {
    // Max total positions
    if (currentPositions.length >= this.config.maxOpenPositionsTotal) {
      return {
        passed: false,
        reason: `Max positions (${this.config.maxOpenPositionsTotal})`,
      };
    }

    // Max positions per market/token - prevents duplicate entries on same token
    const tokenPositions = currentPositions.filter(
      (p) => p.tokenId === tokenId && p.state !== "CLOSED",
    );
    if (tokenPositions.length >= this.config.maxOpenPositionsPerMarket) {
      return {
        passed: false,
        reason: `Already holding position on this token (${tokenPositions.length}/${this.config.maxOpenPositionsPerMarket})`,
      };
    }

    // Max deployed fraction
    const maxDeployed =
      effectiveBankroll * this.config.maxDeployedFractionTotal;
    if (totalDeployedUsd >= maxDeployed) {
      return {
        passed: false,
        reason: `Max deployed $${maxDeployed.toFixed(0)}`,
      };
    }

    // Effective bankroll must be positive
    if (effectiveBankroll <= 0) {
      return {
        passed: false,
        reason: "No effective bankroll",
      };
    }

    return { passed: true };
  }

  /**
   * Calculate trade size
   */
  private calculateSize(effectiveBankroll: number): number {
    const fractionalSize = effectiveBankroll * this.config.tradeFraction;
    return Math.min(fractionalSize, this.config.maxTradeUsd);
  }

  /**
   * Check if entry is in preferred zone
   */
  isInPreferredZone(priceCents: number): boolean {
    return (
      priceCents >= this.config.preferredEntryLowCents &&
      priceCents <= this.config.preferredEntryHighCents
    );
  }

  /**
   * Calculate entry score (higher = better entry)
   */
  calculateEntryScore(params: {
    priceCents: number;
    spreadCents: number;
    depthUsd: number;
    activityScore: number;
  }): number {
    let score = 0;

    // Preferred zone bonus (0-30 points)
    if (this.isInPreferredZone(params.priceCents)) {
      // Center of preferred zone is ideal
      const center =
        (this.config.preferredEntryLowCents +
          this.config.preferredEntryHighCents) /
        2;
      const distFromCenter = Math.abs(params.priceCents - center);
      const maxDist =
        (this.config.preferredEntryHighCents -
          this.config.preferredEntryLowCents) /
        2;
      score += 30 * (1 - distFromCenter / maxDist);
    }

    // Tight spread bonus (0-25 points)
    // Guard against division by zero
    if (this.config.minSpreadCents > 0) {
      const spreadRatio = params.spreadCents / this.config.minSpreadCents;
      score += Math.max(0, 25 * (2 - spreadRatio));
    }

    // Depth bonus (0-25 points)
    // Guard against division by zero
    if (this.config.minDepthUsdAtExit > 0) {
      const depthRatio = params.depthUsd / this.config.minDepthUsdAtExit;
      score += Math.max(0, Math.min(25, 25 * (depthRatio - 1)));
    }

    // Activity bonus (0-20 points)
    score += Math.min(20, params.activityScore * 20);

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Evaluate exit conditions for a position
   */
  evaluateExit(params: {
    position: ManagedPosition;
    currentPriceCents: number;
    bias: BiasDirection;
    evAllowed: { allowed: boolean; reason?: string };
  }): ExitDecision {
    const { position, currentPriceCents, bias, evAllowed } = params;

    // Calculate current P&L
    let pnlCents: number;
    if (position.side === "LONG") {
      pnlCents = currentPriceCents - position.entryPriceCents;
    } else {
      pnlCents = position.entryPriceCents - currentPriceCents;
    }

    // 1) Take profit
    if (pnlCents >= this.config.tpCents) {
      return {
        shouldExit: true,
        reason: "TAKE_PROFIT",
        urgency: "MEDIUM",
      };
    }

    // 2) Hard exit (max adverse)
    if (pnlCents <= -this.config.maxAdverseCents) {
      return {
        shouldExit: true,
        reason: "HARD_EXIT",
        urgency: "CRITICAL",
      };
    }

    // 3) Time stop
    const holdTimeSeconds = (Date.now() - position.entryTime) / 1000;
    if (holdTimeSeconds >= this.config.maxHoldSeconds) {
      return {
        shouldExit: true,
        reason: "TIME_STOP",
        urgency: pnlCents > 0 ? "LOW" : "MEDIUM",
      };
    }

    // 4) Bias flip (position direction no longer matches bias)
    if (
      (position.side === "LONG" && bias === "SHORT") ||
      (position.side === "SHORT" && bias === "LONG")
    ) {
      // Only exit if we're profitable or at small loss
      if (pnlCents > -this.config.hedgeTriggerCents) {
        return {
          shouldExit: true,
          reason: "BIAS_FLIP",
          urgency: "LOW",
        };
      }
    }

    // 5) EV degraded
    if (!evAllowed.allowed && pnlCents > 0) {
      return {
        shouldExit: true,
        reason: "EV_DEGRADED",
        urgency: "LOW",
      };
    }

    return {
      shouldExit: false,
      urgency: "LOW",
    };
  }

  /**
   * Check if position needs hedging
   */
  needsHedge(position: ManagedPosition, currentPriceCents: number): boolean {
    if (position.totalHedgeRatio >= this.config.maxHedgeRatio) {
      return false;
    }

    let adverseMove: number;
    if (position.side === "LONG") {
      adverseMove = position.entryPriceCents - currentPriceCents;
    } else {
      adverseMove = currentPriceCents - position.entryPriceCents;
    }

    return adverseMove >= this.config.hedgeTriggerCents;
  }

  /**
   * Calculate hedge size
   */
  calculateHedgeSize(position: ManagedPosition): number {
    const remainingHedgeRoom =
      this.config.maxHedgeRatio - position.totalHedgeRatio;
    const hedgeRatio = Math.min(this.config.hedgeRatio, remainingHedgeRoom);
    return position.entrySizeUsd * hedgeRatio;
  }

  /**
   * Get the config for inspection
   */
  getConfig(): Readonly<DecisionEngineConfig> {
    return { ...this.config };
  }

  /**
   * Convert decision to JSON log entry
   */
  toLogEntry(decision: EntryDecision): object {
    return {
      type: "entry_decision",
      timestamp: new Date().toISOString(),
      allowed: decision.allowed,
      side: decision.side || null,
      priceCents: decision.priceCents || null,
      sizeUsd: decision.sizeUsd
        ? parseFloat(decision.sizeUsd.toFixed(2))
        : null,
      reason: decision.reason || null,
      checks: {
        bias: {
          passed: decision.checks.bias.passed,
          value: decision.checks.bias.value,
        },
        liquidity: decision.checks.liquidity.passed,
        priceDeviation: decision.checks.priceDeviation.passed,
        priceBounds: decision.checks.priceBounds.passed,
        riskLimits: decision.checks.riskLimits.passed,
        evAllowed: decision.checks.evAllowed.passed,
      },
    };
  }
}
