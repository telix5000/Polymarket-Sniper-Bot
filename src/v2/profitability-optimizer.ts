/**
 * Profitability Optimizer
 *
 * Analyzes and compares the profitability of different trading actions:
 * - Opening a new position (BUY)
 * - Stacking an existing winning position (BUY more)
 * - Hedging a losing position (BUY opposite side)
 *
 * Uses Expected Value (EV) calculations combined with risk analysis
 * to determine the most profitable action to maximize income.
 *
 * EXPECTED VALUE MODEL:
 * EV = (Probability of Win * Potential Gain) - (Probability of Loss * Potential Loss)
 *
 * For prediction markets:
 * - Current price ~= Market's estimated probability of YES outcome
 * - Win scenario: Position resolves to $1 (YES wins) or $0 (NO wins)
 * - Loss scenario: Position resolves to $0 (YES loses) or $1 (NO loses)
 *
 * RISK-ADJUSTED EV:
 * - Factors in position size relative to portfolio
 * - Considers current P&L of existing positions
 * - Accounts for time to market resolution
 * - Adjusts for market liquidity/spread
 */

import type { ReservePlan, PositionReserve } from "../risk";

// ============================================================
// TYPES
// ============================================================

/**
 * Possible trading actions
 */
export type TradingAction = "OPEN_NEW" | "STACK" | "HEDGE_DOWN" | "HEDGE_UP" | "HOLD" | "SELL";

/**
 * Position data needed for profitability analysis
 */
export interface AnalyzablePosition {
  tokenId: string;
  marketId: string;
  outcome: "YES" | "NO";
  /** Current position size in shares */
  size: number;
  /** Average entry price (0-1) */
  avgPrice: number;
  /** Current market price (0-1) */
  curPrice: number;
  /** Current P&L percentage */
  pnlPct: number;
  /** Current position value in USD */
  value: number;
  /** Minutes until market close (optional, for time-based adjustments) */
  minutesToClose?: number;
  /** Best bid price for sell orders */
  bestBid?: number;
  /** Best ask price for buy orders */
  bestAsk?: number;
  /** Bid-ask spread in basis points */
  spreadBps?: number;
}

/**
 * Opportunity to open a new position
 */
export interface NewPositionOpportunity {
  tokenId: string;
  marketId: string;
  outcome: "YES" | "NO";
  /** Current market price (0-1) */
  price: number;
  /** Proposed investment size in USD */
  sizeUsd: number;
  /** Bid-ask spread in basis points */
  spreadBps?: number;
  /** Source of the opportunity (copy trade, arbitrage, etc.) */
  source?: string;
}

/**
 * Result of profitability analysis for a single action
 */
export interface ActionAnalysis {
  action: TradingAction;
  /** Expected value in USD */
  expectedValueUsd: number;
  /** Risk-adjusted expected value (accounts for position sizing, etc.) */
  riskAdjustedEv: number;
  /** Confidence score (0-1) - how confident we are in this analysis */
  confidence: number;
  /** Maximum potential loss in USD */
  maxLossUsd: number;
  /** Maximum potential gain in USD */
  maxGainUsd: number;
  /** Win probability (market's implied probability) */
  winProbability: number;
  /** Human-readable reason for the score */
  reason: string;
}

/**
 * Recommendation from the optimizer
 */
export interface OptimizationResult {
  /** Recommended action */
  recommendedAction: TradingAction;
  /** All analyzed actions ranked by risk-adjusted EV */
  rankedActions: ActionAnalysis[];
  /** Position or opportunity being analyzed */
  subject: AnalyzablePosition | NewPositionOpportunity;
  /** Recommended investment size in USD (for BUY actions) */
  recommendedSizeUsd: number;
  /** Overall confidence in the recommendation (0-1) */
  confidence: number;
  /** Human-readable summary */
  summary: string;
}

/**
 * Configuration for the profitability optimizer
 */
export interface ProfitabilityOptimizerConfig {
  /** Enable optimizer (default: true) */
  enabled: boolean;

  /**
   * Minimum expected value in USD to recommend an action (default: 0.50)
   * Actions with EV below this are considered not worth the transaction costs
   */
  minExpectedValueUsd: number;

  /**
   * Minimum confidence score to recommend an action (default: 0.5)
   * Lower confidence means more uncertainty in the analysis
   */
  minConfidence: number;

  /**
   * Risk tolerance factor (0-1, default: 0.5)
   * Higher values favor higher-EV actions even with more risk
   * Lower values favor safer actions with lower variance
   */
  riskTolerance: number;

  /**
   * Maximum portfolio concentration per position (default: 0.15 = 15%)
   * Penalizes actions that would make any position too large
   */
  maxPortfolioConcentration: number;

  /**
   * Time decay factor - how much to discount EV for distant resolutions (default: 0.95)
   * EV is multiplied by this factor for each day until resolution
   */
  timeDecayPerDay: number;

  /**
   * Spread penalty factor - how much to penalize wide spreads (default: 0.01)
   * Each basis point of spread reduces EV by this amount
   */
  spreadPenaltyPerBps: number;

  /**
   * Stacking bonus - multiplier for stacking winning positions (default: 1.1)
   * Rewards momentum by giving a small EV boost to stacking winners
   */
  stackingBonus: number;

  /**
   * Hedging urgency factor - multiplier for hedging losing positions (default: 1.2)
   * Increases priority of hedging as losses grow
   */
  hedgingUrgencyFactor: number;

  /**
   * Maximum spread penalty as a fraction (default: 0.3 = 30%)
   * Caps the confidence reduction from wide spreads to prevent excessive penalty
   * in illiquid markets
   */
  maxSpreadPenalty: number;
}

/**
 * Default optimizer configuration
 */
export const DEFAULT_OPTIMIZER_CONFIG: ProfitabilityOptimizerConfig = {
  enabled: true,
  minExpectedValueUsd: 0.50,
  minConfidence: 0.5,
  riskTolerance: 0.5,
  maxPortfolioConcentration: 0.15,
  timeDecayPerDay: 0.95,
  spreadPenaltyPerBps: 0.001,
  stackingBonus: 1.1,
  hedgingUrgencyFactor: 1.2,
  maxSpreadPenalty: 0.3,
};

// ============================================================
// PROFITABILITY OPTIMIZER
// ============================================================

/**
 * Profitability Optimizer
 *
 * Analyzes trading opportunities and existing positions to recommend
 * the most profitable action based on expected value and risk analysis.
 */
export class ProfitabilityOptimizer {
  private config: ProfitabilityOptimizerConfig;

  constructor(config?: Partial<ProfitabilityOptimizerConfig>) {
    this.config = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };
  }

  /**
   * Analyze an existing position and determine the best action
   *
   * @param position Current position to analyze
   * @param availableCashUsd Available cash for additional investment
   * @param portfolioValueUsd Total portfolio value (for concentration checks)
   * @param reservePlan Optional reserve plan for risk-aware sizing
   */
  analyzePosition(
    position: AnalyzablePosition,
    availableCashUsd: number,
    portfolioValueUsd: number,
    reservePlan?: ReservePlan,
  ): OptimizationResult {
    const analyses: ActionAnalysis[] = [];

    // Calculate implied win probability from current price
    // For YES: price = probability of YES winning
    // For NO: price = probability of NO winning (i.e., YES losing)
    const winProbability =
      position.outcome === "YES" ? position.curPrice : 1 - position.curPrice;

    // 1. Analyze HOLD action (baseline)
    analyses.push(this.analyzeHold(position, winProbability));

    // 2. Analyze STACK action (buy more of winning position)
    if (position.pnlPct > 0 && availableCashUsd > 0) {
      analyses.push(
        this.analyzeStack(
          position,
          availableCashUsd,
          portfolioValueUsd,
          winProbability,
        ),
      );
    }

    // 3. Analyze HEDGE_DOWN action (buy opposite side of losing position)
    if (position.pnlPct < 0 && availableCashUsd > 0) {
      analyses.push(
        this.analyzeHedgeDown(
          position,
          availableCashUsd,
          portfolioValueUsd,
          winProbability,
        ),
      );
    }

    // 4. Analyze HEDGE_UP action (buy more when high probability)
    if (winProbability >= 0.85 && availableCashUsd > 0) {
      analyses.push(
        this.analyzeHedgeUp(
          position,
          availableCashUsd,
          portfolioValueUsd,
          winProbability,
        ),
      );
    }

    // 5. Analyze SELL action
    analyses.push(this.analyzeSell(position, winProbability));

    // Sort by risk-adjusted EV (descending)
    analyses.sort((a, b) => b.riskAdjustedEv - a.riskAdjustedEv);

    // Select best action
    const bestAction = analyses[0];
    const recommendedSizeUsd = this.computeRecommendedSize(
      bestAction,
      availableCashUsd,
      portfolioValueUsd,
      reservePlan,
    );

    return {
      recommendedAction: bestAction.action,
      rankedActions: analyses,
      subject: position,
      recommendedSizeUsd,
      confidence: bestAction.confidence,
      summary: this.generateSummary(bestAction, position, recommendedSizeUsd),
    };
  }

  /**
   * Analyze a new position opportunity
   *
   * @param opportunity New position opportunity to analyze
   * @param availableCashUsd Available cash for investment
   * @param portfolioValueUsd Total portfolio value (for concentration checks)
   * @param existingPositions Current positions (for correlation checks)
   * @param reservePlan Optional reserve plan for risk-aware sizing
   */
  analyzeNewOpportunity(
    opportunity: NewPositionOpportunity,
    availableCashUsd: number,
    portfolioValueUsd: number,
    existingPositions: AnalyzablePosition[],
    reservePlan?: ReservePlan,
  ): OptimizationResult {
    const analyses: ActionAnalysis[] = [];

    // Calculate implied win probability
    const winProbability =
      opportunity.outcome === "YES"
        ? opportunity.price
        : 1 - opportunity.price;

    // 1. Analyze OPEN_NEW action
    analyses.push(
      this.analyzeOpenNew(
        opportunity,
        availableCashUsd,
        portfolioValueUsd,
        winProbability,
        existingPositions,
      ),
    );

    // 2. Add HOLD as baseline (doing nothing)
    analyses.push({
      action: "HOLD",
      expectedValueUsd: 0,
      riskAdjustedEv: 0,
      confidence: 1.0,
      maxLossUsd: 0,
      maxGainUsd: 0,
      winProbability: 0,
      reason: "No action - baseline comparison",
    });

    // Sort by risk-adjusted EV (descending)
    analyses.sort((a, b) => b.riskAdjustedEv - a.riskAdjustedEv);

    // Select best action
    const bestAction = analyses[0];
    const recommendedSizeUsd = this.computeRecommendedSize(
      bestAction,
      availableCashUsd,
      portfolioValueUsd,
      reservePlan,
    );

    return {
      recommendedAction: bestAction.action,
      rankedActions: analyses,
      subject: opportunity,
      recommendedSizeUsd,
      confidence: bestAction.confidence,
      summary: this.generateOpportunitySummary(
        bestAction,
        opportunity,
        recommendedSizeUsd,
      ),
    };
  }

  /**
   * Compare multiple opportunities and existing positions to find the best action
   *
   * @param positions Current positions
   * @param opportunities New opportunities
   * @param availableCashUsd Available cash
   * @param portfolioValueUsd Total portfolio value
   * @param reservePlan Optional reserve plan
   * @returns Array of recommendations sorted by risk-adjusted EV
   */
  findBestActions(
    positions: AnalyzablePosition[],
    opportunities: NewPositionOpportunity[],
    availableCashUsd: number,
    portfolioValueUsd: number,
    reservePlan?: ReservePlan,
  ): OptimizationResult[] {
    const results: OptimizationResult[] = [];

    // Analyze each existing position
    for (const position of positions) {
      const result = this.analyzePosition(
        position,
        availableCashUsd,
        portfolioValueUsd,
        reservePlan,
      );
      if (result.recommendedAction !== "HOLD") {
        results.push(result);
      }
    }

    // Analyze each new opportunity
    for (const opportunity of opportunities) {
      const result = this.analyzeNewOpportunity(
        opportunity,
        availableCashUsd,
        portfolioValueUsd,
        positions,
        reservePlan,
      );
      if (result.recommendedAction !== "HOLD") {
        results.push(result);
      }
    }

    // Sort by confidence * riskAdjustedEv (descending)
    results.sort((a, b) => {
      const scoreA = a.confidence * a.rankedActions[0].riskAdjustedEv;
      const scoreB = b.confidence * b.rankedActions[0].riskAdjustedEv;
      return scoreB - scoreA;
    });

    return results;
  }

  // ============================================================
  // PRIVATE ANALYSIS METHODS
  // ============================================================

  /**
   * Analyze HOLD action for an existing position
   */
  private analyzeHold(
    position: AnalyzablePosition,
    winProbability: number,
  ): ActionAnalysis {
    // Expected value of holding = (win prob * gain if win) - (loss prob * loss if lose)
    // Gain if win: position resolves to $1 per share
    // Loss if lose: position resolves to $0 per share
    const sharesHeld = position.size;
    const currentValue = position.value;
    const maxGainUsd = sharesHeld * 1 - currentValue; // Resolve to $1 per share
    const maxLossUsd = currentValue; // Resolve to $0

    const expectedValueUsd =
      winProbability * maxGainUsd - (1 - winProbability) * maxLossUsd;

    // Confidence is higher when probability is extreme (near 0 or 1)
    const confidence = this.computeConfidence(winProbability, position.spreadBps);

    return {
      action: "HOLD",
      expectedValueUsd,
      riskAdjustedEv: expectedValueUsd * this.config.riskTolerance,
      confidence,
      maxLossUsd,
      maxGainUsd,
      winProbability,
      reason: `Hold position: EV=${this.formatUsd(expectedValueUsd)}, P(win)=${(winProbability * 100).toFixed(1)}%`,
    };
  }

  /**
   * Analyze STACK action (buy more of a winning position)
   */
  private analyzeStack(
    position: AnalyzablePosition,
    availableCashUsd: number,
    portfolioValueUsd: number,
    winProbability: number,
  ): ActionAnalysis {
    // Proposed stack size - limited by available cash and concentration
    const maxStackByConcentration =
      portfolioValueUsd * this.config.maxPortfolioConcentration - position.value;
    const proposedStackUsd = Math.min(
      availableCashUsd,
      Math.max(0, maxStackByConcentration),
    );

    if (proposedStackUsd < 1) {
      return {
        action: "STACK",
        expectedValueUsd: 0,
        riskAdjustedEv: -Infinity,
        confidence: 0,
        maxLossUsd: 0,
        maxGainUsd: 0,
        winProbability,
        reason: "Cannot stack: insufficient funds or at concentration limit",
      };
    }

    // At current price, we buy proposedStackUsd / curPrice shares
    const sharesToBuy = proposedStackUsd / position.curPrice;
    const maxGainUsd = sharesToBuy * (1 - position.curPrice); // Resolve to $1
    const maxLossUsd = proposedStackUsd; // Resolve to $0

    const baseEv =
      winProbability * maxGainUsd - (1 - winProbability) * maxLossUsd;

    // Apply stacking bonus for momentum
    const stackingBonus = this.config.stackingBonus;
    const expectedValueUsd = baseEv * stackingBonus;

    // Apply spread penalty (spreadBps is in basis points, i.e. 1/10,000)
    // Base cost is (spreadBps / 10000) * size, multiplied by configurable penalty factor
    // Default spreadPenaltyPerBps=0.001 makes this 0.1% of base spread cost
    const baseSpreadCost = ((position.spreadBps ?? 0) / 10000) * proposedStackUsd;
    const spreadPenalty = baseSpreadCost * (this.config.spreadPenaltyPerBps * 1000);
    const adjustedEv = expectedValueUsd - spreadPenalty;

    const confidence = this.computeConfidence(winProbability, position.spreadBps);

    return {
      action: "STACK",
      expectedValueUsd: adjustedEv,
      riskAdjustedEv: adjustedEv * this.config.riskTolerance,
      confidence,
      maxLossUsd,
      maxGainUsd,
      winProbability,
      reason: `Stack ${this.formatUsd(proposedStackUsd)}: EV=${this.formatUsd(adjustedEv)}, P(win)=${(winProbability * 100).toFixed(1)}%, momentum bonus applied`,
    };
  }

  /**
   * Analyze HEDGE_DOWN action (buy opposite side when losing)
   */
  private analyzeHedgeDown(
    position: AnalyzablePosition,
    availableCashUsd: number,
    portfolioValueUsd: number,
    winProbability: number,
  ): ActionAnalysis {
    // When hedging down, we buy the OPPOSITE outcome
    // This guarantees recovery when the market resolves (one side wins)
    const lossPct = Math.abs(position.pnlPct);
    const currentLossUsd = position.value * (lossPct / 100);

    // Hedge size should be proportional to current position value
    // to create a balanced hedge
    const proposedHedgeUsd = Math.min(availableCashUsd, position.value * 0.5);

    if (proposedHedgeUsd < 1) {
      return {
        action: "HEDGE_DOWN",
        expectedValueUsd: 0,
        riskAdjustedEv: -Infinity,
        confidence: 0,
        maxLossUsd: 0,
        maxGainUsd: 0,
        winProbability: 1 - winProbability,
        reason: "Cannot hedge: insufficient funds",
      };
    }

    // Opposite side probability
    const oppositeWinProb = 1 - winProbability;
    const oppositePrice = 1 - position.curPrice;

    // Shares of opposite outcome we can buy
    const oppositeShares = proposedHedgeUsd / oppositePrice;

    // Max gain: opposite wins, we get $1 per share minus cost
    const maxGainUsd = oppositeShares * (1 - oppositePrice);
    // Max loss: original side wins, hedge goes to $0
    const maxLossUsd = proposedHedgeUsd;

    // Base EV for the hedge position itself
    const baseEv =
      oppositeWinProb * maxGainUsd - (1 - oppositeWinProb) * maxLossUsd;

    // Apply hedging urgency factor based on loss severity
    const urgencyMultiplier = 1 + (lossPct / 100) * this.config.hedgingUrgencyFactor;
    const adjustedEv = baseEv * urgencyMultiplier;

    // Higher confidence when position is significantly down
    const baseConfidence = this.computeConfidence(oppositeWinProb, position.spreadBps);
    const confidence = Math.min(1, baseConfidence + lossPct / 200);

    return {
      action: "HEDGE_DOWN",
      expectedValueUsd: adjustedEv,
      riskAdjustedEv: adjustedEv * this.config.riskTolerance, // Consistent with other actions
      confidence,
      maxLossUsd,
      maxGainUsd,
      winProbability: oppositeWinProb,
      reason: `Hedge loss of ${this.formatUsd(currentLossUsd)} with ${this.formatUsd(proposedHedgeUsd)}: EV=${this.formatUsd(adjustedEv)}, urgency=${urgencyMultiplier.toFixed(2)}x`,
    };
  }

  /**
   * Analyze HEDGE_UP action (buy more when high probability of winning)
   */
  private analyzeHedgeUp(
    position: AnalyzablePosition,
    availableCashUsd: number,
    portfolioValueUsd: number,
    winProbability: number,
  ): ActionAnalysis {
    // Only applicable when win probability is high (>= 85%)
    // Similar to stacking but specifically for high-confidence positions

    const maxHedgeUpByConcentration =
      portfolioValueUsd * this.config.maxPortfolioConcentration - position.value;
    const proposedHedgeUpUsd = Math.min(
      availableCashUsd,
      Math.max(0, maxHedgeUpByConcentration),
    );

    if (proposedHedgeUpUsd < 1 || winProbability < 0.85) {
      return {
        action: "HEDGE_UP",
        expectedValueUsd: 0,
        riskAdjustedEv: -Infinity,
        confidence: 0,
        maxLossUsd: 0,
        maxGainUsd: 0,
        winProbability,
        reason: "Cannot hedge up: insufficient funds, concentration limit, or probability too low",
      };
    }

    const sharesToBuy = proposedHedgeUpUsd / position.curPrice;
    const maxGainUsd = sharesToBuy * (1 - position.curPrice);
    const maxLossUsd = proposedHedgeUpUsd;

    const baseEv =
      winProbability * maxGainUsd - (1 - winProbability) * maxLossUsd;

    // Higher bonus for very high probability (85%+ gets extra boost)
    const highProbBonus = 1 + (winProbability - 0.85) * 2; // Up to 1.3x at 100%
    const expectedValueUsd = baseEv * highProbBonus;

    // Very high confidence when probability is high
    const confidence = winProbability;

    return {
      action: "HEDGE_UP",
      expectedValueUsd,
      riskAdjustedEv: expectedValueUsd * this.config.riskTolerance,
      confidence,
      maxLossUsd,
      maxGainUsd,
      winProbability,
      reason: `Hedge up ${this.formatUsd(proposedHedgeUpUsd)} at ${(winProbability * 100).toFixed(1)}% probability: EV=${this.formatUsd(expectedValueUsd)}`,
    };
  }

  /**
   * Analyze SELL action
   */
  private analyzeSell(
    position: AnalyzablePosition,
    winProbability: number,
  ): ActionAnalysis {
    // Selling locks in current value, eliminating both upside and downside
    const sellValue = position.bestBid
      ? position.bestBid * position.size
      : position.value * 0.98; // Estimate with 2% slippage

    // Compare to expected value of holding
    const holdEv = this.analyzeHold(position, winProbability).expectedValueUsd;

    // EV of selling is the difference from expected hold value
    // If hold EV is negative, selling has positive relative EV
    const expectedValueUsd = -holdEv;

    // Confidence is higher when we're locking in gains or cutting losses decisively
    let confidence = 0.5;
    if (position.pnlPct > 50) {
      confidence = 0.7; // High profit, good to take some off
    } else if (position.pnlPct < -30) {
      confidence = 0.6; // Large loss, might want to cut
    }

    return {
      action: "SELL",
      expectedValueUsd,
      riskAdjustedEv: expectedValueUsd * (2 - this.config.riskTolerance), // Risk-averse investors favor selling
      confidence,
      maxLossUsd: 0, // No additional loss after selling
      maxGainUsd: sellValue, // Realized value
      winProbability: 1, // Selling is certain
      reason: `Sell at ${this.formatUsd(sellValue)}: locks in value, opportunity cost=${this.formatUsd(-expectedValueUsd)}`,
    };
  }

  /**
   * Analyze opening a new position
   */
  private analyzeOpenNew(
    opportunity: NewPositionOpportunity,
    availableCashUsd: number,
    portfolioValueUsd: number,
    winProbability: number,
    existingPositions: AnalyzablePosition[],
  ): ActionAnalysis {
    // Check if we already have a position in this market
    const existingInMarket = existingPositions.find(
      (p) => p.marketId === opportunity.marketId,
    );
    const existingValueInMarket = existingInMarket?.value ?? 0;

    // Max new position by concentration
    const maxByConcentration =
      portfolioValueUsd * this.config.maxPortfolioConcentration -
      existingValueInMarket;
    const proposedSizeUsd = Math.min(
      opportunity.sizeUsd,
      availableCashUsd,
      Math.max(0, maxByConcentration),
    );

    if (proposedSizeUsd < 1) {
      return {
        action: "OPEN_NEW",
        expectedValueUsd: 0,
        riskAdjustedEv: -Infinity,
        confidence: 0,
        maxLossUsd: 0,
        maxGainUsd: 0,
        winProbability,
        reason: "Cannot open: insufficient funds or at concentration limit",
      };
    }

    const sharesToBuy = proposedSizeUsd / opportunity.price;
    const maxGainUsd = sharesToBuy * (1 - opportunity.price);
    const maxLossUsd = proposedSizeUsd;

    const baseEv =
      winProbability * maxGainUsd - (1 - winProbability) * maxLossUsd;

    // Apply spread penalty (spreadBps is in basis points, i.e. 1/10,000)
    // Base cost is (spreadBps / 10000) * size, multiplied by configurable penalty factor
    const baseSpreadCost = ((opportunity.spreadBps ?? 0) / 10000) * proposedSizeUsd;
    const spreadPenalty = baseSpreadCost * (this.config.spreadPenaltyPerBps * 1000);
    const expectedValueUsd = baseEv - spreadPenalty;

    const confidence = this.computeConfidence(
      winProbability,
      opportunity.spreadBps,
    );

    return {
      action: "OPEN_NEW",
      expectedValueUsd,
      riskAdjustedEv: expectedValueUsd * this.config.riskTolerance,
      confidence,
      maxLossUsd,
      maxGainUsd,
      winProbability,
      reason: `Open ${this.formatUsd(proposedSizeUsd)} at ${(opportunity.price * 100).toFixed(1)}¢: EV=${this.formatUsd(expectedValueUsd)}, P(win)=${(winProbability * 100).toFixed(1)}%`,
    };
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Compute confidence score based on probability and spread
   */
  private computeConfidence(winProbability: number, spreadBps?: number): number {
    // Base confidence from probability extremity
    // Closer to 0.5 = less confident, closer to 0 or 1 = more confident
    const probConfidence = 1 - 2 * Math.abs(winProbability - 0.5);

    // Spread penalty - capped at configurable max to handle illiquid markets
    const spreadPenalty = Math.min(this.config.maxSpreadPenalty, (spreadBps ?? 0) / 1000);

    return Math.max(0.1, probConfidence - spreadPenalty);
  }

  /**
   * Compute recommended size based on action and constraints
   */
  private computeRecommendedSize(
    action: ActionAnalysis,
    availableCashUsd: number,
    portfolioValueUsd: number,
    reservePlan?: ReservePlan,
  ): number {
    // Base size from the analysis (encoded in maxLossUsd for BUY actions)
    let baseSize = action.maxLossUsd;

    // If we have a reserve plan, respect available cash minus reserves
    if (reservePlan && reservePlan.mode === "RISK_OFF") {
      const effectiveAvailable = reservePlan.availableCash - reservePlan.shortfall;
      baseSize = Math.min(baseSize, Math.max(0, effectiveAvailable));
    }

    // Kelly criterion-inspired sizing
    // Bet size = (p * b - q) / b where p = win prob, q = 1-p, b = odds
    // Simplified: bet fraction of portfolio proportional to edge
    // For riskless actions (HOLD/SELL), Kelly doesn't apply
    const isRisklessAction = action.action === "HOLD" || action.action === "SELL";
    let edge = 0;
    if (!isRisklessAction && action.maxLossUsd > 0) {
      edge = action.riskAdjustedEv / action.maxLossUsd;
    }
    const kellyFraction = Math.max(0, Math.min(0.25, edge)); // Cap at 25%

    const kellySuggested = portfolioValueUsd * kellyFraction;

    // Use minimum of base size, Kelly suggestion, and available cash
    return Math.min(baseSize, kellySuggested, availableCashUsd);
  }

  /**
   * Generate human-readable summary for position analysis
   */
  private generateSummary(
    action: ActionAnalysis,
    position: AnalyzablePosition,
    recommendedSizeUsd: number,
  ): string {
    const positionDesc = `${position.outcome} position at ${(position.curPrice * 100).toFixed(1)}¢ (${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(1)}% P&L)`;

    switch (action.action) {
      case "HOLD":
        return `HOLD ${positionDesc}: EV=${this.formatUsd(action.expectedValueUsd)}`;
      case "STACK":
        return `STACK ${this.formatUsd(recommendedSizeUsd)} on ${positionDesc}: EV=${this.formatUsd(action.expectedValueUsd)}`;
      case "HEDGE_DOWN":
        return `HEDGE ${this.formatUsd(recommendedSizeUsd)} against ${positionDesc}: EV=${this.formatUsd(action.expectedValueUsd)}`;
      case "HEDGE_UP":
        return `HEDGE UP ${this.formatUsd(recommendedSizeUsd)} on ${positionDesc}: EV=${this.formatUsd(action.expectedValueUsd)}`;
      case "SELL":
        return `SELL ${positionDesc}: locks in ${this.formatUsd(action.maxGainUsd)}`;
      default:
        return `${action.action}: ${action.reason}`;
    }
  }

  /**
   * Generate human-readable summary for opportunity analysis
   */
  private generateOpportunitySummary(
    action: ActionAnalysis,
    opportunity: NewPositionOpportunity,
    recommendedSizeUsd: number,
  ): string {
    const oppDesc = `${opportunity.outcome} at ${(opportunity.price * 100).toFixed(1)}¢`;

    if (action.action === "OPEN_NEW") {
      return `OPEN ${this.formatUsd(recommendedSizeUsd)} ${oppDesc}: EV=${this.formatUsd(action.expectedValueUsd)}, P(win)=${(action.winProbability * 100).toFixed(1)}%`;
    }

    return `SKIP ${oppDesc}: ${action.reason}`;
  }

  /**
   * Format USD amount
   */
  private formatUsd(amount: number): string {
    const sign = amount >= 0 ? "" : "-";
    return `${sign}$${Math.abs(amount).toFixed(2)}`;
  }

  /**
   * Get current configuration
   */
  getConfig(): ProfitabilityOptimizerConfig {
    return { ...this.config };
  }

  /**
   * Check if optimizer is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * Create a profitability optimizer with optional configuration overrides
 */
export function createProfitabilityOptimizer(
  config?: Partial<ProfitabilityOptimizerConfig>,
): ProfitabilityOptimizer {
  return new ProfitabilityOptimizer(config);
}
