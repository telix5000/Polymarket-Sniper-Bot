/**
 * Exit Engine
 *
 * Manages exits for all open positions (works for both whale and scan entries).
 *
 * Features:
 * - State machine per position: HOLD, TAKE_PROFIT, LATE_GAME_EXIT, RISK_OFF, COMPLETE
 * - closeToEndScore computation using timeToResolution, price stability, and spread/depth health
 * - LATE_GAME_EXIT: if closeToEndScore >= threshold and markPrice >= 0.97, attempt sell ladder
 * - TAKE_PROFIT: dynamic TP that tightens when reservePressure is high
 * - RISK_OFF: exit ASAP at bestBid; if bestBid collapses or book unhealthy, stop and alert
 * - Integration with DynamicReserves for reservePressure influence
 * - Uses shared placeOrderWithFallback() and MarketSnapshot semantics
 * - Structured logging and Telegram notifications
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { MarketSnapshot } from "../book/types";
import type { ManagedPosition } from "./decision-engine";
import type { DynamicReserveState } from "./reserve-manager";
import {
  roundToTick,
  HARD_MIN_PRICE,
  HARD_MAX_PRICE,
} from "../lib/price-safety";
import { sendTelegram } from "../lib/telegram";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exit state for a position
 */
export type ExitState =
  | "HOLD"
  | "TAKE_PROFIT"
  | "LATE_GAME_EXIT"
  | "RISK_OFF"
  | "COMPLETE";

/**
 * Reason for exit state transition
 */
export type ExitStateReason =
  | "INITIAL"
  | "TP_TRIGGERED"
  | "LATE_GAME_SCORE_HIGH"
  | "RISK_OFF_TRIGGERED"
  | "BOOK_UNHEALTHY"
  | "BID_COLLAPSED"
  | "EXIT_FILLED"
  | "MANUAL";

/**
 * Configuration for ExitEngine
 */
export interface ExitEngineConfig {
  // Late-game exit thresholds
  lateGamePriceThreshold: number; // Default: 0.97 (97¢)
  closeToEndScoreThreshold: number; // Default: 0.7 (70% score)

  // Take profit settings
  baseTpCents: number; // Default: 14 (14¢ base TP)
  minTpCents: number; // Default: 5 (5¢ minimum TP when pressure is high)
  tpPressureSensitivity: number; // Default: 0.5 (how much pressure affects TP)

  // Late-game sell ladder settings
  maxChunkSizeUsd: number; // Default: 50 (max $50 per chunk)
  minChunkSizeUsd: number; // Default: 5 (min $5 per chunk)
  ladderTickOffset: number; // Default: 0.01 (1¢ below bestAsk when bestBid fails)
  maxLadderPrice: number; // Default: 0.99 (never post above 99¢)

  // Risk-off settings
  bidCollapseThreshold: number; // Default: 0.1 (10% drop triggers alert)
  minHealthySpreadCents: number; // Default: 5 (5¢ max spread for healthy book)

  // Close-to-end score weights
  timeWeight: number; // Default: 0.4
  priceStabilityWeight: number; // Default: 0.3
  depthHealthWeight: number; // Default: 0.3

  // Telegram notifications
  telegramEnabled: boolean; // Default: true
}

/**
 * Default configuration
 */
export const DEFAULT_EXIT_ENGINE_CONFIG: ExitEngineConfig = {
  lateGamePriceThreshold: 0.97,
  closeToEndScoreThreshold: 0.7,
  baseTpCents: 14,
  minTpCents: 5,
  tpPressureSensitivity: 0.5,
  maxChunkSizeUsd: 50,
  minChunkSizeUsd: 5,
  ladderTickOffset: 0.01,
  maxLadderPrice: 0.99,
  bidCollapseThreshold: 0.1,
  minHealthySpreadCents: 5,
  timeWeight: 0.4,
  priceStabilityWeight: 0.3,
  depthHealthWeight: 0.3,
  telegramEnabled: true,
};

/**
 * Per-position exit state tracking
 */
export interface PositionExitState {
  positionId: string;
  tokenId: string;
  state: ExitState;
  stateReason: ExitStateReason;
  enteredStateAt: number;
  closeToEndScore: number;
  lastMarkPrice: number;
  lastBestBid: number;
  chunksSold: number;
  totalSoldUsd: number;
  remainingSizeUsd: number;
  alerts: string[];
}

/**
 * Exit decision result
 */
export interface ExitDecisionResult {
  action: "NONE" | "SELL_AT_BID" | "POST_LIMIT" | "CHUNK_SELL" | "ALERT";
  state: ExitState;
  reason: string;
  price?: number;
  sizeUsd?: number;
  alertMessage?: string;
}

/**
 * Exit order result
 */
export interface ExitOrderResult {
  success: boolean;
  filledUsd?: number;
  filledPrice?: number;
  reason?: string;
  orderId?: string;
}

/**
 * Market data for exit decisions
 */
export interface ExitMarketData {
  snapshot: MarketSnapshot;
  bidDepthUsd: number;
  askDepthUsd: number;
  timeToResolutionMs?: number; // Time until market resolves (if known)
  recentPriceStdDev?: number; // Price volatility measure
}

/**
 * Logger interface for exit engine
 */
export interface ExitEngineLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXIT ENGINE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

export class ExitEngine {
  private readonly config: ExitEngineConfig;
  private readonly logger: ExitEngineLogger;
  private positionStates: Map<string, PositionExitState> = new Map();
  private client: ClobClient | null = null;

  constructor(
    config: Partial<ExitEngineConfig> = {},
    logger?: ExitEngineLogger,
  ) {
    this.config = { ...DEFAULT_EXIT_ENGINE_CONFIG, ...config };
    this.logger = logger || {
      info: (msg) => console.log(`[ExitEngine] ${msg}`),
      warn: (msg) => console.warn(`[ExitEngine] ${msg}`),
      error: (msg) => console.error(`[ExitEngine] ${msg}`),
    };
  }

  /**
   * Set the CLOB client for order execution
   */
  setClient(client: ClobClient): void {
    this.client = client;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLOSE-TO-END SCORE COMPUTATION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Compute closeToEndScore using:
   * - timeToResolution (if available)
   * - price stability near 0.97-0.99
   * - spread/depth health
   *
   * Returns a score between 0 and 1, where higher means closer to resolution
   */
  computeCloseToEndScore(
    markPrice: number,
    marketData: ExitMarketData,
  ): number {
    let timeScore = 0;
    let priceStabilityScore = 0;
    let depthHealthScore = 0;

    // 1. Time-based score (if timeToResolution is available)
    if (marketData.timeToResolutionMs !== undefined) {
      const hoursRemaining = marketData.timeToResolutionMs / (1000 * 60 * 60);
      // Score increases as time decreases (max at <1 hour)
      if (hoursRemaining <= 1) {
        timeScore = 1.0;
      } else if (hoursRemaining <= 6) {
        timeScore = 0.8;
      } else if (hoursRemaining <= 24) {
        timeScore = 0.5;
      } else if (hoursRemaining <= 72) {
        timeScore = 0.2;
      } else {
        timeScore = 0;
      }
    } else {
      // If no time info, use price as proxy (high price = likely near resolution)
      timeScore = markPrice >= 0.95 ? 0.6 : markPrice >= 0.9 ? 0.3 : 0;
    }

    // 2. Price stability score (high price near 0.97-0.99 with low volatility)
    if (markPrice >= 0.97) {
      // In the target zone
      const volatility = marketData.recentPriceStdDev ?? 0.01;
      // Low volatility (< 1%) = high stability score
      priceStabilityScore =
        volatility < 0.01 ? 1.0 : volatility < 0.02 ? 0.7 : 0.4;
    } else if (markPrice >= 0.9) {
      // Approaching target zone
      priceStabilityScore = 0.3;
    } else {
      priceStabilityScore = 0;
    }

    // 3. Depth health score (good liquidity = higher score)
    const spreadCents = marketData.snapshot.spreadCents;
    const minDepthUsd = Math.min(
      marketData.bidDepthUsd,
      marketData.askDepthUsd,
    );

    if (
      spreadCents <= this.config.minHealthySpreadCents &&
      minDepthUsd >= 100
    ) {
      depthHealthScore = 1.0;
    } else if (spreadCents <= 10 && minDepthUsd >= 50) {
      depthHealthScore = 0.7;
    } else if (spreadCents <= 20 && minDepthUsd >= 20) {
      depthHealthScore = 0.4;
    } else {
      depthHealthScore = 0.1;
    }

    // Weighted combination
    const score =
      this.config.timeWeight * timeScore +
      this.config.priceStabilityWeight * priceStabilityScore +
      this.config.depthHealthWeight * depthHealthScore;

    return Math.min(1, Math.max(0, score));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DYNAMIC TAKE PROFIT
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Compute dynamic take profit target that tightens with reserve pressure
   *
   * When reservePressure is high (near 1), TP tightens to minTpCents
   * When reservePressure is low (near 0), TP stays at baseTpCents
   */
  computeDynamicTpCents(reserveState: DynamicReserveState): number {
    // Calculate reserve pressure as ratio of adapted to base
    // Higher adapted fraction = more pressure (holding more in reserve)
    const reservePressure = Math.min(
      1,
      Math.max(
        0,
        (reserveState.adaptedReserveFraction -
          reserveState.baseReserveFraction) /
          (0.5 - reserveState.baseReserveFraction + 0.001), // Normalize to 0-1
      ),
    );

    // Also consider missed opportunities as pressure indicator
    const missedPressure = Math.min(1, reserveState.missedCount / 10);

    // Combined pressure
    const totalPressure = Math.max(reservePressure, missedPressure);

    // Interpolate between baseTpCents and minTpCents based on pressure
    const tpRange = this.config.baseTpCents - this.config.minTpCents;
    const adjustedTp =
      this.config.baseTpCents -
      tpRange * totalPressure * this.config.tpPressureSensitivity;

    return Math.max(this.config.minTpCents, adjustedTp);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATE MACHINE TRANSITIONS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Initialize or get position exit state
   */
  getOrCreatePositionState(
    position: ManagedPosition,
    marketData: ExitMarketData,
  ): PositionExitState {
    let state = this.positionStates.get(position.id);

    if (!state) {
      const markPrice = marketData.snapshot.bestBid;
      state = {
        positionId: position.id,
        tokenId: position.tokenId,
        state: "HOLD",
        stateReason: "INITIAL",
        enteredStateAt: Date.now(),
        closeToEndScore: this.computeCloseToEndScore(markPrice, marketData),
        lastMarkPrice: markPrice,
        lastBestBid: marketData.snapshot.bestBid,
        chunksSold: 0,
        totalSoldUsd: 0,
        remainingSizeUsd: position.entrySizeUsd,
        alerts: [],
      };
      this.positionStates.set(position.id, state);
    }

    return state;
  }

  /**
   * Transition position to new exit state
   */
  private transitionState(
    state: PositionExitState,
    newState: ExitState,
    reason: ExitStateReason,
  ): void {
    const oldState = state.state;
    state.state = newState;
    state.stateReason = reason;
    state.enteredStateAt = Date.now();

    // Log state transition
    this.logExitDecision({
      positionId: state.positionId,
      tokenId: state.tokenId,
      fromState: oldState,
      toState: newState,
      reason,
      closeToEndScore: state.closeToEndScore,
      markPrice: state.lastMarkPrice,
      bestBid: state.lastBestBid,
    });

    // Send Telegram notification for significant transitions
    if (this.config.telegramEnabled && newState !== "HOLD") {
      this.notifyExitStateChange(state, oldState, newState, reason);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT DECISION LOGIC
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate exit decision for a position
   *
   * This is the main decision function that determines what action to take
   * based on the current state and market conditions.
   */
  evaluateExit(
    position: ManagedPosition,
    marketData: ExitMarketData,
    reserveState: DynamicReserveState,
  ): ExitDecisionResult {
    const state = this.getOrCreatePositionState(position, marketData);
    const markPrice = marketData.snapshot.bestBid;
    const closeToEndScore = this.computeCloseToEndScore(markPrice, marketData);

    // Update state tracking
    state.closeToEndScore = closeToEndScore;
    state.lastMarkPrice = markPrice;
    const previousBestBid = state.lastBestBid;
    state.lastBestBid = marketData.snapshot.bestBid;

    // Check for bid collapse (for RISK_OFF alerting)
    const bidChangeRatio =
      previousBestBid > 0
        ? (previousBestBid - marketData.snapshot.bestBid) / previousBestBid
        : 0;

    // State machine logic
    switch (state.state) {
      case "HOLD":
        return this.evaluateHoldState(
          state,
          position,
          marketData,
          reserveState,
          closeToEndScore,
          markPrice,
        );

      case "TAKE_PROFIT":
        return this.evaluateTakeProfitState(
          state,
          position,
          marketData,
          reserveState,
        );

      case "LATE_GAME_EXIT":
        return this.evaluateLateGameState(
          state,
          position,
          marketData,
          reserveState,
          bidChangeRatio,
        );

      case "RISK_OFF":
        return this.evaluateRiskOffState(
          state,
          position,
          marketData,
          bidChangeRatio,
        );

      case "COMPLETE":
        return {
          action: "NONE",
          state: "COMPLETE",
          reason: "Exit already complete",
        };

      default:
        return { action: "NONE", state: state.state, reason: "Unknown state" };
    }
  }

  /**
   * Evaluate HOLD state - check for transitions to other states
   */
  private evaluateHoldState(
    state: PositionExitState,
    position: ManagedPosition,
    marketData: ExitMarketData,
    reserveState: DynamicReserveState,
    closeToEndScore: number,
    markPrice: number,
  ): ExitDecisionResult {
    // Calculate current P&L
    const pnlCents = position.currentPriceCents - position.entryPriceCents;
    const dynamicTpCents = this.computeDynamicTpCents(reserveState);

    // Check for TAKE_PROFIT trigger
    if (pnlCents >= dynamicTpCents) {
      this.transitionState(state, "TAKE_PROFIT", "TP_TRIGGERED");
      return {
        action: "SELL_AT_BID",
        state: "TAKE_PROFIT",
        reason: `TP triggered: +${pnlCents.toFixed(1)}¢ >= ${dynamicTpCents.toFixed(1)}¢ dynamic TP`,
        price: marketData.snapshot.bestBid,
        sizeUsd: state.remainingSizeUsd,
      };
    }

    // Check for LATE_GAME_EXIT trigger
    if (
      markPrice >= this.config.lateGamePriceThreshold &&
      closeToEndScore >= this.config.closeToEndScoreThreshold
    ) {
      this.transitionState(state, "LATE_GAME_EXIT", "LATE_GAME_SCORE_HIGH");
      return this.evaluateLateGameState(
        state,
        position,
        marketData,
        reserveState,
        0,
      );
    }

    // Check for RISK_OFF conditions (unhealthy book, position in loss)
    const spreadCents = marketData.snapshot.spreadCents;
    if (spreadCents > this.config.minHealthySpreadCents * 3 && pnlCents < 0) {
      this.transitionState(state, "RISK_OFF", "BOOK_UNHEALTHY");
      return {
        action: "SELL_AT_BID",
        state: "RISK_OFF",
        reason: `RISK_OFF: Unhealthy book (spread ${spreadCents.toFixed(1)}¢) with loss`,
        price: marketData.snapshot.bestBid,
        sizeUsd: state.remainingSizeUsd,
        alertMessage: `⚠️ RISK_OFF triggered for ${position.tokenId.slice(0, 12)}... - unhealthy book`,
      };
    }

    // Continue holding
    return {
      action: "NONE",
      state: "HOLD",
      reason: `Holding: P&L ${pnlCents >= 0 ? "+" : ""}${pnlCents.toFixed(1)}¢, closeToEnd=${(closeToEndScore * 100).toFixed(0)}%`,
    };
  }

  /**
   * Evaluate TAKE_PROFIT state - attempt to sell at best price
   */
  private evaluateTakeProfitState(
    state: PositionExitState,
    _position: ManagedPosition,
    marketData: ExitMarketData,
    _reserveState: DynamicReserveState,
  ): ExitDecisionResult {
    const bestBid = marketData.snapshot.bestBid;

    // Sell at best bid
    return {
      action: "SELL_AT_BID",
      state: "TAKE_PROFIT",
      reason: `Taking profit at ${(bestBid * 100).toFixed(1)}¢`,
      price: bestBid,
      sizeUsd: state.remainingSizeUsd,
    };
  }

  /**
   * Evaluate LATE_GAME_EXIT state - implement sell ladder
   *
   * Strategy:
   * 1. Try bestBid first
   * 2. Else post at min(bestAsk - 1 tick, 0.99) when safe
   * 3. Exit in chunks if book depth < position size
   */
  private evaluateLateGameState(
    state: PositionExitState,
    position: ManagedPosition,
    marketData: ExitMarketData,
    reserveState: DynamicReserveState,
    bidChangeRatio: number,
  ): ExitDecisionResult {
    const bestBid = marketData.snapshot.bestBid;
    const bestAsk = marketData.snapshot.bestAsk;
    const bidDepthUsd = marketData.bidDepthUsd;

    // Check for bid collapse - transition to RISK_OFF
    if (bidChangeRatio >= this.config.bidCollapseThreshold) {
      this.transitionState(state, "RISK_OFF", "BID_COLLAPSED");
      return {
        action: "ALERT",
        state: "RISK_OFF",
        reason: `Bid collapsed ${(bidChangeRatio * 100).toFixed(1)}% - transitioning to RISK_OFF`,
        alertMessage: `🚨 BID COLLAPSED for ${position.tokenId.slice(0, 12)}... - ${(bidChangeRatio * 100).toFixed(1)}% drop`,
      };
    }

    // Calculate reserve pressure for willingness to accept lower prices
    const reservePressure = Math.min(
      1,
      (reserveState.adaptedReserveFraction - reserveState.baseReserveFraction) /
        (0.5 - reserveState.baseReserveFraction + 0.001),
    );

    // Determine acceptable sell price based on reserve pressure
    // High pressure = more willing to accept 0.98 vs waiting for 0.99
    const minAcceptablePrice = reservePressure > 0.5 ? 0.97 : 0.98;

    // Determine chunk size based on depth
    let chunkSizeUsd: number;
    if (bidDepthUsd >= state.remainingSizeUsd) {
      // Enough depth - sell all
      chunkSizeUsd = state.remainingSizeUsd;
    } else {
      // Chunk based on available depth
      chunkSizeUsd = Math.max(
        this.config.minChunkSizeUsd,
        Math.min(this.config.maxChunkSizeUsd, bidDepthUsd * 0.8),
      );
    }

    // Strategy 1: Try bestBid if acceptable
    if (bestBid >= minAcceptablePrice) {
      return {
        action:
          chunkSizeUsd < state.remainingSizeUsd ? "CHUNK_SELL" : "SELL_AT_BID",
        state: "LATE_GAME_EXIT",
        reason: `Late-game sell at bestBid ${(bestBid * 100).toFixed(1)}¢`,
        price: bestBid,
        sizeUsd: chunkSizeUsd,
      };
    }

    // Strategy 2: Post limit at min(bestAsk - 1 tick, 0.99)
    const tickSize = marketData.snapshot.tickSize || 0.01;
    const limitPrice = Math.min(
      this.config.maxLadderPrice,
      roundToTick(bestAsk - this.config.ladderTickOffset, tickSize, "SELL"),
    );

    // Ensure limit price is at least acceptable
    if (limitPrice >= minAcceptablePrice) {
      return {
        action: "POST_LIMIT",
        state: "LATE_GAME_EXIT",
        reason: `Late-game post limit at ${(limitPrice * 100).toFixed(1)}¢ (bestAsk=${(bestAsk * 100).toFixed(1)}¢ - tick)`,
        price: limitPrice,
        sizeUsd: chunkSizeUsd,
      };
    }

    // Neither strategy acceptable - hold and alert
    return {
      action: "ALERT",
      state: "LATE_GAME_EXIT",
      reason: `Late-game hold: bestBid ${(bestBid * 100).toFixed(1)}¢ < min ${(minAcceptablePrice * 100).toFixed(0)}¢`,
      alertMessage: `⚠️ Late-game hold for ${position.tokenId.slice(0, 12)}... - no acceptable price`,
    };
  }

  /**
   * Evaluate RISK_OFF state - exit ASAP at bestBid
   */
  private evaluateRiskOffState(
    state: PositionExitState,
    position: ManagedPosition,
    marketData: ExitMarketData,
    bidChangeRatio: number,
  ): ExitDecisionResult {
    const bestBid = marketData.snapshot.bestBid;
    const spreadCents = marketData.snapshot.spreadCents;

    // Check if book is too unhealthy to trade
    if (spreadCents > this.config.minHealthySpreadCents * 5) {
      const alertMsg = `🚨 RISK_OFF HALTED for ${position.tokenId.slice(0, 12)}... - book too unhealthy (spread ${spreadCents.toFixed(1)}¢)`;
      state.alerts.push(alertMsg);
      return {
        action: "ALERT",
        state: "RISK_OFF",
        reason: "Book too unhealthy to exit",
        alertMessage: alertMsg,
      };
    }

    // Check for continued bid collapse
    if (bidChangeRatio >= this.config.bidCollapseThreshold) {
      const alertMsg = `🚨 BID STILL COLLAPSING for ${position.tokenId.slice(0, 12)}... - ${(bidChangeRatio * 100).toFixed(1)}% drop`;
      state.alerts.push(alertMsg);
      return {
        action: "ALERT",
        state: "RISK_OFF",
        reason: "Bid still collapsing - waiting",
        alertMessage: alertMsg,
      };
    }

    // Exit at bestBid
    return {
      action: "SELL_AT_BID",
      state: "RISK_OFF",
      reason: `RISK_OFF: Exiting at bestBid ${(bestBid * 100).toFixed(1)}¢`,
      price: bestBid,
      sizeUsd: state.remainingSizeUsd,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT EXECUTION
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute exit order based on decision
   *
   * Uses shared placeOrderWithFallback() semantics and MarketSnapshot
   */
  async executeExit(
    position: ManagedPosition,
    decision: ExitDecisionResult,
    snapshot: MarketSnapshot,
  ): Promise<ExitOrderResult> {
    if (decision.action === "NONE" || decision.action === "ALERT") {
      return { success: true, reason: decision.reason };
    }

    if (!this.client) {
      this.logger.error("No CLOB client configured for exit execution");
      return { success: false, reason: "NO_CLIENT" };
    }

    const state = this.positionStates.get(position.id);
    if (!state) {
      return { success: false, reason: "NO_STATE" };
    }

    // Log order submission
    this.logExitOrderSubmit({
      positionId: position.id,
      tokenId: position.tokenId,
      action: decision.action,
      state: decision.state,
      price: decision.price,
      sizeUsd: decision.sizeUsd,
      snapshotAttemptId: snapshot.attemptId,
    });

    try {
      // Calculate shares to sell
      const priceDecimal = decision.price || snapshot.bestBid;
      const sizeUsd = decision.sizeUsd || state.remainingSizeUsd;
      const sharesToSell = priceDecimal > 0 ? sizeUsd / priceDecimal : 0;

      if (sharesToSell <= 0) {
        return { success: false, reason: "INVALID_SIZE" };
      }

      // Round price to tick (SELL rounds DOWN)
      const tickSize = snapshot.tickSize || 0.01;
      const roundedPrice = roundToTick(priceDecimal, tickSize, "SELL");

      // Clamp to HARD API bounds
      const clampedPrice = Math.max(
        HARD_MIN_PRICE,
        Math.min(HARD_MAX_PRICE, roundedPrice),
      );

      // Create and post the order
      // Note: In production, this would use the shared placeOrderWithFallback()
      // For now, we use the client directly
      const { Side, OrderType } = await import("@polymarket/clob-client");

      const signedOrder = await this.client.createMarketOrder({
        side: Side.SELL,
        tokenID: position.tokenId,
        amount: sharesToSell,
        price: clampedPrice,
      });

      // Use FOK for immediate exits, GTC for late-game limit orders
      const orderType =
        decision.action === "POST_LIMIT" ? OrderType.GTC : OrderType.FOK;
      const response = await this.client.postOrder(signedOrder, orderType);

      // Log result
      const success = response?.success === true;
      this.logExitOrderResult({
        positionId: position.id,
        tokenId: position.tokenId,
        success,
        filledUsd: success ? sizeUsd : undefined,
        filledPrice: success ? clampedPrice : undefined,
        reason: success ? undefined : (response as any)?.errorMsg || "UNKNOWN",
        orderId: (response as any)?.orderId,
      });

      if (success) {
        // Update state
        state.chunksSold++;
        state.totalSoldUsd += sizeUsd;
        state.remainingSizeUsd -= sizeUsd;

        // Check if complete
        if (state.remainingSizeUsd <= this.config.minChunkSizeUsd) {
          this.transitionState(state, "COMPLETE", "EXIT_FILLED");
        }

        // Send Telegram notification
        if (this.config.telegramEnabled) {
          this.notifyExitOrderFilled(state, position, sizeUsd, clampedPrice);
        }

        return {
          success: true,
          filledUsd: sizeUsd,
          filledPrice: clampedPrice,
          orderId: (response as any)?.orderId,
        };
      } else {
        return {
          success: false,
          reason: (response as any)?.errorMsg || "ORDER_FAILED",
        };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Exit order error: ${errorMsg}`);
      this.logExitOrderResult({
        positionId: position.id,
        tokenId: position.tokenId,
        success: false,
        reason: errorMsg,
      });
      return { success: false, reason: errorMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Log EXIT_DECISION with reason, state, closeToEndScore, reservePressure, prices, depth
   */
  private logExitDecision(params: {
    positionId: string;
    tokenId: string;
    fromState: ExitState;
    toState: ExitState;
    reason: ExitStateReason;
    closeToEndScore: number;
    markPrice: number;
    bestBid: number;
  }): void {
    console.log(
      JSON.stringify({
        event: "EXIT_DECISION",
        timestamp: new Date().toISOString(),
        positionId: params.positionId.slice(0, 16),
        tokenIdPrefix: params.tokenId.slice(0, 12),
        fromState: params.fromState,
        toState: params.toState,
        reason: params.reason,
        closeToEndScore: params.closeToEndScore.toFixed(3),
        markPriceCents: (params.markPrice * 100).toFixed(2),
        bestBidCents: (params.bestBid * 100).toFixed(2),
      }),
    );

    this.logger.info(
      `EXIT_DECISION: ${params.positionId.slice(0, 16)}... ${params.fromState} → ${params.toState} (${params.reason}) | score=${(params.closeToEndScore * 100).toFixed(0)}% mark=${(params.markPrice * 100).toFixed(1)}¢`,
    );
  }

  /**
   * Log EXIT_ORDER_SUBMIT
   */
  private logExitOrderSubmit(params: {
    positionId: string;
    tokenId: string;
    action: string;
    state: ExitState;
    price?: number;
    sizeUsd?: number;
    snapshotAttemptId: string;
  }): void {
    console.log(
      JSON.stringify({
        event: "EXIT_ORDER_SUBMIT",
        timestamp: new Date().toISOString(),
        positionId: params.positionId.slice(0, 16),
        tokenIdPrefix: params.tokenId.slice(0, 12),
        action: params.action,
        state: params.state,
        priceCents: params.price ? (params.price * 100).toFixed(2) : null,
        sizeUsd: params.sizeUsd?.toFixed(2),
        snapshotAttemptId: params.snapshotAttemptId,
      }),
    );
  }

  /**
   * Log EXIT_ORDER_RESULT
   */
  private logExitOrderResult(params: {
    positionId: string;
    tokenId: string;
    success: boolean;
    filledUsd?: number;
    filledPrice?: number;
    reason?: string;
    orderId?: string;
  }): void {
    console.log(
      JSON.stringify({
        event: "EXIT_ORDER_RESULT",
        timestamp: new Date().toISOString(),
        positionId: params.positionId.slice(0, 16),
        tokenIdPrefix: params.tokenId.slice(0, 12),
        success: params.success,
        filledUsd: params.filledUsd?.toFixed(2),
        filledPriceCents: params.filledPrice
          ? (params.filledPrice * 100).toFixed(2)
          : null,
        reason: params.reason,
        orderId: params.orderId,
      }),
    );

    if (params.success) {
      this.logger.info(
        `EXIT_ORDER_RESULT: ${params.positionId.slice(0, 16)}... ✅ Filled $${params.filledUsd?.toFixed(2)} @ ${((params.filledPrice || 0) * 100).toFixed(1)}¢`,
      );
    } else {
      this.logger.warn(
        `EXIT_ORDER_RESULT: ${params.positionId.slice(0, 16)}... ❌ Failed: ${params.reason}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TELEGRAM NOTIFICATIONS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Notify Telegram about exit state change
   */
  private async notifyExitStateChange(
    state: PositionExitState,
    fromState: ExitState,
    toState: ExitState,
    reason: ExitStateReason,
  ): Promise<void> {
    const emoji = this.getStateEmoji(toState);
    const title = `${emoji} Exit Strategy: ${toState}`;

    const message = [
      `Token: ${state.tokenId.slice(0, 12)}...`,
      `From: ${fromState} → ${toState}`,
      `Reason: ${reason}`,
      `Close-to-End Score: ${(state.closeToEndScore * 100).toFixed(0)}%`,
      `Mark Price: ${(state.lastMarkPrice * 100).toFixed(1)}¢`,
      `Remaining: $${state.remainingSizeUsd.toFixed(2)}`,
    ].join("\n");

    await sendTelegram(title, message);
  }

  /**
   * Notify Telegram about filled exit order
   */
  private async notifyExitOrderFilled(
    state: PositionExitState,
    position: ManagedPosition,
    filledUsd: number,
    filledPrice: number,
  ): Promise<void> {
    const pnlCents = position.currentPriceCents - position.entryPriceCents;
    const pnlPct = (pnlCents / position.entryPriceCents) * 100;
    const emoji = pnlCents >= 0 ? "💰" : "📉";

    const title = `${emoji} Exit Filled: ${state.state}`;

    const message = [
      `Token: ${position.tokenId.slice(0, 12)}...`,
      `Strategy: ${state.state}`,
      `Sold: $${filledUsd.toFixed(2)} @ ${(filledPrice * 100).toFixed(1)}¢`,
      `P&L: ${pnlCents >= 0 ? "+" : ""}${pnlCents.toFixed(1)}¢ (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)`,
      `Chunks Sold: ${state.chunksSold}`,
      `Remaining: $${state.remainingSizeUsd.toFixed(2)}`,
    ].join("\n");

    await sendTelegram(title, message);
  }

  /**
   * Get emoji for exit state
   */
  private getStateEmoji(state: ExitState): string {
    switch (state) {
      case "HOLD":
        return "⏳";
      case "TAKE_PROFIT":
        return "💰";
      case "LATE_GAME_EXIT":
        return "🎯";
      case "RISK_OFF":
        return "🚨";
      case "COMPLETE":
        return "✅";
      default:
        return "📊";
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UTILITY METHODS
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get position exit state
   */
  getPositionState(positionId: string): PositionExitState | undefined {
    return this.positionStates.get(positionId);
  }

  /**
   * Remove position state (when position is closed)
   */
  removePositionState(positionId: string): void {
    this.positionStates.delete(positionId);
  }

  /**
   * Clear all position states (for testing)
   */
  clear(): void {
    this.positionStates.clear();
  }

  /**
   * Get config for inspection
   */
  getConfig(): Readonly<ExitEngineConfig> {
    return { ...this.config };
  }
}
