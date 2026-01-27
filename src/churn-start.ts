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
  // Position fetching for liquidation mode
  getPositions,
  smartSell,
  type Position,
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
  // Position tracking - no cache needed, API is fast
  private lastSummaryTime = 0;
  private lastPolCheckTime = 0;
  // Liquidation mode - when true, prioritize selling existing positions
  private liquidationMode = false;

  // Intervals
  private readonly REDEEM_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  private readonly SUMMARY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
    console.log("═".repeat(60));
    console.log("  🎰 POLYMARKET CASINO BOT");
    console.log("═".repeat(60));
    console.log("");
    console.log("  Load wallet. Start bot. Walk away.");
    console.log("");
    console.log("  The math:");
    console.log("    avg_win  = 14¢   (take profit)");
    console.log("    avg_loss = 9¢    (hedge-capped)");
    console.log("    churn    = 2¢    (spread + slippage)");
    console.log("    break-even = 48% win rate");
    console.log("");
    console.log("  Following whale flows → ~55% accuracy → profit");
    console.log("");
    console.log("═".repeat(60));
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
      console.log("📱 Telegram alerts enabled");
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

    // ═══════════════════════════════════════════════════════════════════════
    // STARTUP REDEMPTION - Collect any settled positions first
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🎁 Checking for redeemable positions...");
    await this.processRedemptions();
    this.lastRedeemTime = Date.now(); // Reset timer after startup redemption

    // Get balances AFTER redemption
    let usdcBalance = await getUsdcBalance(this.wallet, this.address);
    const polBalance = await getPolBalance(this.wallet, this.address);
    let { effectiveBankroll, reserveUsd } =
      this.executionEngine.getEffectiveBankroll(usdcBalance);

    // ═══════════════════════════════════════════════════════════════════════
    // CHECK FOR EXISTING POSITIONS (for liquidation mode)
    // ═══════════════════════════════════════════════════════════════════════
    let existingPositions: Position[] = [];
    let positionValue = 0;
    try {
      existingPositions = await getPositions(this.address, true);
      positionValue = existingPositions.reduce((sum, p) => sum + p.value, 0);
    } catch (err) {
      console.warn(`⚠️ Could not fetch existing positions: ${err instanceof Error ? err.message : err}`);
    }

    console.log("");
    console.log(`💰 Balance: $${usdcBalance.toFixed(2)} USDC | ${polBalance.toFixed(4)} POL`);
    console.log(`🏦 Reserve: $${reserveUsd.toFixed(2)} | Effective: $${effectiveBankroll.toFixed(2)}`);
    if (existingPositions.length > 0) {
      console.log(`📦 Existing Positions: ${existingPositions.length} (value: $${positionValue.toFixed(2)})`);
    }
    console.log(`🔴 Mode: ${this.config.liveTradingEnabled ? "LIVE TRADING" : "SIMULATION"}`);
    console.log("");

    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDATION MODE - Start even with no effective bankroll if positions exist
    // ═══════════════════════════════════════════════════════════════════════
    if (effectiveBankroll <= 0) {
      if (this.config.forceLiquidation && existingPositions.length > 0) {
        console.log("━".repeat(60));
        console.log("🔥 LIQUIDATION MODE ACTIVATED");
        console.log("━".repeat(60));
        console.log(`   No effective bankroll ($${usdcBalance.toFixed(2)} < $${reserveUsd.toFixed(2)} reserve)`);
        console.log(`   But you have ${existingPositions.length} positions worth $${positionValue.toFixed(2)}`);
        console.log(`   Will liquidate positions to free up capital`);
        console.log("━".repeat(60));
        console.log("");

        this.liquidationMode = true;

        if (this.config.telegramBotToken) {
          await sendTelegram(
            "🔥 Liquidation Mode Activated",
            `Balance: $${usdcBalance.toFixed(2)}\n` +
              `Positions: ${existingPositions.length} ($${positionValue.toFixed(2)})\n` +
              `Will sell positions to free capital`,
          ).catch(() => {});
        }

        return true;
      } else if (existingPositions.length > 0) {
        console.error("❌ No effective bankroll available");
        console.error(`   You have ${existingPositions.length} positions worth $${positionValue.toFixed(2)}`);
        console.error(`   Set FORCE_LIQUIDATION=true to sell them and free up capital`);
        return false;
      } else {
        console.error("❌ No effective bankroll available");
        console.error(`   Deposit more USDC or wait for positions to settle`);
        return false;
      }
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
   * Main run loop - aggressive polling
   * API allows 150 req/sec for orderbook, we can go fast!
   */
  async run(): Promise<void> {
    this.running = true;
    
    if (this.liquidationMode) {
      console.log("🔥 Running in LIQUIDATION MODE...\n");
    } else {
      console.log("🎲 Running...\n");
    }

    while (this.running) {
      try {
        if (this.liquidationMode) {
          await this.liquidationCycle();
        } else {
          await this.cycle();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`❌ Cycle error: ${msg}`);
      }

      // Aggressive polling: 100ms with positions, 200ms without
      // In liquidation mode, use slower interval (1s) to avoid rate limits
      const openCount = this.positionManager.getOpenPositions().length;
      const pollInterval = this.liquidationMode
        ? 1000  // 1s in liquidation mode
        : (openCount > 0
          ? this.config.positionPollIntervalMs  // 100ms - track positions fast
          : this.config.pollIntervalMs);        // 200ms - scan for opportunities
      
      await this.sleep(pollInterval);
    }

    console.log("🛑 Stopped");
  }

  /**
   * Liquidation cycle - Sell existing Polymarket positions to free capital
   * Once enough capital is freed, transition back to normal trading mode
   */
  private async liquidationCycle(): Promise<void> {
    this.cycleCount++;
    const now = Date.now();

    // ─────────────────────────────────────────────────────────────────
    // 1. GET BALANCES & CHECK IF WE CAN EXIT LIQUIDATION MODE
    // ─────────────────────────────────────────────────────────────────
    const usdcBalance = await getUsdcBalance(this.wallet, this.address);
    const { effectiveBankroll, reserveUsd } = this.executionEngine.getEffectiveBankroll(usdcBalance);

    if (effectiveBankroll > 0) {
      // We have enough capital now - exit liquidation mode
      console.log("━".repeat(60));
      console.log("✅ LIQUIDATION MODE COMPLETE");
      console.log("━".repeat(60));
      console.log(`   Balance: $${usdcBalance.toFixed(2)}`);
      console.log(`   Effective bankroll: $${effectiveBankroll.toFixed(2)}`);
      console.log(`   Transitioning to normal trading mode`);
      console.log("━".repeat(60));
      console.log("");

      this.liquidationMode = false;

      if (this.config.telegramBotToken) {
        await sendTelegram(
          "✅ Liquidation Complete",
          `Balance: $${usdcBalance.toFixed(2)}\n` +
            `Effective: $${effectiveBankroll.toFixed(2)}\n` +
            `Now entering normal trading mode`,
        ).catch(() => {});
      }

      return;
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. REDEEM SETTLED POSITIONS
    // ─────────────────────────────────────────────────────────────────
    if (now - this.lastRedeemTime >= this.REDEEM_INTERVAL_MS) {
      await this.processRedemptions();
      this.lastRedeemTime = now;
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. FETCH AND LIQUIDATE EXISTING POLYMARKET POSITIONS
    // ─────────────────────────────────────────────────────────────────
    let positions: Position[] = [];
    try {
      positions = await getPositions(this.address, true);
    } catch (err) {
      console.warn(`⚠️ Could not fetch positions: ${err instanceof Error ? err.message : err}`);
      return;
    }

    if (positions.length === 0) {
      console.log("📦 No positions to liquidate");
      console.log(`   Balance: $${usdcBalance.toFixed(2)} (need $${reserveUsd.toFixed(2)} for trading)`);
      console.log(`   Waiting for deposits or position settlements...`);
      return;
    }

    // Sort by value descending - sell largest positions first for fastest capital recovery
    const sortedPositions = [...positions].sort((a, b) => b.value - a.value);

    console.log(`🔥 Liquidating ${sortedPositions.length} positions (total value: $${sortedPositions.reduce((s, p) => s + p.value, 0).toFixed(2)})`);

    // Try to sell one position per cycle to avoid overwhelming the API
    for (const position of sortedPositions.slice(0, 1)) {
      console.log(`📤 Selling: $${position.value.toFixed(2)} @ ${(position.curPrice * 100).toFixed(1)}¢ (P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%)`);

      if (!this.config.liveTradingEnabled) {
        console.log(`   [SIM] Would sell ${position.size.toFixed(2)} shares`);
        continue;
      }

      if (!this.client) {
        console.warn(`   ⚠️ No client available for selling`);
        continue;
      }

      try {
        const result = await smartSell(this.client, position, {
          maxSlippagePct: 10,  // Allow higher slippage in liquidation mode
          forceSell: true,     // Force sell even if conditions aren't ideal
          logger: this.logger,
        });

        if (result.success) {
          console.log(`   ✅ Sold for $${result.filledUsd?.toFixed(2) || 'unknown'}`);

          if (this.config.telegramBotToken) {
            await sendTelegram(
              "🔥 Position Liquidated",
              `Sold: $${result.filledUsd?.toFixed(2) || position.value.toFixed(2)}\n` +
                `P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%`,
            ).catch(() => {});
          }
        } else {
          console.log(`   ❌ Sell failed: ${result.reason}`);
        }
      } catch (err) {
        console.warn(`   ⚠️ Sell error: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Status update
    if (now - this.lastSummaryTime >= this.SUMMARY_INTERVAL_MS) {
      const totalValue = positions.reduce((s, p) => s + p.value, 0);
      console.log("");
      console.log(`📊 LIQUIDATION STATUS`);
      console.log(`   Balance: $${usdcBalance.toFixed(2)} | Need: $${reserveUsd.toFixed(2)}`);
      console.log(`   Positions remaining: ${positions.length} ($${totalValue.toFixed(2)})`);
      console.log("");
      this.lastSummaryTime = now;
    }
  }

  /**
   * Single trading cycle - SIMPLE
   * 
   * 1. Check our positions (direct API)
   * 2. Exit if needed (TP, stop loss, time stop)
   * 3. Poll whale flow for bias
   * 4. Enter if bias allows
   * 5. Periodic housekeeping
   */
  private async cycle(): Promise<void> {
    this.cycleCount++;
    const now = Date.now();

    // ─────────────────────────────────────────────────────────────────
    // 1. GET BALANCES
    // ─────────────────────────────────────────────────────────────────
    const usdcBalance = await getUsdcBalance(this.wallet, this.address);
    const polBalance = await getPolBalance(this.wallet, this.address);
    const { effectiveBankroll } = this.executionEngine.getEffectiveBankroll(usdcBalance);

    if (effectiveBankroll <= 0) {
      return; // No money to trade
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. CHECK OUR POSITIONS - DIRECT API, NO CACHE
    // ─────────────────────────────────────────────────────────────────
    const openPositions = this.positionManager.getOpenPositions();
    
    if (openPositions.length > 0) {
      // Get fresh prices for all positions
      const marketDataMap = await this.buildMarketData(openPositions);
      
      // Process exits (TP, stop loss, hedge, time stop)
      const exitResult = await this.executionEngine.processExits(marketDataMap);
      
      if (exitResult.exited.length > 0) {
        console.log(`📤 Exited ${exitResult.exited.length} position(s)`);
      }
      if (exitResult.hedged.length > 0) {
        console.log(`🛡️ Hedged ${exitResult.hedged.length} position(s)`);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. POLL WHALE FLOW FOR BIAS
    // ─────────────────────────────────────────────────────────────────
    if (this.cycleCount % 3 === 0) {
      await this.biasAccumulator.fetchLeaderboardTrades();
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. ENTER IF BIAS ALLOWS
    // ─────────────────────────────────────────────────────────────────
    const evAllowed = this.evTracker.isTradingAllowed();
    const activeBiases = this.biasAccumulator.getActiveBiases();
    
    if (evAllowed.allowed && activeBiases.length > 0) {
      for (const bias of activeBiases.slice(0, 3)) {
        const marketData = await this.fetchTokenMarketData(bias.tokenId);
        if (marketData) {
          await this.executionEngine.processEntry(bias.tokenId, marketData, usdcBalance);
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. PERIODIC HOUSEKEEPING
    // ─────────────────────────────────────────────────────────────────
    
    // Auto-redeem resolved positions
    if (now - this.lastRedeemTime >= this.REDEEM_INTERVAL_MS) {
      await this.processRedemptions();
      this.lastRedeemTime = now;
    }

    // Auto-fill POL for gas
    const polCheckInterval = this.config.polReserveCheckIntervalMin * 60 * 1000;
    if (this.config.polReserveEnabled && now - this.lastPolCheckTime >= polCheckInterval) {
      await this.checkPolReserve(polBalance, usdcBalance);
      this.lastPolCheckTime = now;
    }

    // Status update
    if (now - this.lastSummaryTime >= this.SUMMARY_INTERVAL_MS) {
      await this.logStatus(usdcBalance, effectiveBankroll);
      this.lastSummaryTime = now;
    }

    // Cleanup old closed positions
    if (this.cycleCount % 100 === 0) {
      this.positionManager.pruneClosedPositions(60 * 60 * 1000);
    }
  }

  /**
   * Log status - clean and simple
   */
  private async logStatus(usdcBalance: number, effectiveBankroll: number): Promise<void> {
    const metrics = this.evTracker.getMetrics();
    const positions = this.positionManager.getOpenPositions();
    
    const winPct = (metrics.winRate * 100).toFixed(0);
    const evSign = metrics.evCents >= 0 ? "+" : "";
    const pnlSign = metrics.totalPnlUsd >= 0 ? "+" : "";
    
    console.log("");
    console.log(`📊 STATUS | ${new Date().toLocaleTimeString()}`);
    console.log(`   💰 Balance: $${usdcBalance.toFixed(2)} | Bankroll: $${effectiveBankroll.toFixed(2)}`);
    console.log(`   📈 Positions: ${positions.length} | Trades: ${metrics.totalTrades}`);
    console.log(`   🎯 Win: ${winPct}% | EV: ${evSign}${metrics.evCents.toFixed(1)}¢ | P&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`);
    console.log("");
    
    // Telegram update
    if (this.config.telegramBotToken && metrics.totalTrades > 0) {
      await sendTelegram(
        "📊 Status",
        `Balance: $${usdcBalance.toFixed(2)}\nPositions: ${positions.length}\nWin: ${winPct}%\nP&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`
      ).catch(() => {});
    }
  }

  /**
   * Get current price for a token - straight API call, no cache
   * API allows 150 req/sec, we can afford to be direct
   */
  private async getCurrentPrice(tokenId: string): Promise<number | null> {
    try {
      const orderbook = await this.client.getOrderBook(tokenId);
      if (!orderbook?.bids?.length) return null;
      
      // Best bid = what we'd get if we sold right now
      return parseFloat(orderbook.bids[0].price) * 100;
    } catch {
      return null;
    }
  }

  /**
   * Get orderbook state for a token - straight API call
   */
  private async getOrderbookState(tokenId: string): Promise<OrderbookState | null> {
    try {
      const orderbook = await this.client.getOrderBook(tokenId);
      if (!orderbook?.bids?.length || !orderbook?.asks?.length) return null;

      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestAsk = parseFloat(orderbook.asks[0].price);
      
      // Sum up depth
      let bidDepth = 0, askDepth = 0;
      for (const level of orderbook.bids.slice(0, 5)) {
        bidDepth += parseFloat(level.size) * parseFloat(level.price);
      }
      for (const level of orderbook.asks.slice(0, 5)) {
        askDepth += parseFloat(level.size) * parseFloat(level.price);
      }

      return {
        bestBidCents: bestBid * 100,
        bestAskCents: bestAsk * 100,
        bidDepthUsd: bidDepth,
        askDepthUsd: askDepth,
        spreadCents: (bestAsk - bestBid) * 100,
        midPriceCents: ((bestBid + bestAsk) / 2) * 100,
      };
    } catch {
      return null;
    }
  }

  /**
   * Build market data for positions - direct API calls
   */
  private async buildMarketData(positions: any[]): Promise<Map<string, TokenMarketData>> {
    const map = new Map<string, TokenMarketData>();
    
    // Fetch all orderbooks in parallel - API can handle it
    const fetchPromises = positions.map(async (pos) => {
      const orderbook = await this.getOrderbookState(pos.tokenId);
      return { pos, orderbook };
    });
    
    const results = await Promise.all(fetchPromises);
    
    for (const { pos, orderbook } of results) {
      if (!orderbook) continue;
      
      const activity: MarketActivity = {
        tradesInWindow: 15,  // Assume active - can enhance later
        bookUpdatesInWindow: 25,
        lastTradeTime: Date.now(),
        lastUpdateTime: Date.now(),
      };

      map.set(pos.tokenId, {
        tokenId: pos.tokenId,
        marketId: pos.marketId,
        orderbook,
        activity,
        referencePriceCents: pos.referencePriceCents || orderbook.midPriceCents,
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
   * Fetch market data for a single token - DIRECT API CALL
   * No caching! Stale prices caused exit failures before.
   */
  private async fetchTokenMarketData(tokenId: string): Promise<TokenMarketData | null> {
    const orderbook = await this.getOrderbookState(tokenId);
    if (!orderbook) return null;

    const activity: MarketActivity = {
      tradesInWindow: 15,
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
