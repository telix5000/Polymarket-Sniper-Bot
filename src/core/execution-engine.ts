/**
 * Execution Engine
 *
 * Handles order execution for entries and exits.
 * Coordinates with EvTracker, BiasAccumulator, PositionManager, and DecisionEngine.
 *
 * Extracted from start.ts for modularity.
 */

import type { ClobClient } from "@polymarket/clob-client";
import { getBalanceCache } from "../lib/balance";
import { invalidatePositions } from "../lib/positions";
import { getOppositeTokenId, getMarketTokenPair } from "../lib/market";
import { reportError } from "../infra/github-reporter";
import { getLatencyMonitor } from "../infra/latency-monitor";
import { smartSell } from "./smart-sell";
import type { Position } from "../models";
import {
  EvTracker,
  type TradeResult,
  calculatePnlCents,
  calculatePnlUsd,
  createTradeResult,
} from "./ev-tracker";
import {
  DecisionEngine,
  type EvMetrics,
  type OrderbookState,
  type MarketActivity,
  type ManagedPosition,
  type ExitReason,
  type BiasDirection,
} from "./decision-engine";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of an execution attempt (entry or exit)
 */
export interface ExecutionResult {
  success: boolean;
  filledUsd?: number;
  filledPriceCents?: number;
  reason?: string;
  pending?: boolean; // True if order is GTC and waiting for fill
}

/**
 * Market data for a token, used for entry/exit decisions
 */
export interface TokenMarketData {
  tokenId: string;
  marketId?: string;
  orderbook: OrderbookState;
  activity: MarketActivity;
  referencePriceCents: number;
  // Opposite token data for hedging - proactively monitored
  oppositeTokenId?: string;
  oppositeOrderbook?: OrderbookState;
}

/**
 * Logger interface for execution engine
 */
export interface ChurnLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Configuration interface for ExecutionEngine.
 * This is a subset of ChurnConfig that the engine needs.
 */
export interface ExecutionEngineConfig {
  liveTradingEnabled: boolean;
  reserveFraction: number;
  minReserveUsd: number;
  cooldownSecondsPerToken: number;
  copyAnyWhaleBuy: boolean;
}

/**
 * Interface for BiasAccumulator (extracted to lib/bias-accumulator.ts)
 */
export interface BiasAccumulatorInterface {
  getBias(tokenId: string): {
    direction: BiasDirection;
    tradeCount: number;
    isStale: boolean;
  };
}

/**
 * Interface for PositionManager (extracted to core/position-manager.ts)
 */
export interface PositionManagerInterface {
  getOpenPositions(): ManagedPosition[];
  getTotalDeployedUsd(): number;
  openPosition(params: {
    tokenId: string;
    marketId?: string;
    side: "LONG" | "SHORT";
    entryPriceCents: number;
    sizeUsd: number;
    referencePriceCents: number;
    evSnapshot: EvMetrics;
    biasDirection: BiasDirection;
    // Outcome info for display (Telegram notifications)
    outcomeLabel?: string;
    outcomeIndex?: 1 | 2;
    marketQuestion?: string;
  }): ManagedPosition;
  setOppositeToken(
    positionId: string,
    oppositeTokenId: string,
    oppositeOutcomeLabel?: string,
  ): void;
  updatePrice(
    positionId: string,
    priceCents: number,
    evMetrics: EvMetrics,
    biasDirection: BiasDirection,
  ): { action: "NONE" | "HOLD" | "EXIT" | "HEDGE"; reason?: ExitReason };
  beginExit(
    positionId: string,
    reason: ExitReason,
    evMetrics: EvMetrics,
    biasDirection: BiasDirection,
  ): void;
  closePosition(
    positionId: string,
    exitPriceCents: number,
    evMetrics: EvMetrics,
    biasDirection: BiasDirection,
  ): ManagedPosition | null;
  recordHedge(
    positionId: string,
    hedge: {
      tokenId: string;
      sizeUsd: number;
      entryPriceCents: number;
      entryTime: number;
    },
    evMetrics: EvMetrics,
    biasDirection: BiasDirection,
  ): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Execution Engine
// ═══════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
  private config: ExecutionEngineConfig;
  private evTracker: EvTracker;
  private biasAccumulator: BiasAccumulatorInterface;
  private positionManager: PositionManagerInterface;
  private decisionEngine: DecisionEngine;
  private logger: ChurnLogger;
  private client: ClobClient | null = null;
  private cooldowns: Map<string, number> = new Map();

  constructor(
    config: ExecutionEngineConfig,
    evTracker: EvTracker,
    biasAccumulator: BiasAccumulatorInterface,
    positionManager: PositionManagerInterface,
    decisionEngine: DecisionEngine,
    logger: ChurnLogger,
  ) {
    this.config = config;
    this.evTracker = evTracker;
    this.biasAccumulator = biasAccumulator;
    this.positionManager = positionManager;
    this.decisionEngine = decisionEngine;
    this.logger = logger;
  }

  setClient(client: ClobClient): void {
    this.client = client;
  }

  getEffectiveBankroll(balance: number): {
    effectiveBankroll: number;
    reserveUsd: number;
  } {
    const reserveUsd = Math.max(
      balance * this.config.reserveFraction,
      this.config.minReserveUsd,
    );
    return { effectiveBankroll: Math.max(0, balance - reserveUsd), reserveUsd };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENTRY
  // ─────────────────────────────────────────────────────────────────────────

  async processEntry(
    tokenId: string,
    marketData: TokenMarketData,
    balance: number,
    skipBiasCheck = false,
  ): Promise<ExecutionResult> {
    // Cooldown check
    const cooldownUntil = this.cooldowns.get(tokenId) || 0;
    if (Date.now() < cooldownUntil) {
      return { success: false, reason: "COOLDOWN" };
    }

    const bias = this.biasAccumulator.getBias(tokenId);
    const evAllowed = this.evTracker.isTradingAllowed();
    const { effectiveBankroll } = this.getEffectiveBankroll(balance);

    if (effectiveBankroll <= 0) {
      return { success: false, reason: "NO_BANKROLL" };
    }

    // Determine effective bias direction:
    // 1. skipBiasCheck (scanner entries): use LONG
    // 2. copyAnyWhaleBuy mode: treat any non-stale token with 1+ whale buy as LONG
    // 3. Otherwise: use the computed bias direction (requires 3+ trades, $300 flow)
    let effectiveBias: BiasDirection;
    if (skipBiasCheck) {
      // Scanner-originated entries: use LONG since we only scan for active markets
      // with prices in the 20-80¢ range (good entry territory)
      effectiveBias = "LONG";
    } else if (
      this.config.copyAnyWhaleBuy &&
      bias.tradeCount >= 1 &&
      !bias.isStale
    ) {
      // COPY_ANY_WHALE_BUY mode: any single non-stale whale buy is enough
      // Override direction to LONG (we only track buys)
      effectiveBias = "LONG";
    } else {
      // Conservative mode: use computed bias direction
      effectiveBias = bias.direction;
    }

    // Evaluate entry
    const decision = this.decisionEngine.evaluateEntry({
      tokenId,
      bias: effectiveBias,
      orderbook: marketData.orderbook,
      activity: marketData.activity,
      referencePriceCents: marketData.referencePriceCents,
      evMetrics: this.evTracker.getMetrics(),
      evAllowed,
      currentPositions: this.positionManager.getOpenPositions(),
      effectiveBankroll,
      totalDeployedUsd: this.positionManager.getTotalDeployedUsd(),
    });

    if (!decision.allowed) {
      return { success: false, reason: decision.reason };
    }

    // Execute
    const result = await this.executeEntry(
      tokenId,
      marketData.marketId,
      decision.side!,
      decision.priceCents!,
      decision.sizeUsd!,
      marketData.referencePriceCents,
      effectiveBias,
    );

    if (result.success) {
      this.cooldowns.set(
        tokenId,
        Date.now() + this.config.cooldownSecondsPerToken * 1000,
      );
      // Force balance refresh after successful trade
      getBalanceCache()
        ?.forceRefresh()
        .catch(() => {});
    }

    return result;
  }

  private async executeEntry(
    tokenId: string,
    marketId: string | undefined,
    side: "LONG" | "SHORT",
    priceCents: number,
    sizeUsd: number,
    referencePriceCents: number,
    biasDirection: BiasDirection,
  ): Promise<ExecutionResult> {
    const evMetrics = this.evTracker.getMetrics();

    // Fetch market info for outcome labels (for Telegram/display) and hedging
    // This gives us the full market context including outcomeLabels and opposite token
    let oppositeTokenId: string | null = null;
    let outcomeLabel: string | undefined;
    let outcomeIndex: 1 | 2 | undefined;
    let marketQuestion: string | undefined;
    let oppositeOutcomeLabel: string | undefined;

    try {
      const marketInfo = await getMarketTokenPair(tokenId);
      if (marketInfo) {
        // Find this token's info
        const tokenInfo = marketInfo.tokens?.find((t) => t.tokenId === tokenId);
        const siblingInfo = marketInfo.tokens?.find(
          (t) => t.tokenId !== tokenId,
        );

        if (tokenInfo) {
          outcomeLabel = tokenInfo.outcomeLabel;
          outcomeIndex = tokenInfo.outcomeIndex;
        }

        if (siblingInfo) {
          oppositeTokenId = siblingInfo.tokenId;
          oppositeOutcomeLabel = siblingInfo.outcomeLabel;
        }

        marketQuestion = marketInfo.question;

        if (oppositeTokenId) {
          console.log(
            `🔍 [HEDGE] Found opposite token for hedging: ${oppositeTokenId.slice(0, 16)}... ("${oppositeOutcomeLabel || "unknown"}")`,
          );
        }

        // Log the outcome info for diagnostics
        if (outcomeLabel) {
          console.log(
            `📊 [ENTRY] Taking "${outcomeLabel}" position (idx=${outcomeIndex}) in: ${marketQuestion?.slice(0, 50) || marketId || "unknown market"}...`,
          );
        }
      } else {
        // Fallback: try to get just the opposite token
        oppositeTokenId = await getOppositeTokenId(tokenId);
        if (oppositeTokenId) {
          console.log(
            `🔍 [HEDGE] Found opposite token for hedging: ${oppositeTokenId.slice(0, 16)}...`,
          );
        } else {
          console.warn(
            `⚠️ [HEDGE] Could not find opposite token for ${tokenId.slice(0, 16)}... - hedging will be disabled`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `⚠️ [HEDGE] Error looking up market info: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Simulation mode
    if (!this.config.liveTradingEnabled) {
      const position = this.positionManager.openPosition({
        tokenId,
        marketId,
        side,
        entryPriceCents: priceCents,
        sizeUsd,
        referencePriceCents,
        evSnapshot: evMetrics,
        biasDirection,
        // Outcome info for Telegram notifications
        outcomeLabel,
        outcomeIndex,
        marketQuestion,
      });
      // Store opposite token for hedging
      if (oppositeTokenId) {
        this.positionManager.setOppositeToken(
          position.id,
          oppositeTokenId,
          oppositeOutcomeLabel,
        );
      }
      console.log(
        `🎲 [SIM] ${side} $${sizeUsd.toFixed(2)} @ ${priceCents.toFixed(1)}¢${outcomeLabel ? ` on "${outcomeLabel}"` : ""}`,
      );
      return {
        success: true,
        filledUsd: sizeUsd,
        filledPriceCents: priceCents,
      };
    }

    if (!this.client) return { success: false, reason: "NO_CLIENT" };

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // FAIL-SAFE: Check if trading is safe BEFORE attempting any order
      // This protects user funds when network conditions are dangerous!
      // ═══════════════════════════════════════════════════════════════════════
      const latencyMonitor = getLatencyMonitor();
      const tradingSafety = latencyMonitor.isTradingSafe();

      if (!tradingSafety.safe) {
        console.error(
          `🚨 TRADING BLOCKED - Network unsafe: ${tradingSafety.reason}`,
        );
        console.error(
          `   Trade NOT executed to protect your funds. Waiting for network to stabilize...`,
        );
        reportError(
          "Trading Blocked - Network Unsafe",
          `Trade blocked due to unsafe network conditions: ${tradingSafety.reason}`,
          "warning",
          { tokenId, side, sizeUsd, reason: tradingSafety.reason },
        );
        return {
          success: false,
          reason: `NETWORK_UNSAFE: ${tradingSafety.reason}`,
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // LATENCY-AWARE SLIPPAGE - Critical for high-volume markets!
      // ═══════════════════════════════════════════════════════════════════════
      const networkHealth = latencyMonitor.getNetworkHealth();
      const dynamicSlippagePct = networkHealth.recommendedSlippagePct;

      // Warn if network is degraded - higher chance of missed fills or bad slippage
      if (networkHealth.status === "critical") {
        console.warn(
          `🔴 CRITICAL LATENCY: ${networkHealth.rpcLatencyMs.toFixed(0)}ms RPC, ${networkHealth.apiLatencyMs.toFixed(0)}ms API`,
        );
        console.warn(
          `   Using ${dynamicSlippagePct.toFixed(1)}% slippage buffer - HIGH RISK of slippage loss!`,
        );
        reportError(
          "Critical Network Latency",
          `Attempting trade with critical latency: RPC ${networkHealth.rpcLatencyMs.toFixed(0)}ms, API ${networkHealth.apiLatencyMs.toFixed(0)}ms`,
          "warning",
          {
            rpcLatencyMs: networkHealth.rpcLatencyMs,
            apiLatencyMs: networkHealth.apiLatencyMs,
            slippagePct: dynamicSlippagePct,
          },
        );
      } else if (networkHealth.status === "degraded") {
        console.warn(
          `🟡 High latency: ${networkHealth.rpcLatencyMs.toFixed(0)}ms RPC - using ${dynamicSlippagePct.toFixed(1)}% slippage`,
        );
      }

      const orderBook = await this.client.getOrderBook(tokenId);
      const levels = side === "LONG" ? orderBook?.asks : orderBook?.bids;
      if (!levels?.length) return { success: false, reason: "NO_LIQUIDITY" };

      const bestPrice = parseFloat(levels[0].price);

      // Apply latency-adjusted slippage buffer to price
      // For BUY: We're willing to pay MORE (price + slippage) to ensure fill
      // For SELL: We're willing to accept LESS (price - slippage) to ensure fill
      const slippageMultiplier = dynamicSlippagePct / 100;
      const fokPrice =
        side === "LONG"
          ? bestPrice * (1 + slippageMultiplier) // BUY: pay up to X% more
          : bestPrice * (1 - slippageMultiplier); // SELL: accept X% less

      // CRITICAL FIX (Clause 2.2): Entry sizing must use worst-case (slippage-adjusted)
      // limit price, not best price. This prevents overspending notional when slippage
      // occurs. The fokPrice represents the worst price we're willing to accept.
      const shares = sizeUsd / fokPrice; // Use worst-case price for share calculation

      const { Side, OrderType } = await import("@polymarket/clob-client");

      // ═══════════════════════════════════════════════════════════════════════
      // COMBO ORDER STRATEGY: Try FOK first, fall back to GTC if needed
      // FOK = instant fill or nothing (best for racing whale trades)
      // GTC = post limit order (backup if FOK misses)
      // ═══════════════════════════════════════════════════════════════════════

      // Measure actual order execution time
      const execStart = performance.now();

      // STEP 1: Try FOK (Fill-Or-Kill) first - instant execution
      const fokOrder = await this.client.createMarketOrder({
        side: side === "LONG" ? Side.BUY : Side.SELL,
        tokenID: tokenId,
        amount: shares,
        price: fokPrice, // Slippage-adjusted price
      });

      const fokResponse = await this.client.postOrder(fokOrder, OrderType.FOK);
      const execLatencyMs = performance.now() - execStart;

      // Log execution timing for analysis
      if (execLatencyMs > 500) {
        console.warn(
          `⏱️ Slow order execution: ${execLatencyMs.toFixed(0)}ms - consider the slippage impact`,
        );
      }

      if (fokResponse.success) {
        const position = this.positionManager.openPosition({
          tokenId,
          marketId,
          side,
          entryPriceCents: bestPrice * 100,
          sizeUsd,
          referencePriceCents,
          evSnapshot: evMetrics,
          biasDirection,
          // Outcome info for Telegram notifications
          outcomeLabel,
          outcomeIndex,
          marketQuestion,
        });
        if (oppositeTokenId) {
          this.positionManager.setOppositeToken(
            position.id,
            oppositeTokenId,
            oppositeOutcomeLabel,
          );
        }
        console.log(
          `📥 FOK ${side} $${sizeUsd.toFixed(2)} @ ${(bestPrice * 100).toFixed(1)}¢${outcomeLabel ? ` on "${outcomeLabel}"` : ""} (slippage: ${dynamicSlippagePct.toFixed(1)}%, exec: ${execLatencyMs.toFixed(0)}ms)`,
        );
        return {
          success: true,
          filledUsd: sizeUsd,
          filledPriceCents: bestPrice * 100,
        };
      }

      // STEP 2: FOK failed - try GTC (limit order) as fallback
      // Use a tighter price for GTC - we're willing to wait for a better fill
      console.log(`⏳ FOK missed, trying GTC limit order...`);

      const gtcPrice =
        side === "LONG"
          ? bestPrice * (1 + slippageMultiplier * 0.5) // Tighter slippage for GTC
          : bestPrice * (1 - slippageMultiplier * 0.5);

      try {
        const gtcOrder = await this.client.createOrder({
          side: side === "LONG" ? Side.BUY : Side.SELL,
          tokenID: tokenId,
          size: shares,
          price: gtcPrice,
        });

        const gtcResponse = await this.client.postOrder(
          gtcOrder,
          OrderType.GTC,
        );

        if (gtcResponse.success) {
          // GTC order posted - it will sit on the book until filled
          console.log(
            `📋 GTC order posted @ ${(gtcPrice * 100).toFixed(1)}¢ - waiting for fill...`,
          );

          // Note: For GTC, we don't immediately open a position
          // The position will be tracked when the order fills (via on-chain monitor)
          // For now, return success but note it's pending
          return {
            success: true,
            filledUsd: 0,
            filledPriceCents: gtcPrice * 100,
            pending: true,
          };
        }
      } catch (gtcErr) {
        console.warn(
          `⚠️ GTC fallback also failed: ${gtcErr instanceof Error ? gtcErr.message : gtcErr}`,
        );
      }

      // Both FOK and GTC failed
      reportError(
        "Order Rejected (FOK + GTC)",
        `Both FOK and GTC orders rejected for ${tokenId.slice(0, 16)}...`,
        "warning",
        {
          tokenId,
          side,
          sizeUsd,
          priceCents: bestPrice * 100,
          marketId,
          slippagePct: dynamicSlippagePct,
          execLatencyMs,
        },
      );
      return { success: false, reason: "ORDER_REJECTED" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "ERROR";
      // Report execution error to GitHub
      reportError("Entry Execution Failed", errorMsg, "error", {
        tokenId,
        side,
        sizeUsd,
        marketId,
      });
      return { success: false, reason: errorMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT (uses smart-sell for reliable fills)
  // ─────────────────────────────────────────────────────────────────────────

  async processExits(
    marketDataMap: Map<string, TokenMarketData>,
  ): Promise<{ exited: string[]; hedged: string[] }> {
    const exited: string[] = [];
    const hedged: string[] = [];

    // First pass: determine which positions need action (sync - fast)
    type PendingAction = {
      position: ManagedPosition;
      action: "EXIT" | "HEDGE";
      reason?: ExitReason;
      priceCents: number;
      biasDirection: BiasDirection;
      marketData: TokenMarketData; // Include for proactive opposite token monitoring
    };

    const pendingActions: PendingAction[] = [];

    for (const position of this.positionManager.getOpenPositions()) {
      const marketData = marketDataMap.get(position.tokenId);
      if (!marketData) continue;

      const priceCents = marketData.orderbook.midPriceCents;
      const bias = this.biasAccumulator.getBias(position.tokenId);
      const evMetrics = this.evTracker.getMetrics();

      // Update price and check triggers
      const update = this.positionManager.updatePrice(
        position.id,
        priceCents,
        evMetrics,
        bias.direction,
      );

      if (update.action === "EXIT") {
        pendingActions.push({
          position,
          action: "EXIT",
          reason: update.reason,
          priceCents,
          biasDirection: bias.direction,
          marketData,
        });
      } else if (update.action === "HEDGE") {
        pendingActions.push({
          position,
          action: "HEDGE",
          priceCents,
          biasDirection: bias.direction,
          marketData,
        });
      } else {
        // Check decision engine for other exit conditions
        const exitCheck = this.decisionEngine.evaluateExit({
          position,
          currentPriceCents: priceCents,
          bias: bias.direction,
          evAllowed: this.evTracker.isTradingAllowed(),
        });
        if (exitCheck.shouldExit) {
          pendingActions.push({
            position,
            action: "EXIT",
            reason: exitCheck.reason,
            priceCents,
            biasDirection: bias.direction,
            marketData,
          });
        }
      }
    }

    // Second pass: execute all actions in parallel
    if (pendingActions.length > 0) {
      const results = await Promise.all(
        pendingActions.map(async (action) => {
          try {
            if (action.action === "EXIT") {
              const result = await this.executeExit(
                action.position,
                action.reason!,
                action.priceCents,
                action.biasDirection,
              );
              return {
                id: action.position.id,
                action: "EXIT" as const,
                success: result.success,
              };
            } else {
              // Pass the proactively-monitored opposite orderbook to executeHedge
              const result = await this.executeHedge(
                action.position,
                action.biasDirection,
                action.marketData.oppositeOrderbook, // Use pre-fetched opposite data!
              );
              return {
                id: action.position.id,
                action: "HEDGE" as const,
                success: result.success,
              };
            }
          } catch (err) {
            console.warn(
              `⚠️ ${action.action} failed for ${action.position.id}: ${err instanceof Error ? err.message : err}`,
            );
            return {
              id: action.position.id,
              action: action.action,
              success: false,
            };
          }
        }),
      );

      // Collect results
      for (const result of results) {
        if (result.success) {
          if (result.action === "EXIT") exited.push(result.id);
          else hedged.push(result.id);
        }
      }

      // Force balance refresh if any trades succeeded
      if (exited.length > 0 || hedged.length > 0) {
        getBalanceCache()
          ?.forceRefresh()
          .catch(() => {});
      }
    }

    return { exited, hedged };
  }

  private async executeExit(
    position: ManagedPosition,
    reason: ExitReason,
    priceCents: number,
    biasDirection: BiasDirection,
  ): Promise<ExecutionResult> {
    const evMetrics = this.evTracker.getMetrics();
    this.positionManager.beginExit(
      position.id,
      reason,
      evMetrics,
      biasDirection,
    );

    // Simulation mode
    if (!this.config.liveTradingEnabled) {
      return this.closeAndLog(
        position,
        priceCents,
        reason,
        biasDirection,
        "[SIM]",
      );
    }

    if (!this.client) return { success: false, reason: "NO_CLIENT" };

    /*
     * SELL: Use smartSell which returns actual fill price.
     * Slippage tolerances from EV math (churn_cost = 2¢):
     * - TAKE_PROFIT: tight (protect gains)
     * - NORMAL: standard churn allowance
     * - URGENT: looser (losses capped at MAX_ADVERSE anyway)
     */

    const shares = position.entrySizeUsd / (position.entryPriceCents / 100);
    const pnlUsd = (position.unrealizedPnlCents / 100) * shares;
    // Use position's actual outcome label if available, otherwise fall back to side indicator
    // This ensures non-YES/NO markets show actual outcome (e.g., "Lakers") instead of "LONG"
    const outcomeLabel =
      position.outcomeLabel || (position.side === "LONG" ? "LONG" : "SHORT");
    const sellPosition: Position = {
      tokenId: position.tokenId,
      conditionId: position.tokenId,
      outcome: outcomeLabel, // Use actual outcome label when available
      size: shares,
      avgPrice: position.entryPriceCents / 100,
      curPrice: priceCents / 100,
      value: position.entrySizeUsd,
      gainCents: position.unrealizedPnlCents,
      pnlPct: (position.unrealizedPnlCents / position.entryPriceCents) * 100,
      pnlUsd,
      entryTime: position.entryTime,
      lastPrice: priceCents / 100,
    };

    // Slippage based on exit type (derived from churn_cost = 2¢)
    const isUrgent = reason === "HARD_EXIT" || reason === "STOP_LOSS";
    const slippagePct = reason === "TAKE_PROFIT" ? 4 : isUrgent ? 15 : 8;

    console.log(`📤 Selling | ${reason} | ${slippagePct}% max slippage`);

    const result = await smartSell(this.client, sellPosition, {
      maxSlippagePct: slippagePct,
      forceSell: isUrgent,
      logger: this.logger,
    });

    if (result.success) {
      // Use actual fill price from API response
      const exitPrice = (result.avgPrice || priceCents / 100) * 100;

      // CRITICAL (Clause 5.1/5.2): Unwind hedge legs after primary exit succeeds.
      // Hedges are real positions that become residual exposure if not unwound.
      // If any hedge sell fails, we force a position refresh to track the residual.
      const hedgeUnwindResult = await this.unwindHedges(position);
      if (!hedgeUnwindResult.success && hedgeUnwindResult.failedCount > 0) {
        console.warn(
          `⚠️ [HEDGE UNWIND] ${hedgeUnwindResult.failedCount} hedge(s) failed to sell - residual exposure remains`,
        );
        // Force position refresh to track any remaining hedge positions
        invalidatePositions();
      }

      return this.closeAndLog(position, exitPrice, reason, biasDirection, "");
    }

    // Retry with more slippage if urgent
    if (isUrgent && result.reason === "FOK_NOT_FILLED") {
      console.log(`⚠️ Retrying with 25% slippage...`);
      const retry = await smartSell(this.client, sellPosition, {
        maxSlippagePct: 25,
        forceSell: true,
        logger: this.logger,
      });
      if (retry.success) {
        const exitPrice = (retry.avgPrice || priceCents / 100) * 100;

        // CRITICAL (Clause 5.1/5.2): Unwind hedge legs after primary exit succeeds.
        const hedgeUnwindResult = await this.unwindHedges(position);
        if (!hedgeUnwindResult.success && hedgeUnwindResult.failedCount > 0) {
          console.warn(
            `⚠️ [HEDGE UNWIND] ${hedgeUnwindResult.failedCount} hedge(s) failed to sell - residual exposure remains`,
          );
          invalidatePositions();
        }

        return this.closeAndLog(
          position,
          exitPrice,
          reason,
          biasDirection,
          "(retry)",
        );
      }
    }

    console.log(`❌ Sell failed: ${result.reason}`);
    return { success: false, reason: result.reason };
  }

  private closeAndLog(
    position: ManagedPosition,
    exitPriceCents: number,
    reason: ExitReason,
    biasDirection: BiasDirection,
    tag: string,
  ): ExecutionResult {
    const evMetrics = this.evTracker.getMetrics();
    const closed = this.positionManager.closePosition(
      position.id,
      exitPriceCents,
      evMetrics,
      biasDirection,
    );

    if (closed) {
      this.evTracker.recordTrade(
        createTradeResult(
          position.tokenId,
          position.side,
          position.entryPriceCents,
          exitPriceCents,
          position.entrySizeUsd,
        ),
      );

      const emoji = closed.unrealizedPnlCents >= 0 ? "✅" : "❌";
      const sign = closed.unrealizedPnlCents >= 0 ? "+" : "";
      console.log(
        `${emoji} ${tag} ${reason} | ${sign}${closed.unrealizedPnlCents.toFixed(1)}¢ ($${closed.unrealizedPnlUsd.toFixed(2)})`,
      );
    }

    return { success: true, filledPriceCents: exitPriceCents };
  }

  /**
   * Unwind (sell) all hedge legs for a position after primary exit.
   *
   * CRITICAL (Clause 5.1/5.2): Hedges are real positions that become residual
   * exposure if not unwound. This method attempts to sell all hedge legs
   * using FOK-only orders to avoid phantom fills.
   *
   * @param position - The position whose hedges should be unwound
   * @returns Result with success status and count of failed unwinds
   */
  private async unwindHedges(
    position: ManagedPosition,
  ): Promise<{ success: boolean; failedCount: number }> {
    const hedges = position.hedges || [];

    if (hedges.length === 0) {
      return { success: true, failedCount: 0 };
    }

    console.log(
      `🔄 [HEDGE UNWIND] Unwinding ${hedges.length} hedge leg(s) for position ${position.id.slice(0, 16)}...`,
    );

    // Simulation mode - just log
    if (!this.config.liveTradingEnabled) {
      for (const hedge of hedges) {
        console.log(
          `🛡️ [SIM] [HEDGE UNWIND] Would sell hedge: ${hedge.tokenId.slice(0, 16)}... ($${hedge.sizeUsd.toFixed(2)})`,
        );
      }
      return { success: true, failedCount: 0 };
    }

    if (!this.client) {
      console.error(`❌ [HEDGE UNWIND] No CLOB client available`);
      return { success: false, failedCount: hedges.length };
    }

    let failedCount = 0;

    for (const hedge of hedges) {
      try {
        // Get current orderbook for the hedge token
        const orderBook = await this.client.getOrderBook(hedge.tokenId);
        const bids = orderBook?.bids;

        if (!bids || bids.length === 0) {
          console.warn(
            `⚠️ [HEDGE UNWIND] No bids for hedge token ${hedge.tokenId.slice(0, 16)}... - cannot sell`,
          );
          failedCount++;
          continue;
        }

        const bestBid = parseFloat(bids[0].price);
        // NOTE: We estimate shares using the hedge entry price. If the hedge filled at a different
        // price due to slippage, this may be slightly inaccurate. For improved accuracy, consider
        // tracking actual filled shares when hedges are created. This conservative approach errs
        // on the side of attempting to sell the estimated amount, which FOK will reject if too large.
        const shares = hedge.sizeUsd / (hedge.entryPriceCents / 100);

        // Create sell order with FOK to ensure confirmed fill
        const { Side, OrderType } = await import("@polymarket/clob-client");

        const order = await this.client.createMarketOrder({
          side: Side.SELL,
          tokenID: hedge.tokenId,
          amount: shares,
          price: bestBid,
        });

        // Use FOK-only to avoid phantom fills (Clause 2.3)
        const response = await this.client.postOrder(order, OrderType.FOK);

        if (response.success) {
          // Verify FOK fill (same check as smartSell)
          const respAny = response as any;
          const rawStatus = respAny?.status;
          const status =
            typeof rawStatus === "string" ? rawStatus.toUpperCase() : "";
          const takingAmount = parseFloat(respAny?.takingAmount || "0");
          const makingAmount = parseFloat(respAny?.makingAmount || "0");

          const isMatched = status === "MATCHED" || status === "FILLED";
          const hasFilledAmount = takingAmount > 0 || makingAmount > 0;
          const hasStatusInfo =
            typeof rawStatus === "string" && rawStatus.length > 0;
          const hasAmountInfo =
            respAny?.takingAmount !== undefined ||
            respAny?.makingAmount !== undefined;

          // Check for confirmed fill (align with smartSell: missing evidence ⇒ treat as NOT filled)
          if (
            (hasStatusInfo && isMatched) ||
            (hasAmountInfo && hasFilledAmount)
          ) {
            console.log(
              `✅ [HEDGE UNWIND] Sold hedge: ${hedge.tokenId.slice(0, 16)}... @ ${(bestBid * 100).toFixed(1)}¢`,
            );
          } else {
            console.warn(
              `⚠️ [HEDGE UNWIND] FOK not filled for hedge ${hedge.tokenId.slice(0, 16)}...`,
            );
            failedCount++;
          }
        } else {
          console.warn(
            `⚠️ [HEDGE UNWIND] Order rejected for hedge ${hedge.tokenId.slice(0, 16)}...`,
          );
          failedCount++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `❌ [HEDGE UNWIND] Error unwinding hedge ${hedge.tokenId.slice(0, 16)}...: ${errorMsg}`,
        );
        failedCount++;
      }
    }

    const success = failedCount === 0;
    if (success) {
      console.log(
        `✅ [HEDGE UNWIND] All ${hedges.length} hedge(s) unwound successfully`,
      );
    } else {
      console.warn(
        `⚠️ [HEDGE UNWIND] ${failedCount}/${hedges.length} hedge(s) failed to unwind`,
      );
    }

    return { success, failedCount };
  }

  /**
   * Execute a hedge by buying the opposite token
   *
   * @param position - The position to hedge
   * @param biasDirection - Current bias direction
   * @param prefetchedOppositeOrderbook - Optional pre-fetched opposite orderbook (for proactive monitoring)
   */
  private async executeHedge(
    position: ManagedPosition,
    biasDirection: BiasDirection,
    prefetchedOppositeOrderbook?: OrderbookState,
  ): Promise<ExecutionResult> {
    const hedgeSize = this.decisionEngine.calculateHedgeSize(position);
    const evMetrics = this.evTracker.getMetrics();

    // Get the opposite token ID for hedging
    const oppositeTokenId = position.oppositeTokenId;

    if (!oppositeTokenId) {
      console.warn(
        `⚠️ [HEDGE] No opposite token available for position ${position.id.slice(0, 16)}... - cannot hedge`,
      );
      return { success: false, reason: "NO_OPPOSITE_TOKEN" };
    }

    // Simulation mode - just record the hedge
    if (!this.config.liveTradingEnabled) {
      // Use pre-fetched price if available, otherwise use position's current price as estimate
      const hedgePrice = prefetchedOppositeOrderbook?.bestAskCents
        ? prefetchedOppositeOrderbook.bestAskCents
        : position.currentPriceCents;

      this.positionManager.recordHedge(
        position.id,
        {
          tokenId: oppositeTokenId, // Use REAL opposite token ID!
          sizeUsd: hedgeSize,
          entryPriceCents: hedgePrice,
          entryTime: Date.now(),
        },
        evMetrics,
        biasDirection,
      );

      const proactiveTag = prefetchedOppositeOrderbook ? " [PROACTIVE]" : "";
      console.log(
        `🛡️ [SIM]${proactiveTag} Hedged $${hedgeSize.toFixed(2)} by buying opposite @ ${hedgePrice.toFixed(1)}¢`,
      );
      return { success: true, filledUsd: hedgeSize };
    }

    // Live trading mode - actually place the hedge order!
    if (!this.client) {
      console.error(`❌ [HEDGE] No CLOB client available`);
      return { success: false, reason: "NO_CLIENT" };
    }

    try {
      let price: number;

      // Use pre-fetched orderbook if available (proactive monitoring)
      // Validate: price > 0 AND there's liquidity (askDepthUsd > 0)
      const MIN_LIQUIDITY_USD = 5; // Minimum liquidity to trust pre-fetched data
      const hasPrefetchedData =
        prefetchedOppositeOrderbook &&
        prefetchedOppositeOrderbook.bestAskCents > 0 &&
        prefetchedOppositeOrderbook.askDepthUsd >= MIN_LIQUIDITY_USD;

      if (hasPrefetchedData) {
        price = prefetchedOppositeOrderbook!.bestAskCents / 100; // Convert cents to dollars
        console.log(
          `🔄 [HEDGE] Using proactively monitored opposite price: ${(price * 100).toFixed(1)}¢ (depth: $${prefetchedOppositeOrderbook!.askDepthUsd.toFixed(0)})`,
        );
      } else {
        // Fallback: fetch fresh orderbook (no pre-fetched data or insufficient liquidity)
        const reason = prefetchedOppositeOrderbook
          ? `insufficient liquidity ($${prefetchedOppositeOrderbook.askDepthUsd?.toFixed(0) || 0})`
          : "no pre-fetched data";
        console.log(`📡 [HEDGE] Fetching fresh opposite orderbook (${reason})`);
        const orderBook = await this.client.getOrderBook(oppositeTokenId);
        const asks = orderBook?.asks;

        if (!asks?.length) {
          console.warn(
            `⚠️ [HEDGE] No asks available for opposite token - cannot hedge`,
          );
          return { success: false, reason: "NO_LIQUIDITY" };
        }

        price = parseFloat(asks[0].price);
      }

      // Validate price is above minimum tradeable
      const MIN_TRADEABLE_PRICE = 0.001;
      if (!price || price <= MIN_TRADEABLE_PRICE) {
        console.warn(`⚠️ [HEDGE] Price ${price} is too low for hedge order`);
        return { success: false, reason: "PRICE_TOO_LOW" };
      }

      const shares = hedgeSize / price;

      // Validate shares is above minimum threshold
      const MIN_SHARES = 0.0001;
      if (shares < MIN_SHARES) {
        console.warn(
          `⚠️ [HEDGE] Calculated shares ${shares} is below minimum ${MIN_SHARES}`,
        );
        return { success: false, reason: "SIZE_TOO_SMALL" };
      }

      console.log(
        `🛡️ [HEDGE] Placing hedge order: BUY ${shares.toFixed(4)} shares @ ${(price * 100).toFixed(1)}¢`,
      );

      // Import SDK types
      const { Side, OrderType } = await import("@polymarket/clob-client");

      // Create and post hedge order
      const order = await this.client.createMarketOrder({
        side: Side.BUY, // Always BUY the opposite token to hedge
        tokenID: oppositeTokenId,
        amount: shares,
        price,
      });

      const response = await this.client.postOrder(order, OrderType.FOK);

      if (response.success) {
        // Record the successful hedge with real token ID and fill price
        const fillPriceCents = price * 100;

        this.positionManager.recordHedge(
          position.id,
          {
            tokenId: oppositeTokenId,
            sizeUsd: hedgeSize,
            entryPriceCents: fillPriceCents,
            entryTime: Date.now(),
          },
          evMetrics,
          biasDirection,
        );

        console.log(
          `✅ [HEDGE] Successfully hedged $${hedgeSize.toFixed(2)} @ ${fillPriceCents.toFixed(1)}¢`,
        );
        return {
          success: true,
          filledUsd: hedgeSize,
          filledPriceCents: fillPriceCents,
        };
      } else {
        console.warn(
          `⚠️ [HEDGE] Hedge order rejected: ${response.errorMsg || "unknown reason"}`,
        );
        return { success: false, reason: "ORDER_REJECTED" };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`❌ [HEDGE] Hedge order failed: ${errorMsg}`);
      return { success: false, reason: errorMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────────────────────────────────────

  getSummary() {
    const ev = this.evTracker.getMetrics();
    return {
      positions: this.positionManager.getOpenPositions().length,
      deployed: this.positionManager.getTotalDeployedUsd(),
      trades: ev.totalTrades,
      winRate: ev.winRate,
      evCents: ev.evCents,
      pnl: ev.totalPnlUsd,
    };
  }
}
