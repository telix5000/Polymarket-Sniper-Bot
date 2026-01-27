/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET CASINO BOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A deterministic, math-driven trading system that:
 * - Trades frequently with positive Expected Value (EV)
 * - Caps losses strictly
 * - Runs 24/7 with bias-based (leaderboard flow) permission
 * - Pauses itself when edge disappears
 *
 * REQUIRED ENV:
 *   PRIVATE_KEY - Wallet private key
 *   RPC_URL     - Polygon RPC endpoint
 *
 * KEPT FEATURES:
 *   - VPN support (WireGuard/OpenVPN)
 *   - Telegram notifications
 *   - Auto-redeem settled positions
 *   - Auto-fill POL for gas
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import "dotenv/config";

// Churn Engine
import {
  loadConfig,
  validateConfig,
  logConfig,
  EvTracker,
  BiasAccumulator,
  PositionManager,
  DecisionEngine,
  ExecutionEngine,
  SimpleLogger,
  type ChurnConfig,
  type TokenMarketData,
  type OrderbookState,
  type MarketActivity,
} from "./churn";

// Keep essential lib modules
import {
  createClobClient,
  getUsdcBalance,
  getPolBalance,
  initTelegram,
  sendTelegram,
  redeemAllPositions,
  fetchRedeemablePositions,
  capturePreVpnRouting,
  startWireguard,
  startOpenvpn,
  setupRpcBypass,
  setupPolymarketReadBypass,
  // POL Reserve (auto gas fill)
  runPolReserve,
  shouldRebalance,
  type PolReserveConfig,
} from "./lib";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const POLYMARKET_API = {
  CLOB: "https://clob.polymarket.com",
  DATA: "https://data-api.polymarket.com",
  GAMMA: "https://gamma-api.polymarket.com",
};

// ═══════════════════════════════════════════════════════════════════════════
// POLYMARKET CASINO BOT
// ═══════════════════════════════════════════════════════════════════════════

class ChurnEngine {
  private config: ChurnConfig;
  private logger: SimpleLogger;
  private evTracker: EvTracker;
  private biasAccumulator: BiasAccumulator;
  private positionManager: PositionManager;
  private decisionEngine: DecisionEngine;
  private executionEngine: ExecutionEngine;

  private client: any = null;
  private wallet: any = null;
  private address: string = "";

  private running = false;
  private cycleCount = 0;
  private lastRedeemTime = 0;
  private lastSummaryTime = 0;
  private lastPolCheckTime = 0;

  // Intervals
  private readonly REDEEM_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  private readonly SUMMARY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Position tracking cache
  private orderbookCache: Map<string, { data: any; time: number }> = new Map();
  private priceCache: Map<string, { price: number; time: number }> = new Map();
  private readonly CACHE_TTL_MS = 500;

  constructor() {
    this.config = loadConfig();
    this.logger = new SimpleLogger();

    this.evTracker = new EvTracker(this.config);
    this.biasAccumulator = new BiasAccumulator(this.config);
    this.positionManager = new PositionManager({
      tpCents: this.config.tpCents,
      hedgeTriggerCents: this.config.hedgeTriggerCents,
      maxAdverseCents: this.config.maxAdverseCents,
      maxHoldSeconds: this.config.maxHoldSeconds,
      hedgeRatio: this.config.hedgeRatio,
      maxHedgeRatio: this.config.maxHedgeRatio,
    });
    this.decisionEngine = new DecisionEngine(this.config);
    this.executionEngine = new ExecutionEngine(
      this.config,
      this.evTracker,
      this.biasAccumulator,
      this.positionManager,
      this.decisionEngine,
      this.logger,
    );

    // Log position closes
    this.positionManager.onTransition((t) => {
      if (t.toState === "CLOSED" && this.config.telegramBotToken) {
        const emoji = t.pnlCents >= 0 ? "✅" : "❌";
        sendTelegram(
          "Position Closed",
          `${emoji} ${t.reason}\nP&L: ${t.pnlCents >= 0 ? "+" : ""}${t.pnlCents.toFixed(1)}¢ ($${t.pnlUsd.toFixed(2)})`,
        ).catch(() => {});
      }
    });

    // Log bias changes
    this.biasAccumulator.onBiasChange((e) => {
      console.log(`📊 Bias | ${e.tokenId.slice(0, 8)}... | ${e.previousDirection} → ${e.newDirection} | $${e.netUsd.toFixed(0)} flow`);
    });
  }

  /**
   * Initialize the engine
   */
  async initialize(): Promise<boolean> {
    console.log("");
    console.log("═".repeat(50));
    console.log("  🎰 POLYMARKET CASINO BOT");
    console.log("═".repeat(50));
    console.log("");

    // Validate config
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`❌ Config error: ${err.field} - ${err.message}`);
      }
      return false;
    }

    // Log effective config
    logConfig(this.config, (msg) => console.log(msg));

    // Setup VPN if configured
    await this.setupVpn();

    // Initialize Telegram
    if (this.config.telegramBotToken && this.config.telegramChatId) {
      initTelegram();
      console.log("📱 Telegram enabled");
    }

    // Authenticate with CLOB
    const auth = await createClobClient(
      this.config.privateKey,
      this.config.rpcUrl,
      this.logger,
    );

    if (!auth.success || !auth.client || !auth.wallet) {
      console.error(`❌ Auth failed: ${auth.error}`);
      return false;
    }

    this.client = auth.client;
    this.wallet = auth.wallet;
    this.address = auth.address!;
    this.executionEngine.setClient(this.client);

    // Log wallet info
    const usdcBalance = await getUsdcBalance(this.wallet, this.address);
    const polBalance = await getPolBalance(this.wallet, this.address);
    const { effectiveBankroll, reserveUsd } =
      this.executionEngine.getEffectiveBankroll(usdcBalance);

    console.log("");
    console.log(`💰 Balance: $${usdcBalance.toFixed(2)} USDC | ${polBalance.toFixed(4)} POL`);
    console.log(`🏦 Reserve: $${reserveUsd.toFixed(2)} | Effective: $${effectiveBankroll.toFixed(2)}`);
    console.log(`🔴 Mode: ${this.config.liveTradingEnabled ? "LIVE TRADING" : "SIMULATION"}`);
    console.log("");

    if (effectiveBankroll <= 0) {
      console.error("❌ No effective bankroll available");
      return false;
    }

    // Send startup notification
    if (this.config.telegramBotToken) {
      await sendTelegram(
        "🎰 Casino Bot Started",
        `Balance: $${usdcBalance.toFixed(2)}\n` +
          `Reserve: $${reserveUsd.toFixed(2)}\n` +
          `Effective: $${effectiveBankroll.toFixed(2)}\n` +
          `${this.config.liveTradingEnabled ? "🔴 LIVE" : "🟢 SIM"}`,
      ).catch(() => {});
    }

    return true;
  }

  /**
   * Setup VPN if configured
   */
  private async setupVpn(): Promise<void> {
    const wgEnabled =
      process.env.WIREGUARD_ENABLED === "true" || process.env.WG_CONFIG;
    const ovpnEnabled =
      process.env.OPENVPN_ENABLED === "true" ||
      process.env.OVPN_CONFIG ||
      process.env.OPENVPN_CONFIG;

    if (!wgEnabled && !ovpnEnabled) {
      return;
    }

    try {
      capturePreVpnRouting();

      if (wgEnabled) {
        console.log("🔒 Starting WireGuard...");
        await startWireguard();
        console.log("🔒 WireGuard connected");
      } else if (ovpnEnabled) {
        console.log("🔒 Starting OpenVPN...");
        await startOpenvpn();
        console.log("🔒 OpenVPN connected");
      }

      // Setup bypass routes
      if (process.env.VPN_BYPASS_RPC !== "false") {
        await setupRpcBypass(this.config.rpcUrl, this.logger);
      }
      if (process.env.VPN_BYPASS_POLYMARKET_READS === "true") {
        await setupPolymarketReadBypass(this.logger);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ VPN setup failed: ${msg}`);
    }
  }

  /**
   * Main run loop with adaptive polling
   */
  async run(): Promise<void> {
    this.running = true;
    console.log("🎲 Running...\n");

    while (this.running) {
      try {
        await this.cycle();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Cycle error: ${msg}`);
      }

      // Adaptive polling: faster when we have open positions
      const openCount = this.positionManager.getOpenPositions().length;
      const pollInterval = openCount > 0
        ? Math.max(500, this.config.pollIntervalMs / 2)  // Faster polling with positions
        : this.config.pollIntervalMs;
      
      await this.sleep(pollInterval);
    }

    console.log("🛑 Stopped");
  }

  /**
   * Single trading cycle
   */
  private async cycle(): Promise<void> {
    this.cycleCount++;
    const now = Date.now();

    // 1. HIGH PRIORITY: Track open positions with optimized polling
    const openPositions = this.positionManager.getOpenPositions();
    if (openPositions.length > 0) {
      await this.trackPositionsOptimized(openPositions);
    }

    // 2. Fetch leaderboard trades for bias (less frequent)
    if (this.cycleCount % 3 === 0) {
      await this.biasAccumulator.fetchLeaderboardTrades();
    }

    // 3. Get wallet balance
    const usdcBalance = await getUsdcBalance(this.wallet, this.address);
    const polBalance = await getPolBalance(this.wallet, this.address);
    const { effectiveBankroll } =
      this.executionEngine.getEffectiveBankroll(usdcBalance);

    // 4. POL Reserve check (auto-fill gas)
    const polCheckInterval = this.config.polReserveCheckIntervalMin * 60 * 1000;
    if (
      this.config.polReserveEnabled &&
      now - this.lastPolCheckTime >= polCheckInterval
    ) {
      await this.checkPolReserve(polBalance, usdcBalance);
      this.lastPolCheckTime = now;
    }

    if (effectiveBankroll <= 0) {
      this.logger.warn("No effective bankroll, skipping cycle");
      return;
    }

    // 5. Process exits for existing positions (already tracked above)
    if (openPositions.length > 0) {
      const marketDataMap = this.buildMarketDataFromCache(openPositions);
      const exitResult = await this.executionEngine.processExits(marketDataMap);

      if (exitResult.exited.length > 0) {
        console.log(`📤 Exited ${exitResult.exited.length} position(s)`);
      }
      if (exitResult.hedged.length > 0) {
        console.log(`🛡️ Hedged ${exitResult.hedged.length} position(s)`);
      }
    }

    // 6. Process potential entries for tokens with active bias
    const evAllowed = this.evTracker.isTradingAllowed();
    const activeBiases = this.biasAccumulator.getActiveBiases();
    
    if (evAllowed.allowed && activeBiases.length > 0) {
      for (const bias of activeBiases.slice(0, 5)) {
        // Limit checks per cycle
        const marketData = await this.fetchTokenMarketData(bias.tokenId);
        if (marketData) {
          await this.executionEngine.processEntry(
            bias.tokenId,
            marketData,
            usdcBalance,
          );
        }
      }
    }

    // 7. Periodic redemption
    if (now - this.lastRedeemTime >= this.REDEEM_INTERVAL_MS) {
      await this.processRedemptions();
      this.lastRedeemTime = now;
    }

    // 8. Periodic summary (simplified)
    if (now - this.lastSummaryTime >= this.SUMMARY_INTERVAL_MS) {
      const metrics = this.evTracker.getMetrics();
      const positions = this.positionManager.getOpenPositions();
      console.log(`📊 Status | Positions: ${positions.length} | Trades: ${metrics.totalTrades} | Win: ${(metrics.winRate * 100).toFixed(0)}% | EV: ${metrics.evCents.toFixed(1)}¢ | P&L: $${metrics.totalPnlUsd.toFixed(2)}`);
      this.lastSummaryTime = now;
    }

    // 9. Prune old closed positions (silent)
    if (this.cycleCount % 100 === 0) {
      this.positionManager.pruneClosedPositions(60 * 60 * 1000);
    }
  }

  /**
   * Track positions - just get current prices from orderbook
   * The positions API already has our entry price (avgPrice).
   * We just need current market price to calculate P&L.
   */
  private async trackPositionsOptimized(positions: any[]): Promise<void> {
    const tokenIds = [...new Set(positions.map((p) => p.tokenId))];
    
    const fetchPromises = tokenIds.map(async (tokenId) => {
      try {
        const cached = this.orderbookCache.get(tokenId);
        if (cached && Date.now() - cached.time < this.CACHE_TTL_MS) {
          return { tokenId, orderbook: cached.data };
        }

        const orderbook = await this.client.getOrderBook(tokenId);
        if (orderbook) {
          this.orderbookCache.set(tokenId, { data: orderbook, time: Date.now() });
        }
        return { tokenId, orderbook };
      } catch {
        return { tokenId, orderbook: null };
      }
    });

    const results = await Promise.all(fetchPromises);

    for (const result of results) {
      if (!result.orderbook) continue;

      const bids = result.orderbook.bids || [];
      if (bids.length === 0) continue;

      // Use best bid - that's what we'd get if we sold right now
      const bestBid = parseFloat(bids[0].price);
      
      this.priceCache.set(result.tokenId, {
        price: bestBid * 100, // Store as cents
        time: Date.now(),
      });
    }
  }

  /**
   * Build market data map from cache for exit processing
   */
  private buildMarketDataFromCache(
    positions: any[],
  ): Map<string, TokenMarketData> {
    const map = new Map<string, TokenMarketData>();

    for (const pos of positions) {
      const cachedOrderbook = this.orderbookCache.get(pos.tokenId);
      const cachedPrice = this.priceCache.get(pos.tokenId);

      if (!cachedOrderbook?.data || !cachedPrice) continue;

      const orderbook = cachedOrderbook.data;
      const asks = orderbook.asks || [];
      const bids = orderbook.bids || [];

      if (asks.length === 0 || bids.length === 0) continue;

      const bestAsk = parseFloat(asks[0].price);
      const bestBid = parseFloat(bids[0].price);

      // Calculate depths
      let askDepthUsd = 0;
      let bidDepthUsd = 0;
      for (const ask of asks.slice(0, 5)) {
        askDepthUsd += parseFloat(ask.size) * parseFloat(ask.price);
      }
      for (const bid of bids.slice(0, 5)) {
        bidDepthUsd += parseFloat(bid.size) * parseFloat(bid.price);
      }

      const orderbookState: OrderbookState = {
        bestBidCents: bestBid * 100,
        bestAskCents: bestAsk * 100,
        bidDepthUsd,
        askDepthUsd,
        spreadCents: (bestAsk - bestBid) * 100,
        midPriceCents: cachedPrice.price,
      };

      const activity: MarketActivity = {
        tradesInWindow: 15,
        bookUpdatesInWindow: 25,
        lastTradeTime: Date.now(),
        lastUpdateTime: cachedPrice.time,
      };

      map.set(pos.tokenId, {
        tokenId: pos.tokenId,
        marketId: pos.marketId,
        orderbook: orderbookState,
        activity,
        referencePriceCents: pos.referencePriceCents,
      });
    }

    return map;
  }

  /**
   * Check and refill POL reserve if needed
   */
  private async checkPolReserve(
    polBalance: number,
    usdcBalance: number,
  ): Promise<void> {
    const config: PolReserveConfig = {
      enabled: this.config.polReserveEnabled,
      targetPol: this.config.polReserveTarget,
      minPol: this.config.polReserveMin,
      maxSwapUsd: this.config.polReserveMaxSwapUsd,
      checkIntervalMin: this.config.polReserveCheckIntervalMin,
      slippagePct: this.config.polReserveSlippagePct,
    };

    if (!shouldRebalance(polBalance, config.minPol, config.enabled)) {
      return;
    }

    console.log(`⛽ Gas low! POL: ${polBalance.toFixed(3)} (min: ${config.minPol})`);

    if (!this.config.liveTradingEnabled) {
      console.log("⛽ Skipping swap (simulation mode)");
      return;
    }

    const result = await runPolReserve(
      this.wallet,
      this.address,
      polBalance,
      usdcBalance,
      config,
      this.logger,
    );

    if (result?.success) {
      console.log(`⛽ Refilled! Swapped $${result.usdcSwapped?.toFixed(2)} → ${result.polReceived?.toFixed(2)} POL`);

      if (this.config.telegramBotToken) {
        await sendTelegram(
          "⛽ Gas Refilled",
          `Swapped $${result.usdcSwapped?.toFixed(2)} USDC for ${result.polReceived?.toFixed(2)} POL`,
        ).catch(() => {});
      }
    }
  }

  /**
   * Fetch market data for a single token (with caching)
   */
  private async fetchTokenMarketData(
    tokenId: string,
  ): Promise<TokenMarketData | null> {
    try {
      // Check cache first
      const cached = this.orderbookCache.get(tokenId);
      let orderBook;
      
      if (cached && Date.now() - cached.time < this.CACHE_TTL_MS) {
        orderBook = cached.data;
      } else {
        orderBook = await this.client.getOrderBook(tokenId);
        if (orderBook) {
          this.orderbookCache.set(tokenId, { data: orderBook, time: Date.now() });
        }
      }
      
      if (!orderBook) return null;

      const asks = orderBook.asks || [];
      const bids = orderBook.bids || [];

      if (asks.length === 0 || bids.length === 0) return null;

      const bestAsk = parseFloat(asks[0].price);
      const bestBid = parseFloat(bids[0].price);

      // Calculate depths
      let askDepthUsd = 0;
      let bidDepthUsd = 0;
      for (const ask of asks.slice(0, 5)) {
        askDepthUsd += parseFloat(ask.size) * parseFloat(ask.price);
      }
      for (const bid of bids.slice(0, 5)) {
        bidDepthUsd += parseFloat(bid.size) * parseFloat(bid.price);
      }

      const orderbook: OrderbookState = {
        bestBidCents: bestBid * 100,
        bestAskCents: bestAsk * 100,
        bidDepthUsd,
        askDepthUsd,
        spreadCents: (bestAsk - bestBid) * 100,
        midPriceCents: ((bestAsk + bestBid) / 2) * 100,
      };

      // For activity, we'd need to track book updates over time
      // Simplified for now
      const activity: MarketActivity = {
        tradesInWindow: 15, // Would need actual tracking
        bookUpdatesInWindow: 25,
        lastTradeTime: Date.now(),
        lastUpdateTime: Date.now(),
      };

      return {
        tokenId,
        orderbook,
        activity,
        referencePriceCents: orderbook.midPriceCents,
      };
    } catch {
      return null;
    }
  }

  /**
   * Process position redemptions
   */
  private async processRedemptions(): Promise<void> {
    try {
      const redeemable = await fetchRedeemablePositions(this.address);
      if (redeemable.length === 0) return;

      console.log(`🎁 Found ${redeemable.length} position(s) to redeem`);

      const result = await redeemAllPositions(
        this.wallet,
        this.address,
        this.logger,
      );

      if (result.redeemed > 0) {
        console.log(`🎁 Redeemed ${result.redeemed} position(s) worth $${result.totalValue.toFixed(2)}`);

        if (this.config.telegramBotToken) {
          await sendTelegram(
            "🎁 Positions Redeemed",
            `Collected ${result.redeemed} settled position(s)\nValue: $${result.totalValue.toFixed(2)}`,
          ).catch(() => {});
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Redemption error: ${msg}`);
    }
  }

  /**
   * Stop the engine
   */
  stop(): void {
    this.running = false;
    console.log("\n🛑 Stopping...");

    if (this.config.telegramBotToken) {
      sendTelegram("🛑 Bot Stopped", "Polymarket Casino Bot has been stopped").catch(() => {});
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const engine = new ChurnEngine();

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\nReceived SIGINT, shutting down...");
    engine.stop();
  });

  process.on("SIGTERM", () => {
    console.log("\nReceived SIGTERM, shutting down...");
    engine.stop();
  });

  // Initialize
  const initialized = await engine.initialize();
  if (!initialized) {
    console.error("Failed to initialize engine");
    process.exit(1);
  }

  // Run
  await engine.run();
}

// Run if executed directly
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { ChurnEngine };
