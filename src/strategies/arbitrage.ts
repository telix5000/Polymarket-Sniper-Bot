/**
 * Arbitrage Strategy (Work In Progress)
 *
 * Arbitrage strategy module that can scan markets for price inefficiencies
 * (yes + no < $1) and execute profitable arbitrage trades.
 *
 * NOTE: This module is NOT YET integrated into the Orchestrator.
 * Currently, arbitrage runs as a separate engine via startArbitrageEngine().
 * This module provides the foundation for future unified orchestrator integration.
 *
 * EXECUTION MODEL (when integrated):
 * - Will be called by orchestrator every ~2 seconds
 * - Scans active markets for arbitrage opportunities
 * - Executes profitable trades (both legs of the arbitrage)
 * - Returns count of trades executed
 *
 * CONFIG-DRIVEN:
 * - ARB_ENABLED=true/false controls whether arbitrage runs
 * - All other ARB_* config values are respected
 */

import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import type { ConsoleLogger } from "../utils/logger.util";
import type { ArbConfig } from "../arbitrage/config";
import { PolymarketMarketDataProvider } from "../arbitrage/provider/polymarket.provider";
import { IntraMarketArbStrategy } from "../arbitrage/strategy/intra-market.strategy";
import { InMemoryStateStore } from "../arbitrage/state/state-store";
import { ArbRiskManager } from "../arbitrage/risk/risk-manager";
import { ArbTradeExecutor } from "../arbitrage/executor/trade-executor";
import { Semaphore } from "../arbitrage/utils/limiter";
import { OrderbookNotFoundError } from "../errors/app.errors";
import {
  getAdaptiveLearner,
  type AdaptiveTradeLearner,
} from "../arbitrage/learning/adaptive-learner";
import type { Opportunity, TradePlan } from "../arbitrage/types";

/**
 * Arbitrage Strategy Configuration
 */
export interface ArbitrageStrategyConfig {
  /** Enable the strategy */
  enabled: boolean;
  /** Full ArbConfig for underlying components */
  arbConfig: ArbConfig;
}

export const DEFAULT_ARBITRAGE_STRATEGY_CONFIG: Partial<ArbitrageStrategyConfig> =
  {
    enabled: false, // Disabled by default - user must explicitly enable
  };

/**
 * Arbitrage Strategy - Integrated into Orchestrator
 *
 * This strategy wraps the existing arbitrage components to provide
 * a single-scan execution model compatible with the orchestrator pattern.
 */
export class ArbitrageStrategy {
  private readonly client: ClobClient & { wallet: Wallet };
  private readonly logger: ConsoleLogger;
  private readonly config: ArbitrageStrategyConfig;

  // Arbitrage components (initialized lazily)
  private provider?: PolymarketMarketDataProvider;
  private strategy?: IntraMarketArbStrategy;
  private riskManager?: ArbRiskManager;
  private executor?: ArbTradeExecutor;
  private stateStore?: InMemoryStateStore;
  private orderbookLimiter?: Semaphore;
  private learner?: AdaptiveTradeLearner;

  private initialized = false;
  private activeTrades = 0;

  // === SINGLE-FLIGHT GUARD ===
  private inFlight = false;

  constructor(config: {
    client: ClobClient & { wallet: Wallet };
    logger: ConsoleLogger;
    config: ArbitrageStrategyConfig;
  }) {
    this.client = config.client;
    this.logger = config.logger;
    this.config = config.config;

    if (this.config.enabled) {
      this.logger.info(
        `[Arbitrage] Strategy initialized: minEdge=${this.config.arbConfig.minEdgeBps}bps, ` +
          `minProfit=$${this.config.arbConfig.minProfitUsd}, maxPosition=$${this.config.arbConfig.maxPositionUsd}`,
      );
    }
  }

  /**
   * Initialize arbitrage components (lazy initialization)
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const arbConfig = this.config.arbConfig;

    // Initialize state store
    this.stateStore = new InMemoryStateStore(
      arbConfig.stateDir,
      arbConfig.snapshotState,
    );
    await this.stateStore.load();

    // Initialize provider
    this.provider = new PolymarketMarketDataProvider({
      client: this.client,
      logger: this.logger,
    });

    // Initialize strategy
    this.strategy = new IntraMarketArbStrategy({
      config: arbConfig,
      getExposure: (marketId) => ({
        market: this.stateStore!.getMarketExposure(marketId),
        wallet: this.stateStore!.getWalletExposure(),
      }),
    });

    // Initialize risk manager
    this.riskManager = new ArbRiskManager({
      config: arbConfig,
      state: this.stateStore,
      logger: this.logger,
      wallet: this.client.wallet,
    });

    // Initialize executor
    this.executor = new ArbTradeExecutor({
      client: this.client,
      provider: this.provider,
      config: arbConfig,
      logger: this.logger,
    });

    // Initialize limiter and learner
    this.orderbookLimiter = new Semaphore(6);
    this.learner = getAdaptiveLearner(this.logger);

    this.initialized = true;
    this.logger.info("[Arbitrage] 🚀 Strategy components initialized");
  }

  /**
   * Execute the arbitrage strategy
   *
   * Called once per orchestrator cycle. Scans markets and executes
   * any profitable arbitrage opportunities found.
   *
   * @returns Number of trades executed
   */
  async execute(): Promise<number> {
    if (!this.config.enabled) {
      return 0;
    }

    // Single-flight guard
    if (this.inFlight) {
      this.logger.debug("[Arbitrage] Skipped - already in flight");
      return 0;
    }

    this.inFlight = true;
    try {
      // Lazy initialization
      if (!this.initialized) {
        await this.initialize();
      }

      return await this.scanOnce();
    } catch (err) {
      this.logger.error(
        `[Arbitrage] Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Scan markets once and execute opportunities
   */
  private async scanOnce(): Promise<number> {
    const now = Date.now();
    const arbConfig = this.config.arbConfig;

    // Check detect-only mode
    if (arbConfig.detectOnly) {
      this.logger.debug("[Arbitrage] Detect-only mode - scanning without executing");
    }

    try {
      const markets = await this.provider!.getActiveMarkets();
      let orderbookFailures = 0;
      let marketsWithOrderbookFailures = 0;

      const snapshots = await Promise.all(
        markets.map((market) =>
          this.orderbookLimiter!.with(async () => {
            const yesResult = await this.getOrderBookTopSafe(
              market.yesTokenId,
              market.marketId,
            );
            const noResult = await this.getOrderBookTopSafe(
              market.noTokenId,
              market.marketId,
            );
            const hasFailure = yesResult.failed || noResult.failed;
            if (hasFailure) {
              marketsWithOrderbookFailures += 1;
            }
            orderbookFailures +=
              (yesResult.failed ? 1 : 0) + (noResult.failed ? 1 : 0);
            return { ...market, yesTop: yesResult.top, noTop: noResult.top };
          }),
        ),
      );

      const opportunities = this.strategy!.findOpportunities(snapshots, now);
      opportunities.sort((a, b) => b.estProfitUsd - a.estProfitUsd);

      if (opportunities.length === 0) {
        this.logger.debug(
          `[Arbitrage] 🔍 Scan: 0 opportunities (markets=${markets.length}, failures=${orderbookFailures})`,
        );
        return 0;
      }

      const top = opportunities[0];
      this.logger.info(
        `[Arbitrage] 🎯 Found ${opportunities.length} opportunity(ies). ` +
          `Top: edge=${top.edgeBps.toFixed(1)}bps est=$${top.estProfitUsd.toFixed(2)}`,
      );

      // Execute opportunities
      let tradesExecuted = 0;
      for (const opportunity of opportunities) {
        if (this.activeTrades >= arbConfig.maxConcurrentTrades) break;

        const executed = await this.handleOpportunity(opportunity, now);
        if (executed) {
          tradesExecuted++;
        }
      }

      return tradesExecuted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[Arbitrage] ⚠️ Scan error: ${message}`);
      return 0;
    }
  }

  /**
   * Get orderbook top safely, handling errors
   */
  private async getOrderBookTopSafe(
    tokenId: string,
    marketId: string,
  ): Promise<{ top: { bestAsk: number; bestBid: number }; failed: boolean }> {
    try {
      const top = await this.provider!.getOrderBookTop(tokenId);
      return { top, failed: false };
    } catch (error) {
      if (error instanceof OrderbookNotFoundError) {
        this.logger.warn(
          `[Arbitrage] ⚠️ Invalid orderbook token ${tokenId} for market ${marketId}`,
        );
        return { top: { bestAsk: 0, bestBid: 0 }, failed: true };
      }
      throw error;
    }
  }

  /**
   * Handle a single arbitrage opportunity
   */
  private async handleOpportunity(
    opportunity: Opportunity,
    now: number,
  ): Promise<boolean> {
    const arbConfig = this.config.arbConfig;

    // Check with adaptive learner
    const spreadBps = opportunity.spreadBps ?? 100;
    const learnerEval = this.learner!.evaluateTrade({
      marketId: opportunity.marketId,
      edgeBps: opportunity.edgeBps,
      spreadBps,
      sizeUsd: opportunity.sizeUsd,
      liquidityUsd: opportunity.liquidityUsd,
    });

    if (!learnerEval.shouldTrade) {
      this.logger.debug(
        `[Arbitrage] ⛔ Skip (learner) market=${opportunity.marketId.slice(0, 12)}... ` +
          `confidence=${learnerEval.confidence}%`,
      );
      return false;
    }

    // Check risk manager
    const riskCheck = this.riskManager!.canExecute(opportunity, now);
    if (!riskCheck.allowed) {
      this.logger.debug(
        `[Arbitrage] ⛔ Skip (risk: ${riskCheck.reason}) market=${opportunity.marketId.slice(0, 12)}...`,
      );
      return false;
    }

    // Build trade plan
    const plan: TradePlan = {
      marketId: opportunity.marketId,
      yesTokenId: opportunity.yesTokenId,
      noTokenId: opportunity.noTokenId,
      yesAsk: opportunity.yesAsk,
      noAsk: opportunity.noAsk,
      sizeUsd: opportunity.sizeUsd,
      edgeBps: opportunity.edgeBps,
      estProfitUsd: opportunity.estProfitUsd,
    };

    // Execute
    if (arbConfig.detectOnly || arbConfig.dryRun) {
      this.logger.info(
        `[Arbitrage] 📋 Dry run: market=${opportunity.marketId.slice(0, 12)}... ` +
          `size=$${opportunity.sizeUsd.toFixed(2)} edge=${opportunity.edgeBps.toFixed(1)}bps`,
      );
      return false;
    }

    this.activeTrades++;
    try {
      const result = await this.executor!.execute(plan, now);

      if (result.status === "submitted") {
        this.logger.info(
          `[Arbitrage] ✅ Executed: market=${opportunity.marketId.slice(0, 12)}... ` +
            `size=$${opportunity.sizeUsd.toFixed(2)} edge=${opportunity.edgeBps.toFixed(1)}bps`,
        );

        // Record with risk manager (handles both sync and async implementations)
        const riskResult = this.riskManager!.onTradeSuccess(opportunity, now);
        if (riskResult instanceof Promise) {
          await riskResult;
        }

        // Record trade for adaptive learning
        this.learner!.recordTrade({
          marketId: opportunity.marketId,
          timestamp: now,
          entryPrice: opportunity.yesAsk, // Use yes ask as entry
          sizeUsd: opportunity.sizeUsd,
          edgeBps: opportunity.edgeBps,
          spreadBps: opportunity.spreadBps ?? 100,
          liquidityUsd: opportunity.liquidityUsd,
          outcome: "pending", // Will be updated when trade resolves
        });

        return true;
      }

      this.logger.warn(
        `[Arbitrage] ⚠️ Trade failed: ${result.reason ?? "unknown"}`,
      );
      return false;
    } finally {
      this.activeTrades--;
    }
  }

  /**
   * Get strategy stats
   */
  getStats(): { enabled: boolean; initialized: boolean; activeTrades: number } {
    return {
      enabled: this.config.enabled,
      initialized: this.initialized,
      activeTrades: this.activeTrades,
    };
  }
}
