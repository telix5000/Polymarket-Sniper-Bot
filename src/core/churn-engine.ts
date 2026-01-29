/**
 * ChurnEngine - Main Trading Orchestrator
 *
 * Extracted from start.ts for modularity.
 * This is the "brain" that coordinates all trading operations.
 */

import type { ClobClient } from "@polymarket/clob-client";

// Direct imports from lib modules (avoid barrel to prevent circular deps)
import {
  createClobClient,
  BalanceCache,
  initBalanceCache,
  initTelegram,
  sendTelegram,
  redeemAllPositions,
  fetchRedeemablePositions,
  capturePreVpnRouting,
  startWireguard,
  startOpenvpn,
  setupRpcBypass,
  setupPolymarketReadBypass,
  emitRoutingPolicyPreEvent,
  emitRoutingPolicyEffectiveEvent,
  ensureWriteHostVpnRoutes,
  // VPN bypass utilities for proper default handling
  getEnvBool,
  VPN_BYPASS_DEFAULTS,
  runPolReserve,
  shouldRebalance,
  type PolReserveConfig,
  getPositions,
  invalidatePositions,
  type Position,
  OnChainMonitor,
  createOnChainMonitorConfig,
  getOppositeTokenId,
  fetchMarketByTokenId,
  initGitHubReporter,
  getGitHubReporter,
  LatencyMonitor,
  initLatencyMonitor,
  isTelegramEnabled,
  initMarketDataFacade,
  initMarketDataStore,
  getWebSocketMarketClient,
  initWebSocketMarketClient,
  getWebSocketUserClient,
  setupWebSocketBypass,
  type MarketDataFacade,
  type DiagWorkflowDeps,
  BiasAccumulator,
  type LeaderboardTrade,
  type TokenBias,
  VolumeScanner,
  MarketDataCooldownManager,
  type MarketDataFailureReason,
  shouldApplyLongCooldown,
  smartSell,
  isDeadBook,
} from "../lib";

// Direct imports from core modules
import {
  DecisionEngine,
  type DecisionEngineConfig,
  type OrderbookState,
  type MarketActivity,
  EvTracker,
  type EvTrackerConfig,
  ExecutionEngine,
  type ExecutionEngineConfig,
  type TokenMarketData,
  type ChurnLogger,
  PositionManager,
  DynamicReserveManager,
} from "./index";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ChurnConfig interface - configuration for the trading engine.
 * This must match the interface in start.ts exactly.
 */
export interface ChurnConfig {
  // USER CONFIGURABLE
  maxTradeUsd: number;

  // Capital & Position Sizing
  tradeFraction: number;
  maxDeployedFractionTotal: number;
  maxOpenPositionsTotal: number;
  maxOpenPositionsPerMarket: number;
  cooldownSecondsPerToken: number;

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
  activityWindowSeconds: number;

  // Cooldown Settings
  entryCooldownSecondsTransient: number;

  // EV Controls
  rollingWindowTrades: number;
  churnCostCentsEstimate: number;
  minEvCents: number;
  minProfitFactor: number;
  pauseSeconds: number;

  // Bias (Leaderboard Flow)
  biasMode: string;
  leaderboardTopN: number;
  biasWindowSeconds: number;
  biasMinNetUsd: number;
  biasMinTrades: number;
  biasStaleSeconds: number;
  allowEntriesOnlyWithBias: boolean;
  onBiasFlip: string;
  onBiasNone: string;

  // Polling / Ops
  pollIntervalMs: number;
  positionPollIntervalMs: number;
  balanceRefreshIntervalMs: number;
  logLevel: string;

  // Wallet / Reserve Management
  reserveFraction: number;
  minReserveUsd: number;
  useAvailableBalanceOnly: boolean;

  // Liquidation Mode
  liquidationMode: "off" | "losing" | "all";
  liquidationMaxSlippagePct: number;
  liquidationPollIntervalMs: number;

  // Aggressive Whale Copy Mode
  copyAnyWhaleBuy: boolean;

  // Market Scanner
  scanActiveMarkets: boolean;
  scanMinVolumeUsd: number;
  scanTopNMarkets: number;
  scanIntervalSeconds: number;

  // Dynamic Reserves
  dynamicReservesEnabled: boolean;
  reserveAdaptationRate: number;
  missedOpportunityWeight: number;
  hedgeCoverageWeight: number;
  maxReserveFraction: number;

  // Auth
  privateKey: string;
  rpcUrl: string;
  liveTradingEnabled: boolean;

  // Telegram (optional)
  telegramBotToken?: string;
  telegramChatId?: string;

  // POL Reserve
  polReserveEnabled: boolean;
  polReserveTarget: number;
  polReserveMin: number;
  polReserveMaxSwapUsd: number;
  polReserveCheckIntervalMin: number;
  polReserveSlippagePct: number;

  // On-Chain Monitoring
  onchainMonitorEnabled: boolean;
  onchainMinWhaleTradeUsd: number;
  infuraTier: "core" | "developer" | "team" | "growth";

  // Whale Price-Range Filtering
  whalePriceMin?: number;
  whalePriceMax?: number;
}

/** Structured result from fetchTokenMarketData */
type FetchMarketDataResult =
  | { ok: true; data: TokenMarketData }
  | { ok: false; reason: MarketDataFailureReason; detail?: string };

// ═══════════════════════════════════════════════════════════════════════════
// SIMPLE LOGGER
// ═══════════════════════════════════════════════════════════════════════════

export class SimpleLogger implements ChurnLogger {
  info(msg: string): void {
    console.log(msg);
  }
  warn(msg: string): void {
    console.log(`⚠️ ${msg}`);
  }
  error(msg: string): void {
    console.log(`❌ ${msg}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DEPENDENCIES THAT MUST BE INJECTED
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dependencies for ChurnEngine constructor
 */
export interface ChurnEngineDeps {
  loadConfig: () => ChurnConfig;
  validateConfig: (
    config: ChurnConfig,
  ) => Array<{ field: string; message: string }>;
  logConfig: (config: ChurnConfig, log: (msg: string) => void) => void;
  debug: (message: string, ...args: any[]) => void;
  shouldCooldownOnFailure: (reason: string | undefined) => boolean;
  isDebugEnabled: () => boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// POLYMARKET BOT - ChurnEngine
// ═══════════════════════════════════════════════════════════════════════════

export class ChurnEngine {
  private config: ChurnConfig;
  private logger: SimpleLogger;
  private evTracker: EvTracker;
  private biasAccumulator: BiasAccumulator;
  private positionManager: PositionManager;
  private decisionEngine: DecisionEngine;
  private executionEngine: ExecutionEngine;
  private onchainMonitor: OnChainMonitor | null = null;
  private volumeScanner: VolumeScanner;
  private dynamicReserveManager: DynamicReserveManager;
  private latencyMonitor: LatencyMonitor;
  private marketDataFacade: MarketDataFacade | null = null;
  private balanceCache: BalanceCache | null = null;

  private client: ClobClient | null = null;
  private wallet: any = null;
  private address: string = "";

  private running = false;
  private cycleCount = 0;
  private lastRedeemTime = 0;
  private lastSummaryTime = 0;
  private lastPolCheckTime = 0;
  private lastScanTime = 0;
  private liquidationMode = false;
  private recentlySoldPositions = new Map<string, number>();
  private readonly SOLD_POSITION_COOLDOWN_MS = 30 * 1000;

  private failedEntryCooldowns = new Map<string, number>();
  private get FAILED_ENTRY_COOLDOWN_MS(): number {
    return this.config.entryCooldownSecondsTransient * 1000;
  }
  private marketDataCooldownManager = new MarketDataCooldownManager();
  private readonly COOLDOWN_SUMMARY_INTERVAL = 100;
  private dustBookRestVerifyThrottle = new Map<string, number>();
  private readonly DUST_BOOK_VERIFY_THROTTLE_MS = 5 * 60 * 1000;

  private readonly REDEEM_INTERVAL_MS = 10 * 60 * 1000;
  private readonly SUMMARY_INTERVAL_MS = 5 * 60 * 1000;

  // Diagnostics
  private diagnostics = {
    startTime: Date.now(),
    whaleTradesDetected: 0,
    entryAttempts: 0,
    entrySuccesses: 0,
    entryFailureReasons: [] as string[],
    orderbookFetchFailures: 0,
    marketDataFetchAttempts: 0,
    marketDataFetchSuccesses: 0,
    startupReportSent: false,
    candidatesSeen: 0,
    candidatesRejectedLiquidity: 0,
    funnel: {
      tradesIngested: 0,
      tradesFilteredByPrice: 0,
      biasesRejectedStale: 0,
      biasesRejectedTrades: 0,
      biasesRejectedFlow: 0,
      biasesSkippedCooldown: 0,
      eligibleSignals: 0,
      entryAttemptsFromBias: 0,
    },
  };
  private readonly STARTUP_DIAGNOSTIC_DELAY_MS = 60 * 1000;
  private readonly MAX_FAILURE_REASONS = 50;

  // Injected dependencies
  private deps: ChurnEngineDeps;

  constructor(deps: ChurnEngineDeps) {
    this.deps = deps;
    this.config = deps.loadConfig();
    this.logger = new SimpleLogger();

    // Create EvTracker config from ChurnConfig
    const evTrackerConfig: EvTrackerConfig = {
      rollingWindowTrades: this.config.rollingWindowTrades,
      churnCostCentsEstimate: this.config.churnCostCentsEstimate,
      minEvCents: this.config.minEvCents,
      minProfitFactor: this.config.minProfitFactor,
      pauseSeconds: this.config.pauseSeconds,
    };
    this.evTracker = new EvTracker(evTrackerConfig);

    // Create BiasAccumulator
    this.biasAccumulator = new BiasAccumulator({
      leaderboardTopN: this.config.leaderboardTopN,
      biasWindowSeconds: this.config.biasWindowSeconds,
      biasMinNetUsd: this.config.biasMinNetUsd,
      biasMinTrades: this.config.biasMinTrades,
      biasStaleSeconds: this.config.biasStaleSeconds,
      allowEntriesOnlyWithBias: this.config.allowEntriesOnlyWithBias,
      copyAnyWhaleBuy: this.config.copyAnyWhaleBuy,
      whalePriceMin: this.config.whalePriceMin,
      whalePriceMax: this.config.whalePriceMax,
    });

    // Create VolumeScanner
    this.volumeScanner = new VolumeScanner({
      scanIntervalSeconds: this.config.scanIntervalSeconds,
      scanTopNMarkets: this.config.scanTopNMarkets,
      scanMinVolumeUsd: this.config.scanMinVolumeUsd,
    });

    // Create DynamicReserveManager
    this.dynamicReserveManager = new DynamicReserveManager({
      dynamicReservesEnabled: this.config.dynamicReservesEnabled,
      reserveFraction: this.config.reserveFraction,
      minReserveUsd: this.config.minReserveUsd,
      missedOpportunityWeight: this.config.missedOpportunityWeight,
      hedgeCoverageWeight: this.config.hedgeCoverageWeight,
      maxReserveFraction: this.config.maxReserveFraction,
      reserveAdaptationRate: this.config.reserveAdaptationRate,
      maxTradeUsd: this.config.maxTradeUsd,
      hedgeRatio: this.config.hedgeRatio,
    });

    this.positionManager = new PositionManager({
      tpCents: this.config.tpCents,
      hedgeTriggerCents: this.config.hedgeTriggerCents,
      maxAdverseCents: this.config.maxAdverseCents,
      maxHoldSeconds: this.config.maxHoldSeconds,
      hedgeRatio: this.config.hedgeRatio,
      maxHedgeRatio: this.config.maxHedgeRatio,
    });

    // Create DecisionEngine config
    const decisionEngineConfig: DecisionEngineConfig = {
      entryBandCents: this.config.entryBandCents,
      tpCents: this.config.tpCents,
      hedgeTriggerCents: this.config.hedgeTriggerCents,
      maxAdverseCents: this.config.maxAdverseCents,
      maxHoldSeconds: this.config.maxHoldSeconds,
      hedgeRatio: this.config.hedgeRatio,
      maxHedgeRatio: this.config.maxHedgeRatio,
      minEntryPriceCents: this.config.minEntryPriceCents,
      maxEntryPriceCents: this.config.maxEntryPriceCents,
      preferredEntryLowCents: this.config.preferredEntryLowCents,
      preferredEntryHighCents: this.config.preferredEntryHighCents,
      entryBufferCents: this.config.entryBufferCents,
      minSpreadCents: this.config.minSpreadCents,
      minDepthUsdAtExit: this.config.minDepthUsdAtExit,
      minTradesLastX: this.config.minTradesLastX,
      minBookUpdatesLastX: this.config.minBookUpdatesLastX,
      maxOpenPositionsTotal: this.config.maxOpenPositionsTotal,
      maxOpenPositionsPerMarket: this.config.maxOpenPositionsPerMarket,
      maxDeployedFractionTotal: this.config.maxDeployedFractionTotal,
      tradeFraction: this.config.tradeFraction,
      maxTradeUsd: this.config.maxTradeUsd,
    };
    this.decisionEngine = new DecisionEngine(decisionEngineConfig);

    // Create ExecutionEngine config
    const executionEngineConfig: ExecutionEngineConfig = {
      liveTradingEnabled: this.config.liveTradingEnabled,
      reserveFraction: this.config.reserveFraction,
      minReserveUsd: this.config.minReserveUsd,
      cooldownSecondsPerToken: this.config.cooldownSecondsPerToken,
      copyAnyWhaleBuy: this.config.copyAnyWhaleBuy,
    };
    this.executionEngine = new ExecutionEngine(
      executionEngineConfig,
      this.evTracker,
      this.biasAccumulator,
      this.positionManager,
      this.decisionEngine,
      this.logger,
    );

    // Initialize latency monitor
    this.latencyMonitor = initLatencyMonitor({
      rpcUrl: this.config.rpcUrl,
      measureIntervalMs: 30000,
      degradedThresholdMs: 500,
      criticalThresholdMs: 2000,
      baseSlippagePct: 2,
      maxSlippagePct: 10,
    });

    // Log position closes
    this.positionManager.onTransition((t) => {
      if (t.toState === "CLOSED" && isTelegramEnabled()) {
        const emoji = t.pnlCents >= 0 ? "✅" : "❌";
        sendTelegram(
          "Position Closed",
          `${emoji} ${t.reason}\nP&L: ${t.pnlCents >= 0 ? "+" : ""}${t.pnlCents.toFixed(1)}¢ ($${t.pnlUsd.toFixed(2)})`,
        ).catch(() => {});
      }
    });

    // Log bias changes
    this.biasAccumulator.onBiasChange((e) => {
      console.log(
        `📊 Bias | ${e.tokenId.slice(0, 8)}... | ${e.previousDirection} → ${e.newDirection} | $${e.netUsd.toFixed(0)} flow`,
      );
    });
  }

  /**
   * Track an entry failure reason with size limit
   */
  private trackFailureReason(reason: string): void {
    this.diagnostics.entryFailureReasons.push(reason);
    if (
      this.diagnostics.entryFailureReasons.length > this.MAX_FAILURE_REASONS
    ) {
      this.diagnostics.entryFailureReasons.shift();
    }
  }

  /**
   * Initialize the engine
   */
  async initialize(): Promise<boolean> {
    console.log("");
    console.log("═".repeat(60));
    console.log("  🤖 POLYMARKET BOT");
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
    const errors = this.deps.validateConfig(this.config);
    if (errors.length > 0) {
      for (const err of errors) {
        console.error(`❌ Config error: ${err.field} - ${err.message}`);
      }
      return false;
    }

    // Log effective config
    this.deps.logConfig(this.config, (msg) => console.log(msg));

    // Setup VPN if configured
    await this.setupVpn();

    // Initialize Telegram
    if (this.config.telegramBotToken && this.config.telegramChatId) {
      initTelegram();
      console.log("📱 Telegram alerts enabled");
    }

    // Initialize GitHub Error Reporter
    const githubReporter = initGitHubReporter({});
    if (githubReporter.isEnabled()) {
      console.log("📋 GitHub error reporting enabled");
    } else {
      // Help user understand why it's disabled
      const hasToken = !!process.env.GITHUB_ERROR_REPORTER_TOKEN;
      const hasRepo = !!process.env.GITHUB_ERROR_REPORTER_REPO;
      const explicitlyDisabled =
        process.env.GITHUB_ERROR_REPORTER_ENABLED === "false";

      if (explicitlyDisabled) {
        console.log(
          "📋 GitHub error reporting disabled (GITHUB_ERROR_REPORTER_ENABLED=false)",
        );
      } else if (hasToken && !hasRepo) {
        console.log(
          "📋 GitHub error reporting disabled - GITHUB_ERROR_REPORTER_REPO not set",
        );
        console.log(
          "   ↳ Set GITHUB_ERROR_REPORTER_REPO=owner/repo-name to enable",
        );
      } else if (!hasToken && hasRepo) {
        console.log(
          "📋 GitHub error reporting disabled - GITHUB_ERROR_REPORTER_TOKEN not set",
        );
      } else if (!hasToken && !hasRepo) {
        // Neither set - user probably doesn't want it, stay quiet
      }
    }

    // Start latency monitoring - CRITICAL for slippage calculation!
    this.latencyMonitor.start();
    console.log("⏱️ Latency monitoring enabled (dynamic slippage adjustment)");

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
    // INITIALIZE BALANCE CACHE (RPC throttling to reduce Infura calls)
    // ═══════════════════════════════════════════════════════════════════════
    this.balanceCache = initBalanceCache(
      this.wallet,
      this.address,
      this.config.balanceRefreshIntervalMs,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // INITIALIZE WEBSOCKET MARKET DATA LAYER
    // ═══════════════════════════════════════════════════════════════════════
    // Initialize market data store and facade for real-time orderbook streaming
    initMarketDataStore();
    this.marketDataFacade = initMarketDataFacade(this.client);

    // Setup WebSocket bypass (before VPN changes default routes)
    // WebSocket traffic is read-only and doesn't need VPN protection
    await setupWebSocketBypass(this.logger);

    // Initialize WebSocket client for market data streaming
    const wsMarketClient = initWebSocketMarketClient({
      onConnect: () => {
        console.log(
          "📡 CLOB WebSocket connected (real-time orderbook streaming)",
        );
      },
      onDisconnect: (code, reason) => {
        console.log(`📡 CLOB WebSocket disconnected: ${code} - ${reason}`);
      },
      onError: (err) => {
        console.warn(`📡 CLOB WebSocket error: ${err.message}`);
      },
    });

    // Connect WebSocket (will auto-reconnect on failure)
    wsMarketClient.connect();

    // TODO: When implementing or updating ChurnEngine.stop(), ensure both
    //       the market and user WebSocket clients are cleanly disconnected
    //       and any heartbeat/reconnect timers are stopped to avoid leaks.

    // Initialize User WebSocket for order/fill events (authenticated)
    // Note: User WebSocket is optional - system continues without it but
    // will rely on polling for order status updates
    const wsUserClient = getWebSocketUserClient();
    wsUserClient.connect(this.client).catch((err) => {
      // Log at error level since this affects order tracking functionality
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `📡 User WebSocket connection failed (order tracking degraded): ${msg}`,
      );
      console.log(
        `   ↳ Order/fill events will fall back to polling-based detection`,
      );

      // Schedule a delayed retry attempt (30 seconds)
      setTimeout(() => {
        console.log(`📡 Retrying User WebSocket connection...`);
        if (this.client) {
          wsUserClient.connect(this.client).catch((retryErr) => {
            const retryMsg =
              retryErr instanceof Error ? retryErr.message : String(retryErr);
            console.error(`📡 User WebSocket retry failed: ${retryMsg}`);
            // After retry failure, the built-in reconnection logic will continue attempts
          });
        }
      }, 30000);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // STARTUP REDEMPTION - Collect any settled positions first
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🎁 Checking for redeemable positions...");
    await this.processRedemptions();
    this.lastRedeemTime = Date.now(); // Reset timer after startup redemption

    // Get balances AFTER redemption (initial fetch via cache)
    const { usdc: usdcBalance, pol: polBalance } =
      await this.balanceCache!.getBalances();
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
      console.warn(
        `⚠️ Could not fetch existing positions: ${err instanceof Error ? err.message : err}`,
      );
    }

    console.log("");
    console.log(
      `💰 Balance: $${usdcBalance.toFixed(2)} USDC | ${polBalance.toFixed(4)} POL`,
    );
    console.log(
      `🏦 Reserve: $${reserveUsd.toFixed(2)} | Effective: $${effectiveBankroll.toFixed(2)}`,
    );
    if (existingPositions.length > 0) {
      console.log(
        `📦 Existing Positions: ${existingPositions.length} (value: $${positionValue.toFixed(2)})`,
      );
    }
    console.log(
      `${this.config.liveTradingEnabled ? "🟢" : "🔴"} Mode: ${this.config.liveTradingEnabled ? "LIVE TRADING" : "SIMULATION"}`,
    );
    console.log("");

    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDATION MODE - Force sell positions based on mode
    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDATION_MODE=losing - Only sell positions with negative P&L
    // LIQUIDATION_MODE=all - Sell all positions regardless of P&L
    // FORCE_LIQUIDATION=true (legacy) - Same as LIQUIDATION_MODE=all
    if (this.config.liquidationMode !== "off" && existingPositions.length > 0) {
      // Filter positions based on liquidation mode
      const positionsToLiquidate =
        this.config.liquidationMode === "losing"
          ? existingPositions.filter((p) => p.pnlPct < 0)
          : existingPositions;

      const liquidateValue = positionsToLiquidate.reduce(
        (sum, p) => sum + p.value,
        0,
      );
      const modeDesc =
        this.config.liquidationMode === "losing" ? "LOSING ONLY" : "ALL";

      if (positionsToLiquidate.length > 0) {
        console.log("━".repeat(60));
        console.log(`🔥 LIQUIDATION MODE ACTIVATED (${modeDesc})`);
        console.log("━".repeat(60));
        console.log(
          `   Mode: ${this.config.liquidationMode === "losing" ? "Selling losing positions only" : "Selling ALL positions"}`,
        );
        console.log(`   Current balance: $${usdcBalance.toFixed(2)}`);
        console.log(
          `   Total positions: ${existingPositions.length} (worth $${positionValue.toFixed(2)})`,
        );
        console.log(
          `   To liquidate: ${positionsToLiquidate.length} (worth $${liquidateValue.toFixed(2)})`,
        );
        console.log("━".repeat(60));
        console.log("");

        this.liquidationMode = true;

        if (isTelegramEnabled()) {
          await sendTelegram(
            `🔥 Liquidation Mode (${modeDesc})`,
            `Balance: $${usdcBalance.toFixed(2)}\n` +
              `Total positions: ${existingPositions.length} ($${positionValue.toFixed(2)})\n` +
              `To liquidate: ${positionsToLiquidate.length} ($${liquidateValue.toFixed(2)})`,
          ).catch(() => {});
        }

        return true;
      } else {
        console.log(
          `ℹ️ Liquidation mode (${modeDesc}) enabled but no matching positions to sell`,
        );
      }
    }

    // If no effective bankroll and positions exist, suggest enabling liquidation
    if (effectiveBankroll <= 0) {
      if (existingPositions.length > 0) {
        console.error("❌ No effective bankroll available");
        console.error(
          `   You have ${existingPositions.length} positions worth $${positionValue.toFixed(2)}`,
        );
        console.error(
          `   Set LIQUIDATION_MODE=all to sell all, or LIQUIDATION_MODE=losing to sell only losing positions`,
        );
        return false;
      } else {
        console.error("❌ No effective bankroll available");
        console.error(`   Deposit more USDC or wait for positions to settle`);
        return false;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ON-CHAIN MONITORING - Real-time whale trade detection via WebSocket
    // Runs completely in PARALLEL - does NOT block the main loop
    // ═══════════════════════════════════════════════════════════════════════
    if (this.config.onchainMonitorEnabled) {
      // Fire and forget - don't await, let it run in parallel
      this.initializeOnChainMonitor().catch((err) => {
        console.warn(
          `⚠️ On-chain monitor background init failed: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    // Send startup notification
    if (isTelegramEnabled()) {
      await sendTelegram(
        "🤖 Polymarket Bot Started",
        `Balance: $${usdcBalance.toFixed(2)}\n` +
          `Reserve: $${reserveUsd.toFixed(2)}\n` +
          `Effective: $${effectiveBankroll.toFixed(2)}\n` +
          `${this.config.liveTradingEnabled ? "🟢 LIVE" : "🔴 SIM"}`,
      ).catch(() => {});
    }

    return true;
  }

  /**
   * Initialize on-chain monitor for position monitoring and settlement verification
   * Connects to CTF Exchange contract via Infura WebSocket
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠️ NOTE: On-chain monitor is now LIMITED to:
   * - Position change monitoring (when our orders fill)
   * - Settlement verification and reconciliation
   *
   * On-chain is NOT used for primary whale detection because:
   * - Data API is actually faster (CLOB updates API before settlement)
   * - On-chain sees trades AFTER they've been matched on CLOB
   * - Use BiasAccumulator with Data API polling for whale detection
   * ═══════════════════════════════════════════════════════════════════════════
   */
  private async initializeOnChainMonitor(): Promise<void> {
    try {
      // Fetch initial leaderboard in parallel with other startup tasks
      // The BiasAccumulator will update the whale wallets Set
      await this.biasAccumulator.refreshLeaderboard();

      // Create on-chain monitor config - shares the whale wallets Set reference
      // When BiasAccumulator refreshes wallets, the monitor automatically sees updates
      // Also pass our wallet address for position monitoring
      const monitorConfig = createOnChainMonitorConfig(
        this.config.rpcUrl,
        this.biasAccumulator.getWhaleWallets(), // Shared reference - auto-updates!
        this.address, // Our wallet - for position monitoring
        {
          enabled: this.config.onchainMonitorEnabled,
          minWhaleTradeUsd: this.config.onchainMinWhaleTradeUsd,
          infuraTier: this.config.infuraTier,
        },
      );

      this.onchainMonitor = new OnChainMonitor(monitorConfig);

      // ═══════════════════════════════════════════════════════════════════════
      // WHALE TRADE CALLBACK - SECONDARY to Data API (for reconciliation only)
      // NOTE: On-chain signals are NOT faster than Data API for Polymarket
      // because CLOB updates the API before settling trades on-chain.
      // This callback is kept for verification/debugging purposes only.
      // PRIMARY whale detection should use BiasAccumulator with Data API polling.
      // ═══════════════════════════════════════════════════════════════════════
      this.onchainMonitor.onWhaleTrade((trade) => {
        // Log whale trades for debugging/reconciliation only
        // This is SECONDARY - Data API polling is the primary source
        console.log(
          `📡 [Reconciliation] On-chain whale ${trade.side} | $${trade.sizeUsd.toFixed(0)} @ ${(trade.price * 100).toFixed(1)}¢ | Block #${trade.blockNumber}`,
        );

        // Only record BUY trades for bias (we copy buys, not sells)
        if (trade.side === "BUY") {
          // Determine which address is the whale with defensive validation
          const whaleWallets = this.biasAccumulator.getWhaleWallets();
          const makerLower = trade.maker.toLowerCase();
          const takerLower = trade.taker.toLowerCase();

          let whaleWallet: string | null = null;
          if (whaleWallets.has(makerLower)) {
            whaleWallet = trade.maker;
          } else if (whaleWallets.has(takerLower)) {
            whaleWallet = trade.taker;
          } else {
            // Defensive: on-chain monitor emitted a whale trade but neither
            // participant is currently in the whale set. This can happen due
            // to leaderboard refresh timing. Skip to avoid misattributing.
            console.log(`   ⚠️ Whale not in current tracking set, skipping`);
            return;
          }

          // Feed to bias accumulator as SECONDARY signal
          // Deduplication prevents double-counting with Data API signals
          this.biasAccumulator.recordTrade({
            tokenId: trade.tokenId,
            wallet: whaleWallet,
            side: "BUY",
            sizeUsd: trade.sizeUsd,
            timestamp: trade.timestamp,
            price: trade.price, // Include price for price-range filtering
          });

          console.log(`   ℹ️ On-chain signal recorded (secondary to Data API)`);
        } else {
          console.log(`   ℹ️ SELL trade - not copying (we only copy buys)`);
        }
      });

      // ═══════════════════════════════════════════════════════════════════════
      // POSITION CHANGE CALLBACK - Real-time position monitoring
      // See our fills instantly at blockchain level!
      // ═══════════════════════════════════════════════════════════════════════
      this.onchainMonitor.onPositionChange((change) => {
        if (change.isIncoming) {
          // We received tokens - likely an order filled!
          console.log(
            `⚡ Position FILLED | +${change.amountFormatted.toFixed(2)} tokens | Block #${change.blockNumber}`,
          );

          // Invalidate position cache to force refresh
          invalidatePositions();
        } else {
          // We sent tokens - we sold or transferred
          console.log(
            `⚡ Position SOLD | -${change.amountFormatted.toFixed(2)} tokens | Block #${change.blockNumber}`,
          );

          // Invalidate position cache
          invalidatePositions();
        }
      });

      // Start the monitor - WebSocket runs in background, events fire in parallel
      const started = await this.onchainMonitor.start();
      if (started) {
        const stats = this.onchainMonitor.getStats();
        console.log(
          `📡 On-chain monitor: Infura ${stats.infuraTier} tier | Position monitoring: ${stats.monitoringOwnPositions ? "ON" : "OFF"}`,
        );
        console.log(
          `📡 On-chain role: Position verification & reconciliation (NOT primary whale detection)`,
        );
      }
    } catch (err) {
      console.warn(
        `⚠️ On-chain monitor init failed: ${err instanceof Error ? err.message : err}`,
      );
      console.warn(
        `   Position monitoring disabled, but whale detection via Data API still works`,
      );
    }
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
      // Step 1: Capture pre-VPN routing BEFORE starting VPN
      capturePreVpnRouting();

      // Step 2: Emit VPN_ROUTING_POLICY_PRE event BEFORE VPN starts
      emitRoutingPolicyPreEvent(this.logger);

      // Step 3: Start VPN
      if (wgEnabled) {
        console.log("🔒 Starting WireGuard...");
        await startWireguard();
        console.log("🔒 WireGuard connected");
      } else if (ovpnEnabled) {
        console.log("🔒 Starting OpenVPN...");
        await startOpenvpn();
        console.log("🔒 OpenVPN connected");
      }

      // Step 4: CRITICAL - Ensure WRITE hosts route through VPN IMMEDIATELY
      // This proactively adds routes for clob.polymarket.com (and other WRITE_HOSTS)
      // through the VPN interface, preventing WRITE_ROUTE_MISMATCH warnings.
      console.log("🔒 Ensuring WRITE hosts route through VPN...");
      const writeRouteResult = ensureWriteHostVpnRoutes(this.logger);
      if (writeRouteResult.attempted) {
        if (writeRouteResult.success) {
          console.log(
            `✅ WRITE hosts routed through VPN (${writeRouteResult.results.length} hosts, interface: ${writeRouteResult.vpnInterface})`,
          );
        } else {
          console.warn(
            `⚠️ Some WRITE host routes failed - orders may be geo-blocked`,
          );
        }
      }

      // Step 5: Setup bypass routes for READ/RPC traffic
      // Use getEnvBool to properly apply defaults when env vars are unset
      const bypassRpc = getEnvBool(
        "VPN_BYPASS_RPC",
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
        this.logger,
      );
      if (bypassRpc) {
        await setupRpcBypass(this.config.rpcUrl, this.logger);
      }

      // Bypass read-only Polymarket APIs (gamma-api, data-api) ONLY when explicitly enabled.
      // DEFAULT: false - all Polymarket reads go through VPN for safety.
      // Set VPN_BYPASS_POLYMARKET_READS=true to bypass VPN for reads (faster but less safe).
      const bypassPolymarketReads = getEnvBool(
        "VPN_BYPASS_POLYMARKET_READS",
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
        this.logger,
      );
      if (bypassPolymarketReads) {
        await setupPolymarketReadBypass(this.logger);
      }

      // Step 6: Emit VPN_ROUTING_POLICY_EFFECTIVE event AFTER VPN is up and bypass routes are applied
      emitRoutingPolicyEffectiveEvent(this.logger);
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
      // In liquidation mode, use configurable slower interval to avoid rate limits
      const openCount = this.positionManager.getOpenPositions().length;
      const pollInterval = this.liquidationMode
        ? this.config.liquidationPollIntervalMs
        : openCount > 0
          ? this.config.positionPollIntervalMs // 100ms - track positions fast
          : this.config.pollIntervalMs; // 200ms - scan for opportunities

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
    // 1. REDEEM SETTLED POSITIONS FIRST (every cycle in liquidation mode!)
    // In liquidation mode, we want to redeem aggressively - every cycle
    // This includes $0 value positions (losers) that need to be cleared
    // ─────────────────────────────────────────────────────────────────
    // Run redemption every 60 seconds in liquidation mode (vs 10 min normally)
    const LIQUIDATION_REDEEM_INTERVAL_MS = 60 * 1000; // 1 minute
    if (now - this.lastRedeemTime >= LIQUIDATION_REDEEM_INTERVAL_MS) {
      console.log("🎁 Checking for redeemable positions (liquidation mode)...");
      await this.processRedemptions();
      this.lastRedeemTime = now;
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. GET BALANCES (via cache to reduce RPC calls)
    // ─────────────────────────────────────────────────────────────────
    const { usdc: usdcBalance } = await this.balanceCache!.getBalances();
    const { reserveUsd } =
      this.executionEngine.getEffectiveBankroll(usdcBalance);

    // ─────────────────────────────────────────────────────────────────
    // 3. FETCH AND LIQUIDATE EXISTING POLYMARKET POSITIONS
    // ─────────────────────────────────────────────────────────────────
    let positions: Position[] = [];
    try {
      positions = await getPositions(this.address, true);
    } catch (err) {
      console.warn(
        `⚠️ Could not fetch positions: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (positions.length === 0) {
      // ─────────────────────────────────────────────────────────────────
      // LIQUIDATION COMPLETE - Transition back to normal trading
      // ─────────────────────────────────────────────────────────────────
      const { effectiveBankroll } =
        this.dynamicReserveManager.getEffectiveBankroll(usdcBalance);

      if (effectiveBankroll > 0) {
        console.log("");
        console.log("━".repeat(60));
        console.log("✅ LIQUIDATION COMPLETE - Resuming normal trading");
        console.log("━".repeat(60));
        console.log(`   All positions sold!`);
        console.log(`   Balance: $${usdcBalance.toFixed(2)}`);
        console.log(`   Effective bankroll: $${effectiveBankroll.toFixed(2)}`);
        console.log("━".repeat(60));
        console.log("");

        // Reset liquidation mode and dynamic reserves
        this.liquidationMode = false;
        this.recentlySoldPositions.clear();
        this.dynamicReserveManager.reset();

        if (isTelegramEnabled()) {
          await sendTelegram(
            "✅ Liquidation Complete",
            `All positions sold!\nBalance: $${usdcBalance.toFixed(2)}\nResuming normal trading...`,
          ).catch(() => {});
        }

        return; // Next cycle will be normal trading
      } else {
        console.log("📦 No positions to liquidate");
        console.log(
          `   Balance: $${usdcBalance.toFixed(2)} (need $${reserveUsd.toFixed(2)} for trading)`,
        );
        console.log(`   Waiting for deposits or position settlements...`);
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // FILTER POSITIONS BASED ON LIQUIDATION MODE
    // ─────────────────────────────────────────────────────────────────
    // "losing" mode: Only liquidate positions with negative P&L
    // "all" mode: Liquidate all positions
    const modeFilteredPositions =
      this.config.liquidationMode === "losing"
        ? positions.filter((p) => p.pnlPct < 0)
        : positions;

    if (
      modeFilteredPositions.length === 0 &&
      this.config.liquidationMode === "losing"
    ) {
      // All remaining positions are winners - exit liquidation mode
      const { effectiveBankroll } =
        this.dynamicReserveManager.getEffectiveBankroll(usdcBalance);

      console.log("");
      console.log("━".repeat(60));
      console.log(
        "✅ LIQUIDATION COMPLETE (losers only) - Resuming normal trading",
      );
      console.log("━".repeat(60));
      console.log(`   All losing positions sold!`);
      console.log(
        `   Remaining winners: ${positions.length} (will be managed normally)`,
      );
      console.log(`   Balance: $${usdcBalance.toFixed(2)}`);
      console.log(`   Effective bankroll: $${effectiveBankroll.toFixed(2)}`);
      console.log("━".repeat(60));
      console.log("");

      // Reset liquidation mode
      this.liquidationMode = false;
      this.recentlySoldPositions.clear();
      this.dynamicReserveManager.reset();

      if (isTelegramEnabled()) {
        await sendTelegram(
          "✅ Losers Liquidated",
          `All losing positions sold!\nRemaining winners: ${positions.length}\nBalance: $${usdcBalance.toFixed(2)}\nResuming normal trading...`,
        ).catch(() => {});
      }

      return;
    }

    // Clean up expired cooldowns
    for (const [tokenId, soldTime] of this.recentlySoldPositions) {
      if (now - soldTime >= this.SOLD_POSITION_COOLDOWN_MS) {
        this.recentlySoldPositions.delete(tokenId);
      }
    }

    // Filter out positions that were recently sold (waiting for API cache to update)
    const eligiblePositions = modeFilteredPositions.filter((p) => {
      const soldTime = this.recentlySoldPositions.get(p.tokenId);
      if (soldTime && now - soldTime < this.SOLD_POSITION_COOLDOWN_MS) {
        return false; // Skip - recently sold, waiting for API to reflect
      }
      return true;
    });

    // Sort by value descending - sell largest positions first for fastest capital recovery
    const sortedPositions = [...eligiblePositions].sort(
      (a, b) => b.value - a.value,
    );

    if (sortedPositions.length === 0) {
      const cooldownCount =
        modeFilteredPositions.length - eligiblePositions.length;
      console.log(
        `⏳ Waiting for ${cooldownCount} recent sell(s) to settle...`,
      );
      return;
    }

    const modeLabel =
      this.config.liquidationMode === "losing" ? " (losing)" : "";
    console.log(
      `🔥 Liquidating ${sortedPositions.length} positions${modeLabel} (total value: $${sortedPositions.reduce((s, p) => s + p.value, 0).toFixed(2)})`,
    );

    // Sell one position per cycle to avoid overwhelming the API
    const positionToSell = sortedPositions[0];
    if (positionToSell) {
      console.log(
        `📤 Selling: $${positionToSell.value.toFixed(2)} @ ${(positionToSell.curPrice * 100).toFixed(1)}¢ (P&L: ${positionToSell.pnlPct >= 0 ? "+" : ""}${positionToSell.pnlPct.toFixed(1)}%)`,
      );

      if (!this.config.liveTradingEnabled) {
        console.log(
          `   [SIM] Would sell ${positionToSell.size.toFixed(2)} shares`,
        );
      } else if (!this.client) {
        console.warn(`   ⚠️ No client available for selling`);
      } else {
        try {
          const result = await smartSell(this.client, positionToSell, {
            maxSlippagePct: this.config.liquidationMaxSlippagePct,
            forceSell: true, // Force sell even if conditions aren't ideal
            logger: this.logger,
          });

          if (result.success) {
            console.log(
              `   ✅ Sold for $${result.filledUsd?.toFixed(2) || "unknown"}`,
            );

            // Track this position as recently sold to prevent re-selling
            // while waiting for position API to reflect the change
            this.recentlySoldPositions.set(positionToSell.tokenId, now);

            // Invalidate position cache to ensure fresh data on next fetch
            invalidatePositions();

            // Force balance refresh after successful liquidation sale
            this.balanceCache?.forceRefresh().catch(() => {});

            if (isTelegramEnabled()) {
              await sendTelegram(
                "🔥 Position Liquidated",
                `Sold: $${result.filledUsd?.toFixed(2) || positionToSell.value.toFixed(2)}\n` +
                  `P&L: ${positionToSell.pnlPct >= 0 ? "+" : ""}${positionToSell.pnlPct.toFixed(1)}%`,
              ).catch(() => {});
            }
          } else {
            // If sell failed due to balance issue, the position might already be sold
            // (API cache delay). Add to cooldown to prevent spamming the same position.
            // This also helps avoid rate limiting when there's a genuine issue.
            if (
              result.reason === "INSUFFICIENT_BALANCE" ||
              result.reason === "INSUFFICIENT_ALLOWANCE"
            ) {
              console.log(
                `   ⏳ Adding to cooldown (likely already sold, waiting for API update)`,
              );
              this.recentlySoldPositions.set(positionToSell.tokenId, now);
            }
            console.log(`   ❌ Sell failed: ${result.reason}`);
          }
        } catch (err) {
          console.warn(
            `   ⚠️ Sell error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    // Status update
    if (now - this.lastSummaryTime >= this.SUMMARY_INTERVAL_MS) {
      const totalValue = positions.reduce((s, p) => s + p.value, 0);
      console.log("");
      console.log(`📊 LIQUIDATION STATUS`);
      console.log(
        `   Balance: $${usdcBalance.toFixed(2)} | Need: $${reserveUsd.toFixed(2)}`,
      );
      console.log(
        `   Positions remaining: ${positions.length} ($${totalValue.toFixed(2)})`,
      );
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
   * 4. Scan active markets for opportunities
   * 5. Enter if bias allows OR scanned opportunity available
   * 6. Periodic housekeeping
   */
  private async cycle(): Promise<void> {
    this.cycleCount++;
    const now = Date.now();

    // ─────────────────────────────────────────────────────────────────
    // 1. PARALLEL FETCH: Balances (cached) + Whale Trades + Positions (when needed)
    // Balance fetches use the cache to reduce RPC calls (only fetches when stale)
    // ─────────────────────────────────────────────────────────────────
    const shouldSyncPositions = this.cycleCount % 10 === 0;
    const shouldScanMarkets =
      this.config.scanActiveMarkets &&
      now - this.lastScanTime >= this.config.scanIntervalSeconds * 1000;

    // Build parallel tasks array
    const parallelTasks: Promise<any>[] = [
      // Get balances via cache (only fetches from RPC when interval expires)
      this.balanceCache!.getBalances(),
      // Always poll whale trades (primary detection method)
      this.biasAccumulator.fetchLeaderboardTrades(),
    ];

    // Conditionally add position sync
    if (shouldSyncPositions) {
      parallelTasks.push(getPositions(this.address, true).catch(() => []));
    }

    // Conditionally add market scan
    if (shouldScanMarkets) {
      const scanPromise = this.volumeScanner
        .scanActiveMarkets()
        .then(() => {
          // Only advance lastScanTime if the scan completes successfully
          this.lastScanTime = now;
        })
        .catch(() => {
          // Preserve existing behavior: swallow scan errors so they don't break the cycle
        });
      parallelTasks.push(scanPromise);
    }

    // Execute all in parallel
    const results = await Promise.all(parallelTasks);

    // Unpack results - balance cache returns { usdc, pol }
    const { usdc: usdcBalance, pol: polBalance } = results[0] as {
      usdc: number;
      pol: number;
    };
    const newTrades = results[1] as LeaderboardTrade[];
    const allPositions: Position[] = shouldSyncPositions
      ? (results[2] as Position[]) || []
      : [];

    // Use dynamic reserves for effective bankroll calculation
    const { effectiveBankroll } =
      this.dynamicReserveManager.getEffectiveBankroll(usdcBalance);

    if (effectiveBankroll <= 0) {
      // No effective bankroll available this cycle; skip trading logic
      return; // No money to trade
    }

    // Log whale trade detections
    if (newTrades.length > 0) {
      console.log(`🐋 [API] Detected ${newTrades.length} new whale trade(s)!`);
      this.diagnostics.whaleTradesDetected += newTrades.length;
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. SYNC EXTERNAL POSITIONS (if we fetched them this cycle)
    // ─────────────────────────────────────────────────────────────────
    if (shouldSyncPositions && allPositions.length > 0) {
      // Register any untracked positions with the position manager
      // Run registrations in parallel too
      const registrationPromises = allPositions
        .filter(
          (pos) =>
            this.positionManager.getPositionsByToken(pos.tokenId).length === 0,
        )
        .map((pos) =>
          this.positionManager.registerExternalPosition(pos).catch(() => {}),
        );

      if (registrationPromises.length > 0) {
        await Promise.all(registrationPromises);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 3. PROCESS EXITS FOR OPEN POSITIONS
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
    // 4. GET SCANNED OPPORTUNITIES (already fetched in parallel above)
    // ─────────────────────────────────────────────────────────────────
    let scannedOpportunities: string[] = [];
    if (this.config.scanActiveMarkets) {
      scannedOpportunities = this.volumeScanner.getActiveTokenIds();
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. ENTER IF BIAS ALLOWS OR SCANNED OPPORTUNITY AVAILABLE
    // ─────────────────────────────────────────────────────────────────
    const evAllowed = this.evTracker.isTradingAllowed();
    const activeBiases = this.biasAccumulator.getActiveBiases();

    // Debug: show all active biases before filtering
    if (this.deps.isDebugEnabled() && activeBiases.length > 0) {
      this.deps.debug(
        `Active biases before cooldown filter: ${activeBiases.length}`,
      );
      for (const bias of activeBiases.slice(0, 5)) {
        const onCooldown = this.failedEntryCooldowns.has(bias.tokenId);
        this.deps.debug(
          `  ${bias.tokenId.slice(0, 12)}... | dir: ${bias.direction} | $${bias.netUsd.toFixed(0)} flow | trades: ${bias.tradeCount} | cooldown: ${onCooldown}`,
        );
      }
    }

    // Clean up expired cooldowns
    for (const [tokenId, expiry] of this.failedEntryCooldowns.entries()) {
      if (now >= expiry) {
        this.deps.debug(`Cooldown expired for ${tokenId.slice(0, 12)}...`);
        this.failedEntryCooldowns.delete(tokenId);
      }
    }

    // Filter out tokens that don't meet bias criteria or are on cooldown
    // In copyAnyWhaleBuy mode: only check staleness (1 whale buy is enough)
    // In conservative mode: enforce full BIAS_MIN_NET_USD and BIAS_MIN_TRADES
    const eligibleBiases: TokenBias[] = [];
    let skippedStale = 0;
    let skippedTradesBelowMin = 0;
    let skippedFlowBelowMin = 0;
    let skippedCooldown = 0;

    for (const bias of activeBiases) {
      // Step 1: Check staleness (defensive check - getActiveBiases() already filters stale
      // biases in copyAnyWhaleBuy mode at line ~1556, but we check here for consistency
      // and to handle any edge cases in conservative mode)
      if (bias.isStale) {
        if (this.deps.isDebugEnabled() || this.cycleCount % 100 === 0) {
          console.log(
            `🚫 [REJECT_BIAS] ${bias.tokenId.slice(0, 12)}... | STALE | last activity: ${Math.round((now - bias.lastActivityTime) / 1000)}s ago`,
          );
        }
        skippedStale++;
        continue;
      }

      // Step 2: Check bias thresholds (only in conservative mode)
      // In copyAnyWhaleBuy mode, getActiveBiases() already filtered to 1+ trades
      // so we skip these additional checks to allow instant copy
      if (!this.config.copyAnyWhaleBuy) {
        if (bias.tradeCount < this.config.biasMinTrades) {
          if (this.deps.isDebugEnabled() || this.cycleCount % 100 === 0) {
            console.log(
              `🚫 [REJECT_BIAS] ${bias.tokenId.slice(0, 12)}... | TRADES_BELOW_MIN | trades=${bias.tradeCount} < min=${this.config.biasMinTrades}`,
            );
          }
          skippedTradesBelowMin++;
          continue;
        }

        if (Math.abs(bias.netUsd) < this.config.biasMinNetUsd) {
          if (this.deps.isDebugEnabled() || this.cycleCount % 100 === 0) {
            console.log(
              `🚫 [REJECT_BIAS] ${bias.tokenId.slice(0, 12)}... | FLOW_BELOW_MIN | flow=$${bias.netUsd.toFixed(0)} < min=$${this.config.biasMinNetUsd}`,
            );
          }
          skippedFlowBelowMin++;
          continue;
        }
      }

      // Step 3: Check cooldowns (only for bias-eligible tokens)
      const cooldownExpiry = this.failedEntryCooldowns.get(bias.tokenId);
      if (cooldownExpiry && now < cooldownExpiry) {
        skippedCooldown++;
        continue;
      }
      if (this.marketDataCooldownManager.isOnCooldown(bias.tokenId)) {
        skippedCooldown++;
        continue;
      }

      // Passed all checks - this bias is eligible for entry
      eligibleBiases.push(bias);
    }

    // Update funnel diagnostics
    this.diagnostics.funnel.biasesRejectedStale += skippedStale;
    this.diagnostics.funnel.biasesRejectedTrades += skippedTradesBelowMin;
    this.diagnostics.funnel.biasesRejectedFlow += skippedFlowBelowMin;
    this.diagnostics.funnel.biasesSkippedCooldown += skippedCooldown;
    this.diagnostics.funnel.eligibleSignals += eligibleBiases.length;

    // Calculate total rejections for summary log
    const skippedBiasCriteria =
      skippedStale + skippedTradesBelowMin + skippedFlowBelowMin;

    if (evAllowed.allowed) {
      if (eligibleBiases.length > 0) {
        // Log when we have active biases - helps diagnose trade detection
        const cooldownMsg =
          skippedCooldown > 0 ? ` (${skippedCooldown} on cooldown)` : "";
        const biasRejectMsg =
          skippedBiasCriteria > 0
            ? ` (${skippedBiasCriteria} rejected by bias criteria)`
            : "";
        console.log(
          `🐋 [Bias] ${eligibleBiases.length} eligible whale signals${cooldownMsg}${biasRejectMsg}`,
        );

        // TASK 3: Ensure WS subscribes to eligible bias tokens for real-time data
        // Only subscribe to tokens we'll actually attempt entry on (slice(0, 3))
        // This prevents WS subscription set from growing without bound
        const biasesToAttempt = eligibleBiases.slice(0, 3);
        try {
          const wsClient = getWebSocketMarketClient();
          if (wsClient.isConnected()) {
            const currentSubs = new Set(wsClient.getSubscriptions());
            const biasTokensToSubscribe = biasesToAttempt
              .map((b) => b.tokenId)
              .filter((id) => !currentSubs.has(id));
            if (biasTokensToSubscribe.length > 0) {
              wsClient.subscribe(biasTokensToSubscribe);
              this.deps.debug(
                `📡 [WS] Subscribed to ${biasTokensToSubscribe.length} whale signal tokens`,
              );
            }
          }
        } catch (wsErr) {
          // WS subscription failed - will use REST fallback in fetchTokenMarketDataWithReason
          this.deps.debug(
            `📡 [WS] Bias token subscription failed: ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`,
          );
        }

        // Execute whale-signal entries in parallel to avoid missing opportunities
        // when multiple whale signals arrive simultaneously.
        //
        // RACE CONDITION SAFEGUARD: The position manager enforces:
        // - maxOpenPositionsTotal (12) - hard limit on concurrent positions
        // - maxDeployedFractionTotal (30%) - max exposure cap
        // - maxOpenPositionsPerMarket (2) - per-token limit
        // These checks happen atomically in processEntry, preventing over-allocation.
        // Note: Cooldown filtering already done above (eligibleBiases), no duplicate check needed
        const entryPromises = biasesToAttempt.map(async (bias) => {
          // TASK 6: Track candidate in funnel
          this.diagnostics.candidatesSeen++;
          this.diagnostics.funnel.entryAttemptsFromBias++;

          this.diagnostics.entryAttempts++;
          this.deps.debug(
            `Attempting entry for ${bias.tokenId.slice(0, 12)}... (bias: ${bias.direction}, flow: $${bias.netUsd.toFixed(0)})`,
          );
          try {
            this.diagnostics.marketDataFetchAttempts++;

            const fetchResult = await this.fetchTokenMarketDataWithReason(
              bias.tokenId,
            );

            if (fetchResult.ok) {
              const marketData = fetchResult.data;
              this.diagnostics.marketDataFetchSuccesses++;
              // Reset cooldown on success
              this.marketDataCooldownManager.recordSuccess(bias.tokenId);

              this.deps.debug(
                `Market data: mid=${marketData.orderbook.midPriceCents}¢, spread=${marketData.orderbook.spreadCents}¢, bid=${marketData.orderbook.bestBidCents}¢, ask=${marketData.orderbook.bestAskCents}¢`,
              );
              const result = await this.executionEngine.processEntry(
                bias.tokenId,
                marketData,
                usdcBalance,
              );
              if (result.success) {
                this.diagnostics.entrySuccesses++;
                console.log(
                  `✅ [Entry] SUCCESS: Copied whale trade on ${bias.tokenId.slice(0, 12)}...`,
                );
                // Clear any cooldown on success
                this.failedEntryCooldowns.delete(bias.tokenId);
              } else {
                this.trackFailureReason(result.reason || "unknown");
                console.log(
                  `❌ [Entry] FAILED: ${bias.tokenId.slice(0, 12)}... - ${result.reason}`,
                );

                // Add to cooldown if failed due to price/liquidity issues (not bankroll)
                // This prevents spamming the same failing token repeatedly
                // TASK 5: Only cooldown for TRANSIENT errors (not permanent market conditions)
                if (this.deps.shouldCooldownOnFailure(result.reason)) {
                  this.failedEntryCooldowns.set(
                    bias.tokenId,
                    Date.now() + this.FAILED_ENTRY_COOLDOWN_MS,
                  );
                  console.log(
                    `   ⏳ Token on cooldown for ${this.config.entryCooldownSecondsTransient}s (transient error)`,
                  );
                }
              }
              // Track missed opportunities - check for actual reason strings from processEntry
              if (
                !result.success &&
                (result.reason === "NO_BANKROLL" ||
                  result.reason?.startsWith("Max deployed") ||
                  result.reason === "No effective bankroll")
              ) {
                this.dynamicReserveManager.recordMissedOpportunity(
                  bias.tokenId,
                  this.config.maxTradeUsd,
                  "RESERVE_BLOCKED",
                );
              }
              return result;
            } else {
              // Handle structured failure with appropriate cooldown
              const { reason, detail } = fetchResult;

              // TASK 6: Track rejection reasons in funnel
              if (
                reason === "INVALID_LIQUIDITY" ||
                reason === "DUST_BOOK" ||
                reason === "INVALID_PRICES"
              ) {
                this.diagnostics.candidatesRejectedLiquidity++;
              }

              // TASK 5: Only cooldown transient errors, NOT permanent market conditions
              // Permanent conditions (dust books, invalid liquidity, invalid prices) should NOT cooldown
              const isPermanentCondition =
                reason === "INVALID_LIQUIDITY" ||
                reason === "DUST_BOOK" ||
                reason === "INVALID_PRICES";

              if (!isPermanentCondition) {
                const cooldownMs = this.marketDataCooldownManager.recordFailure(
                  bias.tokenId,
                  reason,
                );
                const info = this.marketDataCooldownManager.getCooldownInfo(
                  bias.tokenId,
                );

                this.trackFailureReason(`NO_MARKET_DATA:${reason}`);

                // Only log for long cooldowns (NO_ORDERBOOK/NOT_FOUND) or periodically for transient errors
                if (shouldApplyLongCooldown(reason)) {
                  console.log(
                    `⚠️ [Entry] No market data for ${bias.tokenId.slice(0, 12)}... | reason: ${reason} | strike ${info?.strikes || 1} | cooldown: ${MarketDataCooldownManager.formatDuration(cooldownMs)}`,
                  );
                } else if (this.cycleCount % 20 === 0) {
                  console.warn(
                    `⚠️ [Entry] Transient error for ${bias.tokenId.slice(0, 12)}... | ${reason}: ${detail?.slice(0, 50) || "unknown"} | retry in ${MarketDataCooldownManager.formatDuration(cooldownMs)}`,
                  );
                }
              } else {
                // Permanent condition - log but don't cooldown
                this.trackFailureReason(`NO_MARKET_DATA:${reason}`);
                if (this.cycleCount % 20 === 0) {
                  console.log(
                    `⚠️ [Entry] Permanent condition for ${bias.tokenId.slice(0, 12)}... | ${reason}: ${detail?.slice(0, 50) || "unknown"} | no cooldown`,
                  );
                }
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.trackFailureReason(`ERROR: ${errMsg}`);
            console.warn(
              `⚠️ Entry failed for ${bias.tokenId.slice(0, 8)}...: ${errMsg}`,
            );
          }
          return null;
        });

        await Promise.all(entryPromises);
      } else if (activeBiases.length > 0 && eligibleBiases.length === 0) {
        // All biases are filtered out - only log occasionally
        if (this.cycleCount % 30 === 0) {
          const reasonDetail =
            skippedBiasCriteria > 0 && skippedCooldown > 0
              ? `${skippedBiasCriteria} rejected by bias criteria, ${skippedCooldown} on cooldown`
              : skippedBiasCriteria > 0
                ? `${skippedBiasCriteria} rejected by bias criteria`
                : `${skippedCooldown} on cooldown`;
          console.log(
            `⏳ [Bias] ${activeBiases.length} whale signals filtered (${reasonDetail})`,
          );
        }
      } else if (
        scannedOpportunities.length > 0 &&
        this.config.scanActiveMarkets
      ) {
        // No whale signals - scan for trades from active markets
        // Filter out tokens on cooldown (both price/liquidity and market data cooldowns)
        const eligibleScanned = scannedOpportunities.filter((tokenId) => {
          const cooldownExpiry = this.failedEntryCooldowns.get(tokenId);
          if (cooldownExpiry && now < cooldownExpiry) return false;
          if (this.marketDataCooldownManager.isOnCooldown(tokenId))
            return false;
          return true;
        });

        // Only log occasionally to avoid spam
        if (this.cycleCount % 50 === 0 && eligibleScanned.length > 0) {
          console.log(
            `🔍 No active whale signals - scanning ${eligibleScanned.length} active markets for opportunities...`,
          );
        }

        // TASK 3: Ensure WS subscribes to scanned tokens for real-time data
        try {
          const wsClient = getWebSocketMarketClient();
          if (wsClient.isConnected()) {
            const currentSubs = new Set(wsClient.getSubscriptions());
            const scannedToSubscribe = eligibleScanned
              .slice(0, 2)
              .filter((id) => !currentSubs.has(id));
            if (scannedToSubscribe.length > 0) {
              wsClient.subscribe(scannedToSubscribe);
              this.deps.debug(
                `📡 [WS] Subscribed to ${scannedToSubscribe.length} scanned tokens`,
              );
            }
          }
        } catch (wsErr) {
          // WS subscription failed - will use REST fallback
          this.deps.debug(
            `📡 [WS] Scanned token subscription failed: ${wsErr instanceof Error ? wsErr.message : String(wsErr)}`,
          );
        }

        // Try top scanned markets (limit to avoid rate limiting)
        // Note: Cooldown filtering already done above (eligibleScanned), no duplicate check needed
        const scannedEntryPromises = eligibleScanned
          .slice(0, 2)
          .map(async (tokenId) => {
            this.diagnostics.entryAttempts++;
            try {
              // Check if we already have a position in this market
              const existingPositions =
                this.positionManager.getPositionsByToken(tokenId);
              if (existingPositions.length > 0) return null;

              this.diagnostics.marketDataFetchAttempts++;
              const fetchResult =
                await this.fetchTokenMarketDataWithReason(tokenId);

              if (fetchResult.ok) {
                const marketData = fetchResult.data;
                this.diagnostics.marketDataFetchSuccesses++;
                // Reset cooldown on success
                this.marketDataCooldownManager.recordSuccess(tokenId);

                // For scanned markets, bypass bias check since these are high-volume
                // markets selected by the scanner based on activity metrics
                const result = await this.executionEngine.processEntry(
                  tokenId,
                  marketData,
                  usdcBalance,
                  true,
                );
                if (result.success) {
                  this.diagnostics.entrySuccesses++;
                  console.log(
                    `✅ [Scanner] SUCCESS: Entered scanned market ${tokenId.slice(0, 12)}...`,
                  );
                  this.failedEntryCooldowns.delete(tokenId);
                } else {
                  this.trackFailureReason(
                    `SCAN: ${result.reason || "unknown"}`,
                  );
                  // Add to cooldown if failed due to price/liquidity issues
                  // TASK 5: Only cooldown for TRANSIENT errors
                  if (this.deps.shouldCooldownOnFailure(result.reason)) {
                    this.failedEntryCooldowns.set(
                      tokenId,
                      Date.now() + this.FAILED_ENTRY_COOLDOWN_MS,
                    );
                    console.log(
                      `⏳ [Scanner] Token ${tokenId.slice(0, 12)}... on cooldown for ${this.config.entryCooldownSecondsTransient}s`,
                    );
                  }
                  // Only log scan failures periodically to avoid spam
                  if (this.cycleCount % 20 === 0) {
                    console.log(
                      `❌ [Scanner] FAILED: ${tokenId.slice(0, 12)}... - ${result.reason}`,
                    );
                  }
                }
                // Track missed opportunities - check for actual reason strings from processEntry
                if (
                  !result.success &&
                  (result.reason === "NO_BANKROLL" ||
                    result.reason?.startsWith("Max deployed") ||
                    result.reason === "No effective bankroll")
                ) {
                  this.dynamicReserveManager.recordMissedOpportunity(
                    tokenId,
                    this.config.maxTradeUsd,
                    "RESERVE_BLOCKED",
                  );
                }
                return result;
              } else {
                // Handle structured failure with appropriate cooldown
                const { reason, detail } = fetchResult;

                // TASK 5: Only cooldown transient errors, NOT permanent market conditions
                const isPermanentCondition =
                  reason === "INVALID_LIQUIDITY" ||
                  reason === "DUST_BOOK" ||
                  reason === "INVALID_PRICES";

                if (!isPermanentCondition) {
                  const cooldownMs =
                    this.marketDataCooldownManager.recordFailure(
                      tokenId,
                      reason,
                    );
                  const info =
                    this.marketDataCooldownManager.getCooldownInfo(tokenId);

                  this.trackFailureReason(`SCAN: NO_MARKET_DATA:${reason}`);

                  // Periodic logging for market data failures
                  if (
                    this.cycleCount % 50 === 0 &&
                    shouldApplyLongCooldown(reason)
                  ) {
                    console.log(
                      `⚠️ [Scanner] No market data for ${tokenId.slice(0, 12)}... | reason: ${reason} | strike ${info?.strikes || 1} | cooldown: ${MarketDataCooldownManager.formatDuration(cooldownMs)}`,
                    );
                  }
                } else {
                  // Permanent condition - log but don't cooldown
                  this.trackFailureReason(`SCAN: NO_MARKET_DATA:${reason}`);
                  if (this.cycleCount % 50 === 0) {
                    console.log(
                      `⚠️ [Scanner] Permanent condition for ${tokenId.slice(0, 12)}... | ${reason}: ${detail?.slice(0, 50) || "unknown"} | no cooldown`,
                    );
                  }
                }
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              this.trackFailureReason(`SCAN_ERROR: ${errMsg}`);
              // Only log scan errors periodically
              if (this.cycleCount % 50 === 0) {
                console.warn(
                  `⚠️ [Scanner] Error for ${tokenId.slice(0, 8)}...: ${errMsg}`,
                );
              }
            }
            return null;
          });

        await Promise.all(scannedEntryPromises);
      } else if (this.cycleCount % 100 === 0) {
        // No opportunities at all - keep churning message
        console.log(
          `🔄 No active signals - keeping the churn going, waiting for opportunities...`,
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 6. PERIODIC HOUSEKEEPING
    // ─────────────────────────────────────────────────────────────────

    // Log market data cooldown summary periodically
    if (this.cycleCount % this.COOLDOWN_SUMMARY_INTERVAL === 0) {
      const stats = this.marketDataCooldownManager.getStats();
      const activeCount =
        this.marketDataCooldownManager.getActiveCooldownCount();
      if (stats.cooldownHits > 0 || activeCount > 0) {
        console.log(
          `📊 [Cooldown Summary] hits: ${stats.cooldownHits} | active: ${activeCount} tokens | resolved: ${stats.resolvedLaterCount}`,
        );
      }
      // Cleanup expired cooldown entries
      this.marketDataCooldownManager.cleanup();
    }

    // Send startup diagnostic report after 60 seconds
    if (
      !this.diagnostics.startupReportSent &&
      now - this.diagnostics.startTime >= this.STARTUP_DIAGNOSTIC_DELAY_MS
    ) {
      await this.sendStartupDiagnostic(usdcBalance, effectiveBankroll);
      this.diagnostics.startupReportSent = true;
    }

    // Auto-redeem resolved positions
    if (now - this.lastRedeemTime >= this.REDEEM_INTERVAL_MS) {
      await this.processRedemptions();
      this.lastRedeemTime = now;
    }

    // Auto-fill POL for gas
    const polCheckInterval = this.config.polReserveCheckIntervalMin * 60 * 1000;
    if (
      this.config.polReserveEnabled &&
      now - this.lastPolCheckTime >= polCheckInterval
    ) {
      await this.checkPolReserve(polBalance, usdcBalance);
      this.lastPolCheckTime = now;
    }

    // Status update
    if (now - this.lastSummaryTime >= this.SUMMARY_INTERVAL_MS) {
      await this.logStatus(usdcBalance, effectiveBankroll, polBalance);
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
  private async logStatus(
    usdcBalance: number,
    effectiveBankroll: number,
    polBalance: number,
  ): Promise<void> {
    const metrics = this.evTracker.getMetrics();
    const managedPositions = this.positionManager.getOpenPositions();
    const trackedWallets = this.biasAccumulator.getTrackedWalletCount();

    // Fetch actual Polymarket positions for accurate count
    let actualPositions: Position[] = [];
    try {
      actualPositions = await getPositions(this.address, true);
    } catch {
      // Continue with empty if fetch fails
    }

    const winPct = (metrics.winRate * 100).toFixed(0);
    const evSign = metrics.evCents >= 0 ? "+" : "";
    const pnlSign = metrics.totalPnlUsd >= 0 ? "+" : "";

    // POL status - show warning if below target
    const polTarget = this.config.polReserveTarget;
    const polWarning = polBalance < polTarget ? " ⚠️" : "";

    // Show both managed (bot-opened) and actual (on-chain) positions
    const positionDisplay =
      actualPositions.length > 0
        ? `${actualPositions.length} (${managedPositions.length} managed)`
        : `${managedPositions.length}`;

    // Get active biases count for diagnostic
    const activeBiases = this.biasAccumulator.getActiveBiases();

    // Get dynamic reserve state
    const reserveState = this.dynamicReserveManager.getState();
    const reservePct = (reserveState.adaptedReserveFraction * 100).toFixed(0);

    // Get scanned markets count
    const scannedMarkets = this.config.scanActiveMarkets
      ? this.volumeScanner.getActiveMarketCount()
      : 0;

    console.log("");
    console.log(`📊 STATUS | ${new Date().toLocaleTimeString()}`);
    console.log(
      `   💰 Balance: $${usdcBalance.toFixed(2)} | Bankroll: $${effectiveBankroll.toFixed(2)} | ⛽ POL: ${polBalance.toFixed(1)}${polWarning}`,
    );
    console.log(
      `   📈 Positions: ${positionDisplay} | Trades: ${metrics.totalTrades} | 🐋 Following: ${trackedWallets}`,
    );
    console.log(
      `   🎯 Win: ${winPct}% | EV: ${evSign}${metrics.evCents.toFixed(1)}¢ | P&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`,
    );

    // Show whale copy mode status
    if (this.config.copyAnyWhaleBuy) {
      console.log(
        `   ⚡ Mode: INSTANT COPY (copy any whale buy ≥ $${this.config.onchainMinWhaleTradeUsd})`,
      );
    } else {
      console.log(
        `   🐢 Mode: CONFIRMED (need $${this.config.biasMinNetUsd} flow + ${this.config.biasMinTrades} trades)`,
      );
    }

    // Show active signals and scanning status
    if (activeBiases.length > 0) {
      console.log(
        `   📡 Active whale signals: ${activeBiases.length} | Live trading: ${this.config.liveTradingEnabled ? "ON" : "OFF (simulation)"}`,
      );
    } else if (scannedMarkets > 0) {
      console.log(
        `   🔍 No whale signals - scanning ${scannedMarkets} active markets | Live trading: ${this.config.liveTradingEnabled ? "ON" : "OFF (simulation)"}`,
      );
    } else {
      console.log(
        `   ⏳ Waiting for signals... | Live trading: ${this.config.liveTradingEnabled ? "ON" : "OFF (simulation)"}`,
      );
    }

    // Show dynamic reserves status if enabled
    if (this.config.dynamicReservesEnabled) {
      const missedInfo =
        reserveState.missedCount > 0
          ? ` | Missed: ${reserveState.missedCount}`
          : "";
      console.log(
        `   🏦 Dynamic Reserve: ${reservePct}% (base: ${(reserveState.baseReserveFraction * 100).toFixed(0)}%)${missedInfo}`,
      );
    }

    // Show network health - CRITICAL for understanding slippage risk!
    const networkHealth = this.latencyMonitor.getNetworkHealth();
    const networkEmoji =
      networkHealth.status === "healthy"
        ? "🟢"
        : networkHealth.status === "degraded"
          ? "🟡"
          : "🔴";
    console.log(
      `   ${networkEmoji} Network: ${networkHealth.status.toUpperCase()} | RPC: ${networkHealth.rpcLatencyMs.toFixed(0)}ms | API: ${networkHealth.apiLatencyMs.toFixed(0)}ms | Slippage: ${networkHealth.recommendedSlippagePct.toFixed(1)}%`,
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // DIAGNOSTIC: Show on-chain vs API detection stats
    // ═══════════════════════════════════════════════════════════════════════════
    if (this.onchainMonitor) {
      const onchainStats = this.onchainMonitor.getStats();
      const onchainEmoji = onchainStats.connected ? "🟢" : "🔴";
      console.log(
        `   ${onchainEmoji} On-chain: ${onchainStats.connected ? "CONNECTED" : "DISCONNECTED"} | Events: ${onchainStats.eventsReceived} | Whales loaded: ${onchainStats.trackedWallets}`,
      );
    }

    // Show entry pipeline diagnostics
    const entrySuccessRate =
      this.diagnostics.entryAttempts > 0
        ? (
            (this.diagnostics.entrySuccesses / this.diagnostics.entryAttempts) *
            100
          ).toFixed(0)
        : "0";
    console.log(
      `   📊 Diagnostics: API trades detected: ${this.diagnostics.whaleTradesDetected} | Entry attempts: ${this.diagnostics.entryAttempts} (${entrySuccessRate}% success) | OB failures: ${this.diagnostics.orderbookFetchFailures}`,
    );

    // TASK 6: Display enhanced funnel counters showing where signals die
    const biasStats = this.biasAccumulator.getFunnelStats();
    const funnel = this.diagnostics.funnel;
    console.log(
      `   🔬 Funnel: Ingested: ${biasStats.tradesIngested} | ` +
        `PriceFilter: -${biasStats.tradesFilteredByPrice} | ` +
        `Tokens: ${biasStats.uniqueTokensWithTrades} | ` +
        `Eligible: ${funnel.eligibleSignals}`,
    );
    // Show rejection breakdown if any rejections occurred
    const totalRejections =
      funnel.biasesRejectedStale +
      funnel.biasesRejectedTrades +
      funnel.biasesRejectedFlow +
      funnel.biasesSkippedCooldown;
    if (totalRejections > 0) {
      console.log(
        `   📉 Rejections: Stale: ${funnel.biasesRejectedStale} | ` +
          `Trades<Min: ${funnel.biasesRejectedTrades} | ` +
          `Flow<Min: ${funnel.biasesRejectedFlow} | ` +
          `Cooldown: ${funnel.biasesSkippedCooldown}`,
      );
    }

    // Warn if network is not healthy
    if (
      networkHealth.warnings.length > 0 &&
      networkHealth.status !== "healthy"
    ) {
      for (const warning of networkHealth.warnings) {
        console.log(`   ⚠️ ${warning}`);
      }
    }
    console.log("");

    // Telegram update
    if (isTelegramEnabled() && metrics.totalTrades > 0) {
      await sendTelegram(
        "📊 Status",
        `Balance: $${usdcBalance.toFixed(2)}\nPOL: ${polBalance.toFixed(1)}${polWarning}\nPositions: ${positionDisplay}\nFollowing: ${trackedWallets} wallets\nWin: ${winPct}%\nP&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`,
      ).catch(() => {});
    }
  }

  /**
   * Get current price for a token - via MarketDataFacade (WS preferred, REST fallback)
   */
  private async getCurrentPrice(tokenId: string): Promise<number | null> {
    try {
      // Use facade if available, otherwise fallback to direct API call
      if (this.marketDataFacade) {
        const state = await this.marketDataFacade.getOrderbookState(tokenId);
        if (!state) return null;
        // Best bid = what we'd get if we sold right now
        return state.bestBidCents;
      }

      // Fallback to direct API call (during initialization)
      if (!this.client) return null;
      const orderbook = await this.client.getOrderBook(tokenId);
      if (!orderbook?.bids?.length) return null;

      // Best bid = what we'd get if we sold right now
      return parseFloat(orderbook.bids[0].price) * 100;
    } catch {
      return null;
    }
  }

  /**
   * Get orderbook state for a token - via MarketDataFacade (WS preferred, REST fallback)
   */
  private async getOrderbookState(
    tokenId: string,
  ): Promise<OrderbookState | null> {
    try {
      // Use facade if available (WS data with REST fallback)
      if (this.marketDataFacade) {
        const state = await this.marketDataFacade.getOrderbookState(tokenId);
        if (!state) {
          // Log when orderbook is empty - helps diagnose issues
          if (this.cycleCount % 100 === 0) {
            console.log(
              `📊 [Orderbook] Token ${tokenId.slice(0, 12)}... has no bids/asks`,
            );
          }
          this.diagnostics.orderbookFetchFailures++;
        }
        return state;
      }

      // Fallback to direct API call (during initialization)
      if (!this.client) return null;
      const orderbook = await this.client.getOrderBook(tokenId);
      if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        if (this.cycleCount % 100 === 0) {
          console.log(
            `📊 [Orderbook] Token ${tokenId.slice(0, 12)}... has no bids/asks`,
          );
        }
        this.diagnostics.orderbookFetchFailures++;
        return null;
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestAsk = parseFloat(orderbook.asks[0].price);

      // Sum up depth
      let bidDepth = 0,
        askDepth = 0;
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
    } catch (err) {
      // Log orderbook fetch errors - critical for diagnosing trade failures
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (this.cycleCount % 50 === 0) {
        console.warn(
          `📊 [Orderbook] Failed to fetch for ${tokenId.slice(0, 12)}...: ${errorMsg}`,
        );
      }
      this.diagnostics.orderbookFetchFailures++;
      return null;
    }
  }

  /**
   * Build market data for positions - via MarketDataFacade (WS preferred, REST fallback)
   *
   * PROACTIVE MONITORING: Fetches BOTH the position's token AND the opposite
   * token's orderbook. This gives us real-time hedge signal data without
   * having to look it up when we need to hedge. Increases API calls proportionally
   * to positions with opposite tokens configured (typically up to 2x if all have opposites).
   */
  private async buildMarketData(
    positions: any[],
  ): Promise<Map<string, TokenMarketData>> {
    const map = new Map<string, TokenMarketData>();

    // Deduplicate tokens to fetch - avoid fetching same token multiple times
    // Key: tokenId, Value: { positions that need this token, isOpposite flag }
    const tokensToFetch = new Map<
      string,
      {
        tokenId: string;
        forPositions: Set<string>; // Position tokenIds that need this orderbook
        isOpposite: boolean;
      }
    >();

    for (const pos of positions) {
      // Primary token - always fetch
      if (!tokensToFetch.has(pos.tokenId)) {
        tokensToFetch.set(pos.tokenId, {
          tokenId: pos.tokenId,
          forPositions: new Set(),
          isOpposite: false,
        });
      }
      tokensToFetch.get(pos.tokenId)!.forPositions.add(pos.tokenId);

      // Opposite token - for hedging (deduplicated)
      if (pos.oppositeTokenId && !tokensToFetch.has(pos.oppositeTokenId)) {
        tokensToFetch.set(pos.oppositeTokenId, {
          tokenId: pos.oppositeTokenId,
          forPositions: new Set(),
          isOpposite: true,
        });
      }
      if (pos.oppositeTokenId) {
        tokensToFetch.get(pos.oppositeTokenId)!.forPositions.add(pos.tokenId);
      }
    }

    // Subscribe to tokens via WebSocket for real-time updates
    // Also manage unsubscriptions for tokens no longer needed
    const tokenIds = Array.from(tokensToFetch.keys());
    if (tokenIds.length > 0) {
      try {
        const wsClient = getWebSocketMarketClient();
        if (wsClient.isConnected()) {
          // Get currently subscribed tokens
          const currentSubs = new Set(wsClient.getSubscriptions());
          const neededTokens = new Set(tokenIds);

          // Subscribe to new tokens
          const toSubscribe = tokenIds.filter((id) => !currentSubs.has(id));
          if (toSubscribe.length > 0) {
            wsClient.subscribe(toSubscribe);
          }

          // Unsubscribe from tokens no longer needed (cleanup old subscriptions)
          const toUnsubscribe = Array.from(currentSubs).filter(
            (id) => !neededTokens.has(id),
          );
          if (toUnsubscribe.length > 0) {
            wsClient.unsubscribe(toUnsubscribe);
            if (this.cycleCount % 100 === 0 && toUnsubscribe.length > 0) {
              console.log(
                `📡 [WS] Unsubscribed from ${toUnsubscribe.length} tokens no longer tracked`,
              );
            }
          }
        }
      } catch (err) {
        // WebSocket not available, will use REST fallback
        // Log at debug level since this is expected during initialization
        const msg = err instanceof Error ? err.message : String(err);
        if (this.cycleCount % 100 === 0) {
          console.log(
            `📡 [WS] Subscription failed, using REST fallback: ${msg}`,
          );
        }
      }
    }

    // Fetch all unique tokens in parallel - uses facade (WS data with REST fallback)
    const fetchPromises = Array.from(tokensToFetch.values()).map(
      async (task) => {
        const orderbook = await this.getOrderbookState(task.tokenId);
        return { ...task, orderbook };
      },
    );

    const results = await Promise.all(fetchPromises);

    // Create lookup maps for orderbooks
    const primaryOrderbooks = new Map<string, OrderbookState>();
    const oppositeOrderbooks = new Map<string, OrderbookState>();

    for (const result of results) {
      if (result.orderbook) {
        if (result.isOpposite) {
          // Map opposite orderbook to the positions that need it
          for (const posTokenId of result.forPositions) {
            oppositeOrderbooks.set(posTokenId, result.orderbook);
          }
        } else {
          primaryOrderbooks.set(result.tokenId, result.orderbook);
        }
      }
    }

    // Build market data map
    for (const pos of positions) {
      const orderbook = primaryOrderbooks.get(pos.tokenId);
      if (!orderbook) continue;

      const activity: MarketActivity = {
        tradesInWindow: 15, // Assume active - can enhance later
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
        // Include opposite token data for proactive hedge monitoring
        oppositeTokenId: pos.oppositeTokenId,
        oppositeOrderbook: oppositeOrderbooks.get(pos.tokenId),
      });
    }

    // Log when we have both tokens monitored
    const withOpposite = Array.from(map.values()).filter(
      (m) => m.oppositeOrderbook,
    ).length;
    const apiCalls = tokensToFetch.size;
    if (withOpposite > 0) {
      console.log(
        `🔄 Monitoring ${map.size} positions + ${withOpposite} opposite tokens (${apiCalls} API calls)`,
      );
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

    console.log(
      `⛽ Gas low! POL: ${polBalance.toFixed(3)} (min: ${config.minPol})`,
    );

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
      console.log(
        `⛽ Refilled! Swapped $${result.usdcSwapped?.toFixed(2)} → ${result.polReceived?.toFixed(2)} POL`,
      );

      if (isTelegramEnabled()) {
        await sendTelegram(
          "⛽ Gas Refilled",
          `Swapped $${result.usdcSwapped?.toFixed(2)} USDC for ${result.polReceived?.toFixed(2)} POL`,
        ).catch(() => {});
      }
    }
  }

  /**
   * Helper to process a valid REST orderbook into FetchMarketDataResult
   * Used when recovering from stale cache dust books via REST verification
   */
  private processValidOrderbook(
    tokenId: string,
    bestBidCents: number,
    bestAskCents: number,
    orderbook: {
      bids: { price: string; size: string }[];
      asks: { price: string; size: string }[];
    },
  ): FetchMarketDataResult {
    const bestBid = bestBidCents / 100;
    const bestAsk = bestAskCents / 100;
    const spreadCents = (bestAsk - bestBid) * 100;

    // Check spread
    if (spreadCents > this.config.minSpreadCents) {
      this.diagnostics.orderbookFetchFailures++;
      return {
        ok: false,
        reason: "INVALID_LIQUIDITY",
        detail: `Spread ${spreadCents.toFixed(1)}¢ > max ${this.config.minSpreadCents}¢`,
      };
    }

    // Sum up depth
    let bidDepth = 0,
      askDepth = 0;
    for (const level of orderbook.bids.slice(0, 5)) {
      bidDepth += parseFloat(level.size) * parseFloat(level.price);
    }
    for (const level of orderbook.asks.slice(0, 5)) {
      askDepth += parseFloat(level.size) * parseFloat(level.price);
    }

    const activity: MarketActivity = {
      tradesInWindow: 15,
      bookUpdatesInWindow: 25,
      lastTradeTime: Date.now(),
      lastUpdateTime: Date.now(),
    };

    return {
      ok: true,
      data: {
        tokenId,
        orderbook: {
          bestBidCents,
          bestAskCents,
          bidDepthUsd: bidDepth,
          askDepthUsd: askDepth,
          spreadCents,
          midPriceCents: (bestBidCents + bestAskCents) / 2,
          source: "REST",
        },
        activity,
        referencePriceCents: (bestBidCents + bestAskCents) / 2,
      },
    };
  }

  /**
   * Fetch market data for a single token - DIRECT API CALL
   * No caching! Stale prices caused exit failures before.
   * Returns structured result with typed failure reasons.
   */
  private async fetchTokenMarketDataWithReason(
    tokenId: string,
  ): Promise<FetchMarketDataResult> {
    try {
      // Use facade if available (WS data with REST fallback)
      if (this.marketDataFacade) {
        const state = await this.marketDataFacade.getOrderbookState(tokenId);
        if (!state) {
          this.diagnostics.orderbookFetchFailures++;
          // Facade-null can mean rate limit or transient REST failure, not necessarily "no orderbook"
          return {
            ok: false,
            reason: "NETWORK_ERROR",
            detail:
              "MarketDataFacade returned null (possible rate limit or transient failure)",
          };
        }

        // Log book source for debugging
        const bookSource = state.source || "UNKNOWN";
        this.deps.debug(
          `[BookSource] ${tokenId.slice(0, 12)}... | source: ${bookSource} | bid=${state.bestBidCents.toFixed(1)}¢ ask=${state.bestAskCents.toFixed(1)}¢`,
        );

        // Check for dust book (1¢/99¢ spreads)
        // If dust book detected from WS/cache, perform immediate REST re-fetch to verify
        if (state.bestBidCents <= 2 && state.bestAskCents >= 98) {
          // Log the dust book detection with source
          console.log(
            `⚠️ [DUST_BOOK] ${tokenId.slice(0, 12)}... | source: ${bookSource} | bid=${state.bestBidCents.toFixed(1)}¢ ask=${state.bestAskCents.toFixed(1)}¢ | attempting REST re-fetch...`,
          );

          // Verify tokenId mapping via Gamma API - helps diagnose wrong tokenId issues
          // Use a timeout to prevent blocking the trading loop
          try {
            const mappingPromise = fetchMarketByTokenId(tokenId);
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<null>((resolve) => {
              timeoutId = setTimeout(() => resolve(null), 3000);
            });
            const marketInfo = await Promise.race([
              mappingPromise,
              timeoutPromise,
            ]);
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId);
            }
            if (marketInfo) {
              const activeStatus =
                marketInfo.active === false
                  ? "inactive"
                  : marketInfo.active === true
                    ? "active"
                    : "unknown";
              console.log(
                `🔍 [MAPPING_VERIFY] ${tokenId.slice(0, 12)}... | conditionId=${marketInfo.conditionId.slice(0, 12)}... | marketId=${marketInfo.marketId.slice(0, 12)}... | YES=${marketInfo.yesTokenId.slice(0, 12)}... | NO=${marketInfo.noTokenId.slice(0, 12)}... | status=${activeStatus}`,
              );
            } else {
              console.log(
                `⚠️ [MAPPING_VERIFY] ${tokenId.slice(0, 12)}... | No market found or timeout (possibly invalid/expired)`,
              );
            }
          } catch (mappingErr) {
            const mappingErrMsg =
              mappingErr instanceof Error
                ? mappingErr.message
                : String(mappingErr);
            console.log(
              `⚠️ [MAPPING_VERIFY_FAILED] ${tokenId.slice(0, 12)}... | ${mappingErrMsg}`,
            );
          }

          // Perform REST re-fetch to verify this isn't stale cache
          // Throttled to once per token per 5 minutes to prevent API overload
          const now = Date.now();
          const lastVerify = this.dustBookRestVerifyThrottle.get(tokenId) ?? 0;
          const shouldVerifyRest =
            bookSource !== "REST" &&
            now - lastVerify >= this.DUST_BOOK_VERIFY_THROTTLE_MS;

          if (shouldVerifyRest) {
            this.dustBookRestVerifyThrottle.set(tokenId, now);
            try {
              const restOrderbook = await this.client!.getOrderBook(tokenId);
              if (restOrderbook?.bids?.length && restOrderbook?.asks?.length) {
                const restBid = parseFloat(restOrderbook.bids[0].price) * 100;
                const restAsk = parseFloat(restOrderbook.asks[0].price) * 100;

                console.log(
                  `📡 [REST_VERIFY] ${tokenId.slice(0, 12)}... | REST result: bid=${restBid.toFixed(1)}¢ ask=${restAsk.toFixed(1)}¢`,
                );

                // Check if REST also shows dust book
                if (restBid <= 2 && restAsk >= 98) {
                  console.log(
                    `❌ [DUST_BOOK_CONFIRMED] ${tokenId.slice(0, 12)}... | REST confirms dust book`,
                  );
                  this.diagnostics.orderbookFetchFailures++;
                  return {
                    ok: false,
                    reason: "DUST_BOOK",
                    detail: `Dust book (confirmed by REST): bid=${restBid.toFixed(1)}¢, ask=${restAsk.toFixed(1)}¢`,
                  };
                } else {
                  // REST shows valid book - use REST data instead
                  console.log(
                    `✅ [BOOK_RECOVERED] ${tokenId.slice(0, 12)}... | REST shows valid book, cache was stale`,
                  );
                  // Continue with REST data
                  return this.processValidOrderbook(
                    tokenId,
                    restBid,
                    restAsk,
                    restOrderbook,
                  );
                }
              }
            } catch (restErr) {
              const restErrMsg =
                restErr instanceof Error ? restErr.message : String(restErr);
              console.log(
                `⚠️ [REST_VERIFY_FAILED] ${tokenId.slice(0, 12)}... | ${restErrMsg}`,
              );
            }
          }

          // Original source was REST or REST re-fetch failed/throttled - trust original result
          this.diagnostics.orderbookFetchFailures++;
          return {
            ok: false,
            reason: "DUST_BOOK",
            detail: `Dust book: bid=${state.bestBidCents.toFixed(1)}¢, ask=${state.bestAskCents.toFixed(1)}¢ (source: ${bookSource})`,
          };
        }

        // Check for invalid prices
        if (
          state.bestBidCents <= 0 ||
          state.bestAskCents <= 0 ||
          isNaN(state.bestBidCents) ||
          isNaN(state.bestAskCents)
        ) {
          this.diagnostics.orderbookFetchFailures++;
          return {
            ok: false,
            reason: "INVALID_PRICES",
            detail: `Invalid prices: bid=${state.bestBidCents}¢, ask=${state.bestAskCents}¢ (source: ${bookSource})`,
          };
        }

        // Check spread
        if (state.spreadCents > this.config.minSpreadCents) {
          this.diagnostics.orderbookFetchFailures++;
          return {
            ok: false,
            reason: "INVALID_LIQUIDITY",
            detail: `Spread ${state.spreadCents.toFixed(1)}¢ > max ${this.config.minSpreadCents}¢ (source: ${bookSource})`,
          };
        }

        const activity: MarketActivity = {
          tradesInWindow: 15,
          bookUpdatesInWindow: 25,
          lastTradeTime: Date.now(),
          lastUpdateTime: Date.now(),
        };

        return {
          ok: true,
          data: {
            tokenId,
            orderbook: state,
            activity,
            referencePriceCents: state.midPriceCents,
          },
        };
      }

      // Fallback to direct API call (during initialization)
      let orderbook;
      try {
        orderbook = await this.client!.getOrderBook(tokenId);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorMsgLower = errorMsg.toLowerCase();
        this.diagnostics.orderbookFetchFailures++;

        // Classify the error (case-insensitive, check most specific first)
        // NO_ORDERBOOK: specific Polymarket error for closed/settled markets
        if (errorMsgLower.includes("no orderbook")) {
          return { ok: false, reason: "NO_ORDERBOOK", detail: errorMsg };
        }
        // NOT_FOUND: 404 or generic "not found" errors
        if (
          errorMsgLower.includes("404") ||
          errorMsgLower.includes("not found")
        ) {
          return { ok: false, reason: "NOT_FOUND", detail: errorMsg };
        }
        // RATE_LIMIT: rate limiting errors
        if (
          errorMsgLower.includes("rate") ||
          errorMsgLower.includes("429") ||
          errorMsgLower.includes("too many")
        ) {
          return { ok: false, reason: "RATE_LIMIT", detail: errorMsg };
        }
        // NETWORK_ERROR: connection/network failures
        if (
          errorMsgLower.includes("timeout") ||
          errorMsgLower.includes("econnreset") ||
          errorMsgLower.includes("network") ||
          errorMsgLower.includes("enotfound") ||
          errorMsgLower.includes("socket")
        ) {
          return { ok: false, reason: "NETWORK_ERROR", detail: errorMsg };
        }
        // Default to NETWORK_ERROR for unknown errors
        return { ok: false, reason: "NETWORK_ERROR", detail: errorMsg };
      }

      if (!orderbook?.bids?.length || !orderbook?.asks?.length) {
        this.diagnostics.orderbookFetchFailures++;
        return {
          ok: false,
          reason: "NO_ORDERBOOK",
          detail: "Empty orderbook (no bids or asks)",
        };
      }

      const bestBid = parseFloat(orderbook.bids[0].price);
      const bestAsk = parseFloat(orderbook.asks[0].price);

      if (isNaN(bestBid) || isNaN(bestAsk)) {
        this.diagnostics.orderbookFetchFailures++;
        return {
          ok: false,
          reason: "PARSE_ERROR",
          detail: "Failed to parse bid/ask prices",
        };
      }

      // TASK 3: Add orderbook sanity gates - reject dust books immediately
      // These are permanent market conditions, not transient errors
      // DO NOT put token on cooldown for these - just reject and keep scanning

      // Check for invalid prices (missing/zero/NaN already handled above)
      if (bestBid <= 0 || bestAsk <= 0) {
        this.diagnostics.orderbookFetchFailures++;
        return {
          ok: false,
          reason: "INVALID_PRICES",
          detail: `Invalid prices: bid=${bestBid}, ask=${bestAsk}`,
        };
      }

      // Check for dust book (1¢/99¢ spreads - no room to trade)
      // Uses shared isDeadBook() function from price-safety.ts
      if (isDeadBook(bestBid, bestAsk)) {
        this.diagnostics.orderbookFetchFailures++;
        return {
          ok: false,
          reason: "DUST_BOOK",
          detail: `Dust book: bid=${(bestBid * 100).toFixed(1)}¢, ask=${(bestAsk * 100).toFixed(1)}¢`,
        };
      }

      // Check spread before computing depth (fail fast)
      const spreadCents = (bestAsk - bestBid) * 100;
      if (spreadCents > this.config.minSpreadCents) {
        this.diagnostics.orderbookFetchFailures++;
        return {
          ok: false,
          reason: "INVALID_LIQUIDITY",
          detail: `Spread ${spreadCents.toFixed(1)}¢ > max ${this.config.minSpreadCents}¢`,
        };
      }

      // Sum up depth
      let bidDepth = 0,
        askDepth = 0;
      for (const level of orderbook.bids.slice(0, 5)) {
        bidDepth += parseFloat(level.size) * parseFloat(level.price);
      }
      for (const level of orderbook.asks.slice(0, 5)) {
        askDepth += parseFloat(level.size) * parseFloat(level.price);
      }

      const activity: MarketActivity = {
        tradesInWindow: 15,
        bookUpdatesInWindow: 25,
        lastTradeTime: Date.now(),
        lastUpdateTime: Date.now(),
      };

      return {
        ok: true,
        data: {
          tokenId,
          orderbook: {
            bestBidCents: bestBid * 100,
            bestAskCents: bestAsk * 100,
            bidDepthUsd: bidDepth,
            askDepthUsd: askDepth,
            spreadCents: (bestAsk - bestBid) * 100,
            midPriceCents: ((bestBid + bestAsk) / 2) * 100,
            source: "REST",
          },
          activity,
          referencePriceCents: ((bestBid + bestAsk) / 2) * 100,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorMsgLower = errorMsg.toLowerCase();
      this.diagnostics.orderbookFetchFailures++;

      // Classify unexpected errors (case-insensitive to match earlier classification)
      if (
        errorMsgLower.includes("parse") ||
        errorMsgLower.includes("json") ||
        errorMsgLower.includes("unexpected token")
      ) {
        return { ok: false, reason: "PARSE_ERROR", detail: errorMsg };
      }
      return { ok: false, reason: "NETWORK_ERROR", detail: errorMsg };
    }
  }

  /**
   * Fetch market data for a single token - DIRECT API CALL
   * No caching! Stale prices caused exit failures before.
   * @deprecated Use fetchTokenMarketDataWithReason for structured error handling
   */
  private async fetchTokenMarketData(
    tokenId: string,
  ): Promise<TokenMarketData | null> {
    const result = await this.fetchTokenMarketDataWithReason(tokenId);
    if (result.ok) {
      return result.data;
    }
    return null;
  }

  /**
   * Process position redemptions
   */
  /**
   * Send startup diagnostic report to GitHub Issues
   * This helps debug trade detection issues by showing the first 60 seconds of operation
   */
  private async sendStartupDiagnostic(
    usdcBalance: number,
    effectiveBankroll: number,
  ): Promise<void> {
    const reporter = getGitHubReporter();
    if (!reporter.isEnabled()) {
      console.log(
        `📋 [Diagnostic] GitHub reporter not enabled - skipping startup diagnostic`,
      );
      return;
    }

    const networkHealth = this.latencyMonitor.getNetworkHealth();
    const trackedWallets = this.biasAccumulator.getTrackedWalletCount();
    const scannedMarkets = this.config.scanActiveMarkets
      ? this.volumeScanner.getActiveMarketCount()
      : 0;

    // Determine on-chain monitor status
    let onchainStatus = "DISABLED";
    if (this.config.onchainMonitorEnabled) {
      if (this.onchainMonitor) {
        const stats = this.onchainMonitor.getStats();
        onchainStatus = stats.connected
          ? `CONNECTED (${stats.eventsReceived} events)`
          : "DISCONNECTED";
      } else {
        onchainStatus = "FAILED_TO_START";
      }
    }

    console.log(
      `📋 [Diagnostic] Sending startup diagnostic to GitHub Issues...`,
    );
    console.log(
      `   Whale trades detected: ${this.diagnostics.whaleTradesDetected}`,
    );
    console.log(`   Entry attempts: ${this.diagnostics.entryAttempts}`);
    console.log(`   Entry successes: ${this.diagnostics.entrySuccesses}`);
    console.log(
      `   Orderbook failures: ${this.diagnostics.orderbookFetchFailures}`,
    );
    console.log(`   On-chain: ${onchainStatus}`);

    try {
      await reporter.reportStartupDiagnostic({
        whaleWalletsLoaded: trackedWallets,
        marketsScanned: scannedMarkets,
        whaleTradesDetected: this.diagnostics.whaleTradesDetected,
        entryAttemptsCount: this.diagnostics.entryAttempts,
        entrySuccessCount: this.diagnostics.entrySuccesses,
        entryFailureReasons: this.diagnostics.entryFailureReasons.slice(-20), // Last 20 reasons
        orderbookFetchFailures: this.diagnostics.orderbookFetchFailures,
        onchainMonitorStatus: onchainStatus,
        rpcLatencyMs: networkHealth.rpcLatencyMs,
        apiLatencyMs: networkHealth.apiLatencyMs,
        balance: usdcBalance,
        effectiveBankroll,
        config: {
          liveTradingEnabled: this.config.liveTradingEnabled,
          copyAnyWhaleBuy: this.config.copyAnyWhaleBuy,
          whaleTradeUsd: this.config.onchainMinWhaleTradeUsd,
          scanActiveMarkets: this.config.scanActiveMarkets,
        },
      });
      console.log(`📋 [Diagnostic] Startup diagnostic sent successfully`);
    } catch (err) {
      console.warn(
        `📋 [Diagnostic] Failed to send: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

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
        console.log(
          `🎁 Redeemed ${result.redeemed} position(s) worth $${result.totalValue.toFixed(2)}`,
        );

        if (isTelegramEnabled()) {
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

    // Stop latency monitoring
    this.latencyMonitor.stop();

    // Stop on-chain monitor if running
    if (this.onchainMonitor) {
      this.onchainMonitor.stop();
    }

    if (isTelegramEnabled()) {
      sendTelegram("🛑 Bot Stopped", "Polymarket Bot has been stopped").catch(
        () => {},
      );
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTIC MODE SUPPORT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get dependencies for diagnostic workflow.
   * This method is intentionally not private as it's accessed in main() after initialization.
   * It should only be called after initialize() returns true, which ensures client/address/logger are set.
   */
  getDiagDeps(): DiagWorkflowDeps {
    if (!this.client || !this.address) {
      throw new Error(
        "getDiagDeps() called before initialization. Call initialize() first.",
      );
    }
    return {
      client: this.client,
      address: this.address,
      logger: this.logger,
      waitForWhaleSignal: this.waitForWhaleSignalDiag.bind(this),
      runMarketScan: this.runMarketScanDiag.bind(this),
      getMarketData: this.getMarketDataDiag.bind(this),
    };
  }

  /**
   * Wait for a whale signal (for diagnostic mode)
   * Returns the first whale buy signal within the timeout
   */
  private async waitForWhaleSignalDiag(timeoutMs: number): Promise<{
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    price?: number;
  } | null> {
    const startTime = Date.now();
    const pollIntervalMs = 1000; // Check every second

    // Ensure we have leaderboard wallets
    await this.biasAccumulator.refreshLeaderboard();

    while (Date.now() - startTime < timeoutMs) {
      // Fetch latest trades
      await this.biasAccumulator.fetchLeaderboardTrades();

      // Check for active biases
      const biases = this.biasAccumulator.getActiveBiases();

      if (biases.length > 0) {
        // Return the first active bias as a whale signal
        const bias = biases[0];

        // Try to get market data for price
        let price: number | undefined;
        if (this.marketDataFacade) {
          const state = await this.marketDataFacade.getOrderbookState(
            bias.tokenId,
          );
          if (state && state.midPriceCents > 0) {
            price = state.midPriceCents / 100; // Convert cents to decimal
          }
        }

        return {
          tokenId: bias.tokenId,
          marketId: bias.marketId,
          outcomeLabel: "YES", // Default assumption for whale buys
          price,
        };
      }

      // Wait before next poll
      await this.sleep(pollIntervalMs);
    }

    return null; // Timeout - no signal received
  }

  /**
   * Run market scan once (for diagnostic mode)
   * Returns one eligible market candidate
   */
  private async runMarketScanDiag(): Promise<{
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    price?: number;
  } | null> {
    // Force a scan if scanner is enabled
    if (!this.config.scanActiveMarkets) {
      console.log("⚠️ Market scanner is disabled (SCAN_ACTIVE_MARKETS=false)");
      return null;
    }

    // Scan for active markets
    const markets = await this.volumeScanner.scanActiveMarkets();

    if (!markets || markets.length === 0) {
      console.log("📊 No eligible markets found in scan");
      return null;
    }

    // Return the first market
    const market = markets[0];

    return {
      tokenId: market.tokenId,
      marketId: market.marketId,
      outcomeLabel: "YES", // Default assumption - YES token
      price: market.price,
    };
  }

  /**
   * Get market data for a token (for diagnostic mode)
   */
  private async getMarketDataDiag(tokenId: string): Promise<{
    bid?: number;
    ask?: number;
    mid?: number;
    spread?: number;
  } | null> {
    if (!this.marketDataFacade) {
      return null;
    }

    const state = await this.marketDataFacade.getOrderbookState(tokenId);
    if (!state) {
      return null;
    }

    return {
      bid: state.bestBidCents / 100,
      ask: state.bestAskCents / 100,
      mid: state.midPriceCents / 100,
      spread: state.spreadCents,
    };
  }

  /**
   * Get the CLOB client (for diagnostic mode)
   */
  getClient(): ClobClient {
    if (!this.client) {
      throw new Error("Client not initialized. Call initialize() first.");
    }
    return this.client;
  }

  /**
   * Get the wallet address (for diagnostic mode)
   */
  getAddress(): string {
    return this.address;
  }

  /**
   * Get the logger (for diagnostic mode)
   */
  getLogger(): SimpleLogger {
    return this.logger;
  }
}
