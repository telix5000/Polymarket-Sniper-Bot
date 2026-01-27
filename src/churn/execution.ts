/**
 * Churn Engine - Execution
 * Simple order execution with smart-sell for reliable exits.
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { ChurnConfig } from "./config";
import type { EvTracker } from "./ev-metrics";
import type { BiasAccumulator, BiasDirection } from "./bias";
import type { PositionManager, ManagedPosition, ExitReason } from "./state-machine";
import type { DecisionEngine, OrderbookState, MarketActivity } from "./decision-engine";
import { createTradeResult } from "./ev-metrics";
import { smartSell } from "../lib/smart-sell";
import type { Position } from "../lib/types";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ExecutionResult {
  success: boolean;
  filledUsd?: number;
  filledPriceCents?: number;
  reason?: string;
}

export interface TokenMarketData {
  tokenId: string;
  marketId?: string;
  orderbook: OrderbookState;
  activity: MarketActivity;
  referencePriceCents: number;
}

export interface ChurnLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// SIMPLE LOGGER
// ═══════════════════════════════════════════════════════════════════════════

export class SimpleLogger implements ChurnLogger {
  info(msg: string): void { console.log(msg); }
  warn(msg: string): void { console.log(`⚠️ ${msg}`); }
  error(msg: string): void { console.log(`❌ ${msg}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export class ExecutionEngine {
  private config: ChurnConfig;
  private evTracker: EvTracker;
  private biasAccumulator: BiasAccumulator;
  private positionManager: PositionManager;
  private decisionEngine: DecisionEngine;
  private logger: ChurnLogger;
  private client: ClobClient | null = null;
  private cooldowns: Map<string, number> = new Map();

  constructor(
    config: ChurnConfig,
    evTracker: EvTracker,
    biasAccumulator: BiasAccumulator,
    positionManager: PositionManager,
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

  getEffectiveBankroll(balance: number): { effectiveBankroll: number; reserveUsd: number } {
    const reserveUsd = Math.max(balance * this.config.reserveFraction, this.config.minReserveUsd);
    return { effectiveBankroll: Math.max(0, balance - reserveUsd), reserveUsd };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENTRY
  // ─────────────────────────────────────────────────────────────────────────

  async processEntry(tokenId: string, marketData: TokenMarketData, balance: number): Promise<ExecutionResult> {
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

    // Evaluate entry
    const decision = this.decisionEngine.evaluateEntry({
      tokenId,
      bias: bias.direction,
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
      bias.direction,
    );

    if (result.success) {
      this.cooldowns.set(tokenId, Date.now() + this.config.cooldownSecondsPerToken * 1000);
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

    // Simulation mode
    if (!this.config.liveTradingEnabled) {
      this.positionManager.openPosition({
        tokenId, marketId, side,
        entryPriceCents: priceCents,
        sizeUsd,
        referencePriceCents,
        evSnapshot: evMetrics,
        biasDirection,
      });
      console.log(`🎲 [SIM] ${side} $${sizeUsd.toFixed(2)} @ ${priceCents.toFixed(1)}¢`);
      return { success: true, filledUsd: sizeUsd, filledPriceCents: priceCents };
    }

    if (!this.client) return { success: false, reason: "NO_CLIENT" };

    try {
      const orderBook = await this.client.getOrderBook(tokenId);
      const levels = side === "LONG" ? orderBook?.asks : orderBook?.bids;
      if (!levels?.length) return { success: false, reason: "NO_LIQUIDITY" };

      const price = parseFloat(levels[0].price);
      const shares = sizeUsd / price;

      const { Side, OrderType } = await import("@polymarket/clob-client");
      const order = await this.client.createMarketOrder({
        side: side === "LONG" ? Side.BUY : Side.SELL,
        tokenID: tokenId,
        amount: shares,
        price,
      });

      const response = await this.client.postOrder(order, OrderType.FOK);

      if (response.success) {
        this.positionManager.openPosition({
          tokenId, marketId, side,
          entryPriceCents: price * 100,
          sizeUsd,
          referencePriceCents,
          evSnapshot: evMetrics,
          biasDirection,
        });
        console.log(`📥 ${side} $${sizeUsd.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
        return { success: true, filledUsd: sizeUsd, filledPriceCents: price * 100 };
      }

      return { success: false, reason: "ORDER_REJECTED" };
    } catch (err) {
      return { success: false, reason: err instanceof Error ? err.message : "ERROR" };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT (uses smart-sell for reliable fills)
  // ─────────────────────────────────────────────────────────────────────────

  async processExits(marketDataMap: Map<string, TokenMarketData>): Promise<{ exited: string[]; hedged: string[] }> {
    const exited: string[] = [];
    const hedged: string[] = [];

    for (const position of this.positionManager.getOpenPositions()) {
      const marketData = marketDataMap.get(position.tokenId);
      if (!marketData) continue;

      const priceCents = marketData.orderbook.midPriceCents;
      const bias = this.biasAccumulator.getBias(position.tokenId);
      const evMetrics = this.evTracker.getMetrics();

      // Update price and check triggers
      const update = this.positionManager.updatePrice(position.id, priceCents, evMetrics, bias.direction);

      if (update.action === "EXIT") {
        const result = await this.executeExit(position, update.reason!, priceCents, bias.direction);
        if (result.success) exited.push(position.id);
      } else if (update.action === "HEDGE") {
        const result = await this.executeHedge(position, bias.direction);
        if (result.success) hedged.push(position.id);
      } else {
        // Check decision engine for other exit conditions
        const exitCheck = this.decisionEngine.evaluateExit({
          position,
          currentPriceCents: priceCents,
          bias: bias.direction,
          evAllowed: this.evTracker.isTradingAllowed(),
        });
        if (exitCheck.shouldExit) {
          const result = await this.executeExit(position, exitCheck.reason!, priceCents, bias.direction);
          if (result.success) exited.push(position.id);
        }
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
    this.positionManager.beginExit(position.id, reason, evMetrics, biasDirection);

    // Simulation mode
    if (!this.config.liveTradingEnabled) {
      return this.closeAndLog(position, priceCents, reason, biasDirection, "[SIM]");
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
    const sellPosition: Position = {
      tokenId: position.tokenId,
      conditionId: position.tokenId,
      outcome: position.side === "LONG" ? "YES" : "NO",
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
    const slippagePct = reason === "TAKE_PROFIT" ? 4 : (isUrgent ? 15 : 8);

    console.log(`📤 Selling | ${reason} | ${slippagePct}% max slippage`);

    const result = await smartSell(this.client, sellPosition, {
      maxSlippagePct: slippagePct,
      forceSell: isUrgent,
      logger: this.logger,
    });

    if (result.success) {
      // Use actual fill price from API response
      const exitPrice = (result.avgPrice || priceCents / 100) * 100;
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
        return this.closeAndLog(position, exitPrice, reason, biasDirection, "(retry)");
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
    const closed = this.positionManager.closePosition(position.id, exitPriceCents, evMetrics, biasDirection);

    if (closed) {
      this.evTracker.recordTrade(createTradeResult(
        position.tokenId,
        position.side,
        position.entryPriceCents,
        exitPriceCents,
        position.entrySizeUsd,
      ));

      const emoji = closed.unrealizedPnlCents >= 0 ? "✅" : "❌";
      const sign = closed.unrealizedPnlCents >= 0 ? "+" : "";
      console.log(`${emoji} ${tag} ${reason} | ${sign}${closed.unrealizedPnlCents.toFixed(1)}¢ ($${closed.unrealizedPnlUsd.toFixed(2)})`);
    }

    return { success: true, filledPriceCents: exitPriceCents };
  }

  private async executeHedge(position: ManagedPosition, biasDirection: BiasDirection): Promise<ExecutionResult> {
    const hedgeSize = this.decisionEngine.calculateHedgeSize(position);
    const evMetrics = this.evTracker.getMetrics();

    this.positionManager.recordHedge(position.id, {
      tokenId: position.tokenId + "_HEDGE",
      sizeUsd: hedgeSize,
      entryPriceCents: position.currentPriceCents,
      entryTime: Date.now(),
    }, evMetrics, biasDirection);

    const tag = this.config.liveTradingEnabled ? "" : "[SIM]";
    console.log(`🛡️ ${tag} Hedged $${hedgeSize.toFixed(2)}`);
    return { success: true, filledUsd: hedgeSize };
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
