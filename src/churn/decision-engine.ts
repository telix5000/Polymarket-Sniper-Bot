/**
 * Churn Engine - Decision Engine
 *
 * Combines bias + EV + liquidity gates to make entry/exit decisions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HEDGE MATH (WHY WE DON'T LOSE MUCH)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Without hedge:
 *   Max loss = MAX_ADVERSE_CENTS = 30¢
 *   That would require 68%+ win rate to break even!
 *
 * With hedge (triggers at 16¢ adverse):
 *   - Hedge 40% of position at 16¢ loss
 *   - If price continues down, hedge profits offset main leg losses
 *   - Avg loss after hedge ≈ 9¢
 *
 * Result:
 *   avg_win  = 14¢ (TP_CENTS)
 *   avg_loss = 9¢  (hedge-capped)
 *   Break-even = 48% win rate
 *
 * Even following whale flows with ~55% accuracy:
 *   EV = 0.55 × 14 - 0.45 × 9 - 2 = +1.65¢ per trade
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ENTRY CONDITIONS (ALL MUST PASS):
 * 1) Bias is LONG or SHORT (whale flow permission)
 * 2) Liquidity gates (spread, depth, activity)
 * 3) Price deviation >= ENTRY_BAND_CENTS
 * 4) Entry price within bounds (30-82¢)
 * 5) Global risk limits not exceeded
 *
 * EXIT CONDITIONS (ANY TRIGGERS EXIT):
 * 1) P&L >= TP_CENTS → TAKE_PROFIT
 * 2) Age >= MAX_HOLD_SECONDS → TIME_STOP
 * 3) Adverse >= MAX_ADVERSE_CENTS → HARD_EXIT
 * 4) EV goes negative → pause entries
 */

import type { ChurnConfig } from "./config";
import type { BiasDirection } from "./bias";
import type { EvMetrics } from "./ev-metrics";
import type { ManagedPosition } from "./state-machine";

/**
 * Orderbook state for liquidity checks
 */
export interface OrderbookState {
  bestBidCents: number;
  bestAskCents: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadCents: number;
  midPriceCents: number;
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
 * Decision Engine
 * Makes entry and exit decisions based on all conditions
 */
export class DecisionEngine {
  private readonly config: ChurnConfig;

  constructor(config: ChurnConfig) {
    this.config = config;
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
    if (params.bias === "NONE") {
      checks.bias.reason = "No bias signal";
    } else {
      checks.bias.passed = true;
    }

    // 2) Check liquidity gates
    const liquidityCheck = this.checkLiquidity(params.orderbook, params.activity);
    checks.liquidity = liquidityCheck;

    // 3) Check price deviation from reference
    const currentPriceCents = params.orderbook.midPriceCents;
    const deviation = Math.abs(currentPriceCents - params.referencePriceCents);
    if (deviation >= this.config.entryBandCents) {
      checks.priceDeviation.passed = true;
    } else {
      checks.priceDeviation.reason = `Deviation ${deviation.toFixed(1)}¢ < ${this.config.entryBandCents}¢`;
    }

    // 4) Check entry price bounds
    const entryPriceCents =
      params.bias === "LONG"
        ? params.orderbook.bestAskCents
        : params.orderbook.bestBidCents;

    if (
      entryPriceCents >= this.config.minEntryPriceCents &&
      entryPriceCents <= this.config.maxEntryPriceCents
    ) {
      checks.priceBounds.passed = true;
    } else {
      checks.priceBounds.reason = `Price ${entryPriceCents}¢ outside [${this.config.minEntryPriceCents}, ${this.config.maxEntryPriceCents}]`;
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
    // Spread check
    if (orderbook.spreadCents > this.config.minSpreadCents) {
      return {
        passed: false,
        reason: `Spread ${orderbook.spreadCents}¢ > ${this.config.minSpreadCents}¢`,
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

    // Max positions per market/token
    const tokenPositions = currentPositions.filter(
      (p) => p.tokenId === tokenId,
    );
    if (tokenPositions.length >= this.config.maxOpenPositionsPerMarket) {
      return {
        passed: false,
        reason: `Max positions per market (${this.config.maxOpenPositionsPerMarket})`,
      };
    }

    // Max deployed fraction
    const maxDeployed = effectiveBankroll * this.config.maxDeployedFractionTotal;
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
        (this.config.preferredEntryLowCents + this.config.preferredEntryHighCents) /
        2;
      const distFromCenter = Math.abs(params.priceCents - center);
      const maxDist =
        (this.config.preferredEntryHighCents - this.config.preferredEntryLowCents) /
        2;
      score += 30 * (1 - distFromCenter / maxDist);
    }

    // Tight spread bonus (0-25 points)
    const spreadRatio = params.spreadCents / this.config.minSpreadCents;
    score += Math.max(0, 25 * (2 - spreadRatio));

    // Depth bonus (0-25 points)
    const depthRatio = params.depthUsd / this.config.minDepthUsdAtExit;
    score += Math.min(25, 25 * (depthRatio - 1));

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
   * Convert to JSON log entry
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
