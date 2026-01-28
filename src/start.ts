/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET BOT - Trading Engine
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
 * THE MATH IS LAW. Every parameter is fixed by the EV equation:
 *
 *   EV = p(win) × avg_win - p(loss) × avg_loss - churn_cost
 *
 * Fixed values:
 *   avg_win  = 14¢  (TP_CENTS)
 *   avg_loss = 9¢   (after hedge caps losses)
 *   churn    = 2¢   (spread + slippage)
 *
 * Break-even: p > (9 + 2) / (14 + 9) = 47.8%
 *
 *   50% wins → EV positive
 *   55% wins → solid profit
 *   60% wins → strong profit
 * ═══════════════════════════════════════════════════════════════════════════
 */

import "dotenv/config";
import axios from "axios";
import type { ClobClient } from "@polymarket/clob-client";

// Keep essential lib modules
import {
  createClobClient,
  // Balance cache for RPC throttling
  BalanceCache,
  initBalanceCache,
  getBalanceCache,
  DEFAULT_BALANCE_REFRESH_INTERVAL_MS,
  initTelegram,
  sendTelegram,
  redeemAllPositions,
  fetchRedeemablePositions,
  capturePreVpnRouting,
  startWireguard,
  startOpenvpn,
  setupRpcBypass,
  setupPolymarketReadBypass,
  setupReadApiBypass,
  // VPN routing policy events
  emitRoutingPolicyPreEvent,
  emitRoutingPolicyEffectiveEvent,
  VPN_BYPASS_DEFAULTS,
  isVpnActive,
  getVpnType,
  getBypassedHosts,
  WRITE_HOSTS,
  // Proactive WRITE host VPN routing (critical fix for WRITE_ROUTE_MISMATCH)
  ensureWriteHostVpnRoutes,
  // POL Reserve (auto gas fill)
  runPolReserve,
  shouldRebalance,
  type PolReserveConfig,
  // Position fetching for liquidation mode
  getPositions,
  invalidatePositions,
  smartSell,
  type Position,
  // On-chain event monitoring (confirmed trades)
  OnChainMonitor,
  createOnChainMonitorConfig,
  // Market utilities for hedge token lookup and mapping verification
  getOppositeTokenId,
  fetchMarketByTokenId,
  // GitHub error reporting
  initGitHubReporter,
  reportError,
  getGitHubReporter,
  // Latency monitoring for dynamic slippage
  LatencyMonitor,
  initLatencyMonitor,
  getLatencyMonitor,
  // Telegram
  isTelegramEnabled,
  // WebSocket market data layer
  initMarketDataFacade,
  initMarketDataStore,
  getWebSocketMarketClient,
  initWebSocketMarketClient,
  getWebSocketUserClient,
  setupWebSocketBypass,
  type MarketDataFacade,
  // Diagnostic mode
  isDiagModeEnabled,
  parseDiagModeConfig,
  runDiagWorkflow,
  isGitHubActions,
  ghNotice,
  type DiagWorkflowDeps,
  getRejectionStats,
  checkWriteHostRoute,
} from "./lib";

// Import from core modules (extracted/deduplicated classes)
import {
  DecisionEngine,
  type DecisionEngineConfig,
  type OrderbookState,
  type MarketActivity,
  type BiasDirection,
  type PositionState,
  type ExitReason,
  type HedgeLeg,
  type StateTransition,
  type ManagedPosition,
  type EvMetrics,
  type EntryDecision,
  type ExitDecision,
  EvTracker,
  type EvTrackerConfig,
  type TradeResult,
  ExecutionEngine,
  type ExecutionResult,
  type TokenMarketData,
  type ChurnLogger,
  type ExecutionEngineConfig,
  PositionManager,
  type PositionManagerConfig,
  calculatePnlCents,
  calculatePnlUsd,
  createTradeResult,
} from "./core";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Helper to read numeric env vars
const envNum = (key: string, defaultValue: number): number => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

// Helper to read boolean env vars
const envBool = (key: string, defaultValue: boolean): boolean => {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true";
};

// Helper to read string env vars
const envStr = (key: string, defaultValue: string): string => {
  return process.env[key] ?? defaultValue;
};

// ═══════════════════════════════════════════════════════════════════════════
// DEBUG LOGGING - Set DEBUG=true in env to enable verbose logs
// ═══════════════════════════════════════════════════════════════════════════
const DEBUG = envBool("DEBUG", false);

function debug(message: string, ...args: any[]): void {
  if (DEBUG) {
    console.log(`🔍 [DEBUG] ${message}`, ...args);
  }
}

/**
 * Check if an entry failure reason should trigger a cooldown
 * Only cooldown for TRANSIENT errors (rate limits, network issues, order failures)
 * Do NOT cooldown for permanent market conditions (liquidity, spread, depth, price bounds)
 */
function shouldCooldownOnFailure(reason: string | undefined): boolean {
  if (!reason) return false;
  const lowerReason = reason.toLowerCase();

  // Transient errors - SHOULD cooldown (will retry after delay)
  if (lowerReason.includes("rate_limit") || lowerReason.includes("rate limit"))
    return true;
  if (
    lowerReason.includes("network_error") ||
    lowerReason.includes("network error")
  )
    return true;
  if (
    lowerReason.includes("order placement") ||
    lowerReason.includes("order failed")
  )
    return true;
  if (lowerReason.includes("timeout")) return true;

  // Permanent market conditions - do NOT cooldown (market is just not suitable)
  if (lowerReason.includes("invalid liquidity")) return false;
  if (lowerReason.includes("dust book")) return false;
  if (lowerReason.includes("spread") && lowerReason.includes(">")) return false;
  if (lowerReason.includes("depth")) return false;
  if (
    lowerReason.includes("price") &&
    (lowerReason.includes("outside") || lowerReason.includes("bounds"))
  )
    return false;

  // Default: do NOT cooldown (fail fast and check next candidate)
  return false;
}

/**
 * Parse an optional float with a default value
 * Returns default if not set, undefined if explicitly set to empty string (to disable)
 * Warns if value is outside expected [0,1] range
 */
function parseOptionalFloatWithDefault(
  value: string | undefined,
  defaultValue: number,
): number | undefined {
  // If env var is not set at all, use default
  if (value === undefined) return defaultValue;

  // If env var is explicitly set to empty string, disable (return undefined)
  if (value === "") return undefined;

  const parsed = parseFloat(value);
  if (isNaN(parsed)) return defaultValue;

  // Warn if value seems like a percentage (outside [0,1] range)
  if (parsed < 0 || parsed > 1) {
    console.warn(
      `⚠️ Price value ${parsed} is outside expected [0,1] range. ` +
        `Use decimal format (e.g., 0.25 for 25¢, not 25).`,
    );
    // Fall back to the provided default to avoid using an invalid configuration value
    return defaultValue;
  }

  return parsed;
}

interface ChurnConfig {
  // ═══════════════════════════════════════════════════════════════════════════
  // USER CONFIGURABLE (the ONLY thing you should change)
  // ═══════════════════════════════════════════════════════════════════════════
  maxTradeUsd: number; // Your bet size in USD (default: $25)

  // ═══════════════════════════════════════════════════════════════════════════
  // FIXED BY THE MATH (do not change)
  // ═══════════════════════════════════════════════════════════════════════════

  // Capital & Position Sizing (fixed ratios)
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
  balanceRefreshIntervalMs: number; // Balance cache refresh interval (default: 10000ms)
  logLevel: string;

  // Wallet / Reserve Management
  reserveFraction: number;
  minReserveUsd: number;
  useAvailableBalanceOnly: boolean;

  // Liquidation Mode
  liquidationMode: "off" | "losing" | "all"; // "off" = normal trading, "losing" = sell losing positions, "all" = sell everything
  liquidationMaxSlippagePct: number; // Max slippage for liquidation sells (default: 10%)
  liquidationPollIntervalMs: number; // Poll interval in liquidation mode (default: 1000ms)

  // Aggressive Whale Copy Mode
  copyAnyWhaleBuy: boolean; // If true, copy ANY whale buy without waiting for bias confirmation

  // Market Scanner - Scan for most active/trending markets
  scanActiveMarkets: boolean; // If true, scan for active markets to trade
  scanMinVolumeUsd: number; // Minimum 24h volume to consider a market
  scanTopNMarkets: number; // Number of top markets to scan
  scanIntervalSeconds: number; // How often to refresh the market scan

  // Dynamic Reserves - Self-balancing reserve system
  dynamicReservesEnabled: boolean; // If true, use dynamic reserve calculation
  reserveAdaptationRate: number; // How quickly reserves adapt (0-1, default: 0.1)
  missedOpportunityWeight: number; // Weight for missed opportunities (default: 0.5)
  hedgeCoverageWeight: number; // Weight for hedge coverage needs (default: 0.5)
  maxReserveFraction: number; // Maximum reserve as fraction of balance (default: 0.5)

  // Auth
  privateKey: string;
  rpcUrl: string;
  liveTradingEnabled: boolean;

  // Telegram (optional)
  telegramBotToken?: string;
  telegramChatId?: string;

  // POL Reserve (auto-fill gas)
  polReserveEnabled: boolean;
  polReserveTarget: number;
  polReserveMin: number;
  polReserveMaxSwapUsd: number;
  polReserveCheckIntervalMin: number;
  polReserveSlippagePct: number;

  // On-Chain Monitoring (Infura WebSocket) - sees CONFIRMED trades
  onchainMonitorEnabled: boolean;
  onchainMinWhaleTradeUsd: number;
  infuraTier: "core" | "developer" | "team" | "growth";

  // Whale Price-Range Filtering - Filter whale trades by price
  // Only trades within the specified price range will create signals
  whalePriceMin?: number; // Minimum price (0-1), e.g., 0.25
  whalePriceMax?: number; // Maximum price (0-1), e.g., 0.45
}

function loadConfig(): ChurnConfig {
  return {
    // ═══════════════════════════════════════════════════════════════════════
    // USER CONFIGURABLE - This is the ONLY thing you should change
    // ═══════════════════════════════════════════════════════════════════════
    maxTradeUsd: envNum("MAX_TRADE_USD", 25), // 💰 Your bet size (default: $25)

    // ═══════════════════════════════════════════════════════════════════════
    // FIXED BY THE MATH - Do NOT change these values
    // The math equation requires these exact parameters to work
    // ═══════════════════════════════════════════════════════════════════════

    // Capital sizing (fixed ratios that scale with MAX_TRADE_USD)
    tradeFraction: 0.01, // 1% of bankroll per trade
    maxDeployedFractionTotal: 0.3, // 30% max exposure
    maxOpenPositionsTotal: 12, // Max concurrent positions
    maxOpenPositionsPerMarket: 1, // 1 entry per token (hedges are stored inside position, not as separate entries)
    cooldownSecondsPerToken: 180, // 3min between trades same token

    // Entry/Exit bands - produces avg_win=14¢, avg_loss=9¢
    entryBandCents: 12, // Min price movement to enter
    tpCents: 14, // Take profit = 14¢
    hedgeTriggerCents: 16, // Hedge at 16¢ adverse
    maxAdverseCents: 30, // HARD STOP at 30¢ loss
    maxHoldSeconds: 3600, // 1 hour max hold

    // Hedge behavior - caps avg_loss to ~9¢ instead of 30¢
    hedgeRatio: 0.4, // Hedge 40% on first trigger
    maxHedgeRatio: 0.7, // Never hedge more than 70%

    // Entry price bounds - room to win, hedge, and be wrong
    minEntryPriceCents: envNum("MIN_ENTRY_PRICE_CENTS", 30), // <30¢ = one bad tick kills you
    maxEntryPriceCents: envNum("MAX_ENTRY_PRICE_CENTS", 82), // >82¢ = no room for TP
    preferredEntryLowCents: envNum("PREFERRED_ENTRY_LOW_CENTS", 35), // Ideal zone starts
    preferredEntryHighCents: envNum("PREFERRED_ENTRY_HIGH_CENTS", 65), // Ideal zone ends
    entryBufferCents: 4, // Safety buffer

    // Liquidity gates - keeps churn cost at ~2¢
    minSpreadCents: envNum("MIN_SPREAD_CENTS", 6), // Max acceptable spread
    minDepthUsdAtExit: envNum("MIN_DEPTH_USD_AT_EXIT", 25), // Need liquidity to exit
    minTradesLastX: 10, // Market must be active
    minBookUpdatesLastX: 20, // Book must be updating
    activityWindowSeconds: 300, // 5min activity window

    // Cooldown settings
    entryCooldownSecondsTransient: envNum(
      "ENTRY_COOLDOWN_SECONDS_TRANSIENT",
      30,
    ), // Cooldown for transient errors

    // EV controls - bot stops itself when math says stop
    rollingWindowTrades: 200, // Sample size for stats
    churnCostCentsEstimate: 2, // 2¢ churn cost
    minEvCents: 0, // Pause if EV < 0
    minProfitFactor: 1.25, // avg_win/avg_loss >= 1.25
    pauseSeconds: 300, // 5min pause when table closed

    // Bias (Leaderboard flow) - permission, not prediction
    // Track top 100 wallets for maximum signal coverage (churn all day)
    biasMode: "leaderboard_flow",
    leaderboardTopN: 100, // Track top 100 wallets for more signals
    biasWindowSeconds: 3600, // 1 hour window
    biasMinNetUsd: envNum("BIAS_MIN_NET_USD", 300), // $300 net flow minimum
    biasMinTrades: envNum("BIAS_MIN_TRADES", 3), // At least 3 trades
    biasStaleSeconds: envNum("BIAS_STALE_SECONDS", 900), // Bias expires after 15min
    allowEntriesOnlyWithBias: true,
    onBiasFlip: "MANAGE_EXITS_ONLY",
    onBiasNone: "PAUSE_ENTRIES",

    // Polling (fixed - fast polling for accurate position tracking)
    pollIntervalMs: 200, // 200ms = 5 req/sec
    positionPollIntervalMs: 100, // 100ms when holding positions
    // Balance refresh interval - throttles RPC calls for USDC/POL balance
    // Default: 10000ms (10s). Set higher to reduce Infura RPC usage.
    balanceRefreshIntervalMs: envNum(
      "BALANCE_REFRESH_INTERVAL_MS",
      DEFAULT_BALANCE_REFRESH_INTERVAL_MS,
    ),
    logLevel: envStr("LOG_LEVEL", "info"),

    // Wallet / Reserve (fixed - survive variance)
    reserveFraction: 0.25, // 25% always reserved
    minReserveUsd: 100, // $100 minimum reserve
    useAvailableBalanceOnly: true,

    // Liquidation Mode - force sell existing positions
    // "off" = normal trading (default)
    // "losing" = only sell positions with negative P&L
    // "all" = sell all positions regardless of P&L
    liquidationMode: parseLiquidationMode(
      process.env.LIQUIDATION_MODE || process.env.FORCE_LIQUIDATION,
    ),
    liquidationMaxSlippagePct: envNum("LIQUIDATION_MAX_SLIPPAGE_PCT", 10), // 10% default
    liquidationPollIntervalMs: envNum("LIQUIDATION_POLL_INTERVAL_MS", 1000), // 1s default

    // Aggressive Whale Copy Mode - copy ANY whale buy without waiting for bias
    // When true: sees whale buy → immediately copies (no $300 flow / 3 trade requirement)
    // When false: requires bias confirmation (multiple whale trades in same direction)
    // DEFAULT: true - for best copy trading results, copy immediately!
    copyAnyWhaleBuy: envBool("COPY_ANY_WHALE_BUY", true),

    // Market Scanner - Scan for most active/trending markets to trade
    // When enabled, the bot will scan Polymarket for the most active markets
    // and consider them as additional trading opportunities
    scanActiveMarkets: envBool("SCAN_ACTIVE_MARKETS", true),
    scanMinVolumeUsd: envNum("SCAN_MIN_VOLUME_USD", 10000), // $10k minimum 24h volume
    scanTopNMarkets: envNum("SCAN_TOP_N_MARKETS", 20), // Top 20 most active markets
    scanIntervalSeconds: envNum("SCAN_INTERVAL_SECONDS", 300), // Refresh every 5 minutes

    // Dynamic Reserves - Self-balancing reserve system
    // Automatically adjusts reserves based on missed opportunities and hedge needs
    dynamicReservesEnabled: envBool("DYNAMIC_RESERVES_ENABLED", true),
    reserveAdaptationRate: envNum("RESERVE_ADAPTATION_RATE", 0.1), // 10% adaptation per cycle
    missedOpportunityWeight: envNum("MISSED_OPPORTUNITY_WEIGHT", 0.5), // Weight for missed trades
    hedgeCoverageWeight: envNum("HEDGE_COVERAGE_WEIGHT", 0.5), // Weight for hedge needs
    maxReserveFraction: envNum("MAX_RESERVE_FRACTION", 0.5), // Max 50% reserve

    // ═══════════════════════════════════════════════════════════════════════
    // AUTH & INTEGRATIONS (user provides these)
    // ═══════════════════════════════════════════════════════════════════════
    privateKey: process.env.PRIVATE_KEY ?? "",
    rpcUrl: envStr("RPC_URL", "https://polygon-rpc.com"),
    liveTradingEnabled: envStr("LIVE_TRADING", "") === "I_UNDERSTAND_THE_RISKS",

    // Telegram (optional)
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,

    // POL Reserve - auto-fill gas
    // IMPORTANT: Only tops off when POL falls below polReserveMin (0.5)
    // Does NOT proactively top off to polReserveTarget (50) - saves USDC
    // When triggered: swaps up to polReserveMaxSwapUsd USDC to reach target
    polReserveEnabled: true,
    polReserveTarget: envNum("POL_RESERVE_TARGET", 50), // Target POL when refilling
    polReserveMin: envNum("POL_RESERVE_MIN", 0.5), // Trigger threshold (refill when below this)
    polReserveMaxSwapUsd: envNum("POL_RESERVE_MAX_SWAP_USD", 10), // Max USDC per swap
    polReserveCheckIntervalMin: envNum("POL_RESERVE_CHECK_INTERVAL_MIN", 5), // Check every 5 min
    polReserveSlippagePct: 3,

    // On-Chain Monitoring - Watch CTF Exchange contract via Infura WebSocket
    // This provides faster whale detection than API polling (blockchain-level speed)
    // Requires Infura RPC URL with WebSocket support
    onchainMonitorEnabled: envBool("ONCHAIN_MONITOR_ENABLED", true),
    // Min trade size to detect as a "whale trade" - supports both env names for convenience
    // WHALE_TRADE_USD is the simpler name, ONCHAIN_MIN_WHALE_TRADE_USD for backward compatibility
    // DEFAULT: $100 - lower threshold catches more whale activity
    onchainMinWhaleTradeUsd: envNum(
      "WHALE_TRADE_USD",
      envNum("ONCHAIN_MIN_WHALE_TRADE_USD", 100),
    ),
    // Infura tier plan: "core" (free), "developer" ($50/mo), "team" ($225/mo), "growth" (enterprise)
    // Affects rate limiting to avoid hitting API caps
    infuraTier: parseInfuraTierEnv(process.env.INFURA_TIER),

    // Whale Price-Range Filtering - Filter whale trades by price
    // Only whale trades within [WHALE_PRICE_MIN, WHALE_PRICE_MAX] create signals
    // DEFAULT: 0.35-0.65 (35¢-65¢) - matches the bot's preferred entry zone
    // See preferredEntryLowCents (35) and preferredEntryHighCents (65) above
    // Set to empty string to disable filtering (e.g., WHALE_PRICE_MIN= )
    // If min > max, logs a warning and skips filtering
    whalePriceMin: parseOptionalFloatWithDefault(
      process.env.WHALE_PRICE_MIN,
      0.35,
    ),
    whalePriceMax: parseOptionalFloatWithDefault(
      process.env.WHALE_PRICE_MAX,
      0.65,
    ),
  };
}

/**
 * Parse Infura tier from environment variable
 */
function parseInfuraTierEnv(
  tierStr?: string,
): "core" | "developer" | "team" | "growth" {
  const normalized = (tierStr || "").toLowerCase().trim();
  if (normalized === "developer" || normalized === "dev") return "developer";
  if (normalized === "team") return "team";
  if (normalized === "growth" || normalized === "enterprise") return "growth";
  return "core"; // Default to free tier
}

/**
 * Parse liquidation mode from environment variable
 * Supports both new LIQUIDATION_MODE and legacy FORCE_LIQUIDATION
 */
function parseLiquidationMode(value?: string): "off" | "losing" | "all" {
  if (!value) return "off";

  const normalized = value.toLowerCase().trim();

  // New LIQUIDATION_MODE values
  if (
    normalized === "losing" ||
    normalized === "losers" ||
    normalized === "red"
  )
    return "losing";
  if (normalized === "all" || normalized === "everything") return "all";
  if (normalized === "off" || normalized === "false" || normalized === "no")
    return "off";

  // Legacy FORCE_LIQUIDATION=true support (maps to "all")
  if (normalized === "true" || normalized === "yes" || normalized === "1")
    return "all";

  return "off";
}

interface ValidationError {
  field: string;
  message: string;
}

function validateConfig(config: ChurnConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required: wallet key
  if (!config.privateKey) {
    errors.push({ field: "PRIVATE_KEY", message: "Required" });
  }

  // User-configurable: bet size must be positive
  if (config.maxTradeUsd <= 0) {
    errors.push({ field: "MAX_TRADE_USD", message: "Must be positive" });
  }

  return errors;
}

function logConfig(config: ChurnConfig, log: (msg: string) => void): void {
  log("");
  log("🤖 POLYMARKET BOT");
  log("═".repeat(50));
  log("");
  log("💰 YOUR SETTINGS:");
  log(`   Bet size: $${config.maxTradeUsd} per trade`);
  log(
    `   Live trading: ${config.liveTradingEnabled ? "✅ ENABLED" : "⚠️ SIMULATION"}`,
  );
  log(
    `   Telegram: ${config.telegramBotToken && config.telegramChatId ? "✅ ENABLED" : "❌ DISABLED"}`,
  );
  log(`   Debug mode: ${DEBUG ? "✅ ENABLED (verbose logs)" : "❌ DISABLED"}`);
  if (config.liquidationMode !== "off") {
    const modeDesc =
      config.liquidationMode === "losing"
        ? "LOSING ONLY (negative P&L)"
        : "ALL POSITIONS";
    log(`   Liquidation: ⚠️ ${modeDesc}`);
  }
  if (config.copyAnyWhaleBuy) {
    log(`   Copy any whale buy: ⚡ INSTANT COPY MODE (no bias confirmation)`);
  }
  log("");
  log("📊 THE MATH (applied to ALL positions):");
  log(`   Take profit: +${config.tpCents}¢ (avg win)`);
  log(`   Hedge trigger: -${config.hedgeTriggerCents}¢`);
  log(`   Hard stop: -${config.maxAdverseCents}¢`);
  log(`   Avg loss after hedge: ~9¢`);
  log(`   Break-even: 48% win rate`);
  log("");
  log("🐋 WHALE TRACKING:");
  log(`   Following top ${config.leaderboardTopN} wallets`);
  log(
    `   Min trade size: $${config.onchainMinWhaleTradeUsd} (WHALE_TRADE_USD)`,
  );
  if (config.copyAnyWhaleBuy) {
    log(
      `   Mode: INSTANT COPY - copy ANY whale buy ≥ $${config.onchainMinWhaleTradeUsd}`,
    );
  } else {
    log(
      `   Mode: CONFIRMED - need $${config.biasMinNetUsd} flow + ${config.biasMinTrades} trades`,
    );
  }
  log("");
  log("🔍 MARKET SCANNER:");
  log(
    `   Scan active markets: ${config.scanActiveMarkets ? "✅ ENABLED" : "❌ DISABLED"}`,
  );
  if (config.scanActiveMarkets) {
    log(`   Min 24h volume: $${config.scanMinVolumeUsd.toLocaleString()}`);
    log(`   Top markets: ${config.scanTopNMarkets}`);
    log(`   Scan interval: ${config.scanIntervalSeconds}s`);
  }
  log("");
  log("🏦 DYNAMIC RESERVES:");
  log(
    `   Dynamic reserves: ${config.dynamicReservesEnabled ? "✅ ENABLED" : "❌ DISABLED"}`,
  );
  if (config.dynamicReservesEnabled) {
    log(`   Base reserve: ${config.reserveFraction * 100}%`);
    log(`   Max reserve: ${config.maxReserveFraction * 100}%`);
    log(`   Adaptation rate: ${config.reserveAdaptationRate * 100}%`);
  } else {
    log(`   Fixed reserve: ${config.reserveFraction * 100}%`);
  }
  log("");
  log("🛡️ RISK LIMITS:");
  log(`   Reserve: ${config.reserveFraction * 100}% untouchable`);
  log(`   Max exposure: ${config.maxDeployedFractionTotal * 100}%`);
  log(`   Max positions: ${config.maxOpenPositionsTotal}`);
  log("");
  log("═".repeat(50));
}

function calculateEffectiveBankroll(
  walletBalance: number,
  config: ChurnConfig,
): { effectiveBankroll: number; reserveUsd: number } {
  const reserveUsd = Math.max(
    walletBalance * config.reserveFraction,
    config.minReserveUsd,
  );
  const effectiveBankroll = Math.max(0, walletBalance - reserveUsd);
  return { effectiveBankroll, reserveUsd };
}

function calculateTradeSize(
  effectiveBankroll: number,
  config: ChurnConfig,
): number {
  const fractionalSize = effectiveBankroll * config.tradeFraction;
  return Math.min(fractionalSize, config.maxTradeUsd);
}

// ═══════════════════════════════════════════════════════════════════════════
// EV METRICS - Types and classes imported from ./core
// Helper functions (calculatePnlCents, calculatePnlUsd, createTradeResult) imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// BIAS ACCUMULATOR
// BiasDirection type imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

interface LeaderboardTrade {
  tokenId: string;
  marketId?: string;
  wallet: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  timestamp: number;
  price?: number; // Trade price in [0,1] for price-range filtering
}

interface TokenBias {
  tokenId: string;
  marketId?: string;
  direction: BiasDirection;
  netUsd: number;
  tradeCount: number;
  lastActivityTime: number;
  isStale: boolean;
}

interface BiasChangeEvent {
  tokenId: string;
  marketId?: string;
  previousDirection: BiasDirection;
  newDirection: BiasDirection;
  netUsd: number;
  tradeCount: number;
  timestamp: number;
}

class BiasAccumulator {
  private trades: Map<string, LeaderboardTrade[]> = new Map();
  private leaderboardWallets: Set<string> = new Set();
  private lastLeaderboardFetch = 0;
  private readonly config: ChurnConfig;
  private biasChangeCallbacks: ((event: BiasChangeEvent) => void)[] = [];

  // Price range filtering state
  private priceFilterEnabled = false;
  private priceFilterInvalid = false; // true if min > max
  private priceFilterLoggedOnce = false;

  // Funnel metrics tracking
  private funnelStats = {
    tradesIngested: 0,
    tradesFilteredByPrice: 0,
    uniqueTokensWithTrades: 0,
  };

  // API endpoints - using data-api v1 for leaderboard (gamma-api leaderboard is deprecated)
  private readonly DATA_API = "https://data-api.polymarket.com";

  constructor(config: ChurnConfig) {
    this.config = config;
    this.initPriceRangeFilter();
  }

  /**
   * Get funnel statistics for diagnostics
   */
  getFunnelStats(): {
    tradesIngested: number;
    tradesFilteredByPrice: number;
    uniqueTokensWithTrades: number;
  } {
    return {
      ...this.funnelStats,
      uniqueTokensWithTrades: this.trades.size,
    };
  }

  /**
   * Initialize and validate price range filter settings
   */
  private initPriceRangeFilter(): void {
    const { whalePriceMin, whalePriceMax } = this.config;

    // Check if any price range filtering is configured
    if (whalePriceMin !== undefined || whalePriceMax !== undefined) {
      // Validate min <= max if both are set
      if (
        whalePriceMin !== undefined &&
        whalePriceMax !== undefined &&
        whalePriceMin > whalePriceMax
      ) {
        console.warn(
          `⚠️ [Price Filter] WHALE_PRICE_MIN (${whalePriceMin}) > WHALE_PRICE_MAX (${whalePriceMax}) - filter DISABLED`,
        );
        this.priceFilterInvalid = true;
        this.priceFilterEnabled = false;
      } else {
        this.priceFilterEnabled = true;
        const minStr =
          whalePriceMin !== undefined
            ? `${(whalePriceMin * 100).toFixed(0)}¢`
            : "none";
        const maxStr =
          whalePriceMax !== undefined
            ? `${(whalePriceMax * 100).toFixed(0)}¢`
            : "none";
        console.log(
          `🎯 [Price Filter] Whale trades filtered to price range: min=${minStr}, max=${maxStr}`,
        );
      }
    }
  }

  /**
   * Check if a trade passes the price range filter
   * Returns true if trade should be included, false if filtered out
   */
  private passesWhalePriceFilter(trade: LeaderboardTrade): boolean {
    // If filter is disabled or invalid, pass all trades
    if (!this.priceFilterEnabled || this.priceFilterInvalid) {
      return true;
    }

    const { whalePriceMin, whalePriceMax } = this.config;
    const price = trade.price;

    // If no price available on trade, pass it through (can't filter)
    if (price === undefined || price === null) {
      return true;
    }

    // Check minimum bound
    if (whalePriceMin !== undefined && price < whalePriceMin) {
      if (!this.priceFilterLoggedOnce) {
        debug(
          `[Price Filter] Trade filtered: price ${(price * 100).toFixed(1)}¢ < min ${(whalePriceMin * 100).toFixed(1)}¢`,
        );
      }
      return false;
    }

    // Check maximum bound
    if (whalePriceMax !== undefined && price > whalePriceMax) {
      if (!this.priceFilterLoggedOnce) {
        debug(
          `[Price Filter] Trade filtered: price ${(price * 100).toFixed(1)}¢ > max ${(whalePriceMax * 100).toFixed(1)}¢`,
        );
      }
      return false;
    }

    return true;
  }

  /**
   * Register callback for bias changes
   */
  onBiasChange(callback: (event: BiasChangeEvent) => void): void {
    this.biasChangeCallbacks.push(callback);
  }

  /**
   * Fetch top leaderboard wallets from v1 API
   * Uses proxyWallet from response (that's where positions are held)
   * Handles pagination since API may limit results per page
   */
  async refreshLeaderboard(): Promise<string[]> {
    const now = Date.now();
    // Only fetch hourly - the math works regardless, this just refreshes our whale list
    if (now - this.lastLeaderboardFetch < 60 * 60 * 1000) {
      return Array.from(this.leaderboardWallets);
    }

    // Define targetCount outside try block so it's accessible in catch
    const targetCount = this.config.leaderboardTopN;

    try {
      // Fetch with pagination to get the full requested count
      // API may limit to 50 per page, so we paginate if needed
      const pageSize = 50; // Max per page (API limit)
      const allEntries: any[] = [];

      let offset = 0;
      while (allEntries.length < targetCount) {
        const remaining = targetCount - allEntries.length;
        const limit = Math.min(pageSize, remaining);

        // Use v1 leaderboard API with PNL ordering to get top performers
        const url = `${this.DATA_API}/v1/leaderboard?category=OVERALL&timePeriod=WEEK&orderBy=PNL&limit=${limit}&offset=${offset}`;
        const { data } = await axios.get(url, { timeout: 10000 });

        if (!Array.isArray(data) || data.length === 0) {
          break; // No more results
        }

        allEntries.push(...data);
        offset += data.length;

        // If we got less than requested, no more pages
        if (data.length < limit) {
          break;
        }
      }

      if (allEntries.length > 0) {
        this.leaderboardWallets.clear();

        // Show top 10 at startup to verify it's working, sorted by last traded
        const isFirstFetch = this.lastLeaderboardFetch === 0;
        if (isFirstFetch) {
          // Fetch last activity for top 10 traders (parallel requests)
          const top10 = allEntries.slice(0, 10);
          const activityPromises = top10.map(async (entry) => {
            const wallet = entry.proxyWallet || entry.address;
            if (!wallet) return { ...entry, lastTraded: 0 };
            try {
              const { data } = await axios.get(
                `${this.DATA_API}/activity?user=${wallet}&limit=1&sortBy=TIMESTAMP&sortDirection=DESC`,
                { timeout: 5000 },
              );
              const lastTraded =
                Array.isArray(data) && data.length > 0
                  ? Number(data[0].timestamp || 0) * 1000
                  : 0;
              return { ...entry, lastTraded };
            } catch (err) {
              // Activity fetch failed - trader may have no activity or API issue
              // Continue gracefully - they'll show with N/A timestamp
              console.debug?.(
                `   Activity fetch for ${wallet.slice(0, 10)}... failed: ${err instanceof Error ? err.message : "Unknown"}`,
              );
              return { ...entry, lastTraded: 0 };
            }
          });

          const top10WithActivity = await Promise.all(activityPromises);

          // Sort by last traded (most recent first)
          top10WithActivity.sort((a, b) => b.lastTraded - a.lastTraded);

          console.log(
            `\n🐋 TOP 10 TRADERS (sorted by last traded, from ${allEntries.length} tracked):`,
          );
          for (const entry of top10WithActivity) {
            const wallet = (entry.proxyWallet || entry.address || "").slice(
              0,
              12,
            );
            const pnl = Number(entry.pnl || 0);
            const vol = Number(entry.vol || 0);
            const name = entry.userName || "anon";
            const lastTradedStr =
              entry.lastTraded > 0
                ? new Date(entry.lastTraded)
                    .toISOString()
                    .replace("T", " ")
                    .slice(0, 19) + " UTC"
                : "N/A";
            console.log(
              `   ${wallet}... | Last: ${lastTradedStr} | PNL: $${pnl >= 1000 ? (pnl / 1000).toFixed(0) + "k" : pnl.toFixed(0)} | Vol: $${vol >= 1000 ? (vol / 1000).toFixed(0) + "k" : vol.toFixed(0)} | @${name}`,
            );
          }
          console.log("");
        }

        for (const entry of allEntries) {
          // Use proxyWallet (where trades happen) or fallback to address
          const wallet = entry.proxyWallet || entry.address;
          if (wallet) {
            this.leaderboardWallets.add(wallet.toLowerCase());
          }
        }
        this.lastLeaderboardFetch = now;
        const trackedCount = this.leaderboardWallets.size;
        console.log(
          `🐋 Tracking ${trackedCount} top traders (requested: ${targetCount})`,
        );

        // Report if we got significantly fewer wallets than requested (potential issue)
        if (trackedCount < targetCount * 0.95) {
          reportError(
            "Leaderboard Wallet Count Mismatch",
            `Got ${trackedCount} unique wallets instead of requested ${targetCount}. May have duplicates or API limit.`,
            "info",
            {
              trackedCount,
              requestedCount: targetCount,
              entriesReturned: allEntries.length,
            },
          );
        }
      }
    } catch (err) {
      // Keep existing wallets on error
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Leaderboard fetch failed: ${errorMsg}`);
      reportError("Leaderboard Fetch Failed", errorMsg, "warning", {
        requestedCount: targetCount,
      });
    }

    return Array.from(this.leaderboardWallets);
  }

  /**
   * Fetch recent trades for leaderboard wallets - PARALLEL EXECUTION
   * Only tracks BUY trades - we have our own exit math, don't copy sells
   * Uses rotating batch to cover all wallets over multiple cycles
   */
  async fetchLeaderboardTrades(): Promise<LeaderboardTrade[]> {
    const wallets = await this.refreshLeaderboard();
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    if (wallets.length === 0) {
      return [];
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ROTATING BATCH: Cover all wallets over multiple cycles
    // Process BATCH_SIZE wallets per cycle, rotating through the full list
    // ═══════════════════════════════════════════════════════════════════════════
    const BATCH_SIZE = 20;
    const startIdx = (this.fetchCount * BATCH_SIZE) % wallets.length;
    const endIdx = Math.min(startIdx + BATCH_SIZE, wallets.length);
    const batchWallets = wallets.slice(startIdx, endIdx);

    // Log when coverage is limited
    if (wallets.length > BATCH_SIZE && this.fetchCount % 10 === 0) {
      const cyclesForFullCoverage = Math.ceil(wallets.length / BATCH_SIZE);
      console.log(
        `📊 [API] Rotating batch: wallets ${startIdx + 1}-${endIdx} of ${wallets.length} (full coverage in ${cyclesForFullCoverage} cycles)`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DIAGNOSTIC: Track API fetch results
    // ═══════════════════════════════════════════════════════════════════════════
    let totalFetches = 0;
    let successfulFetches = 0;
    let emptyResponses = 0;
    let totalTradesFound = 0;
    let tradesInWindow = 0;

    // Fetch batch wallets in parallel for speed
    // API can handle concurrent requests, and we want to catch whale movement FAST
    const fetchPromises = batchWallets.map(async (wallet) => {
      totalFetches++;
      try {
        // Use ACTIVITY endpoint (like Novus-Tech-LLC does)
        const url = `${this.DATA_API}/activity?user=${wallet}&limit=20`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (!Array.isArray(data)) {
          emptyResponses++;
          return [];
        }

        if (data.length === 0) {
          emptyResponses++;
          return [];
        }

        successfulFetches++;

        const trades: LeaderboardTrade[] = [];
        for (const activity of data) {
          // Only look at TRADE type activities
          if (activity.type !== "TRADE") continue;

          totalTradesFound++;

          // Only track BUY trades - we don't copy sells, we have our own exit math
          if (activity.side?.toUpperCase() !== "BUY") continue;

          const rawTimestamp = activity.timestamp;
          let timestamp: number;
          if (typeof rawTimestamp === "number") {
            // If the numeric timestamp is very large, assume it's already in ms
            timestamp =
              rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
          } else if (
            typeof rawTimestamp === "string" &&
            /^\d+$/.test(rawTimestamp)
          ) {
            const numericTimestamp = Number(rawTimestamp);
            timestamp =
              numericTimestamp > 1e12
                ? numericTimestamp
                : numericTimestamp * 1000;
          } else {
            // Fallback for ISO strings or other date representations
            timestamp = new Date(rawTimestamp).getTime();
          }

          // Only trades within window
          if (timestamp < windowStart) continue;

          tradesInWindow++;

          // TASK 4: Validate token ID mapping - add diagnostics
          const tokenId = activity.asset || activity.tokenId;
          const conditionId = activity.conditionId ?? activity.marketId;
          const outcome = activity.outcome; // YES/NO

          // Reject if tokenId is empty or invalid
          if (!tokenId || tokenId.trim() === "") {
            debug(
              `[Whale Trade] Rejected: empty tokenId | conditionId: ${conditionId || "N/A"} | outcome: ${outcome || "N/A"} | wallet: ${(wallet ?? "unknown").slice(0, 10)}...`,
            );
            continue;
          }

          const tradePrice = Number(activity.price) || 0;
          const sizeUsd =
            activity.usdcSize ?? (Number(activity.size) * tradePrice || 0);
          if (sizeUsd <= 0) continue;

          // Log candidate construction for diagnostics
          if (DEBUG) {
            debug(
              `[Whale Trade] Candidate: tokenId=${tokenId.slice(0, 12)}... | conditionId=${conditionId?.slice(0, 12) || "N/A"} | outcome=${outcome || "N/A"} | size=$${sizeUsd.toFixed(0)}`,
            );
          }

          trades.push({
            tokenId,
            marketId: activity.conditionId ?? activity.marketId,
            wallet: wallet,
            side: "BUY", // Only BUY trades
            sizeUsd,
            timestamp,
            price: tradePrice > 0 ? tradePrice : undefined,
          });
        }
        return trades;
      } catch (err) {
        // Log errors - keep visible in production, but also debug
        const errMsg = err instanceof Error ? err.message : String(err);
        // Only log to console if it's not a timeout/network issue (those are noisy)
        if (!errMsg.includes("timeout") && !errMsg.includes("ECONNRESET")) {
          console.warn(
            `[API] Fetch failed for ${wallet.slice(0, 10)}...: ${errMsg}`,
          );
        } else {
          debug(`[API] Fetch failed for ${wallet.slice(0, 10)}...: ${errMsg}`);
        }
        return [];
      }
    });

    // Wait for all fetches to complete in parallel
    const results = await Promise.all(fetchPromises);
    const newTrades = results.flat();

    // ═══════════════════════════════════════════════════════════════════════════
    // DIAGNOSTIC: Log API fetch results - show first 5, then every 10th, or when trades found
    // ═══════════════════════════════════════════════════════════════════════════
    if (
      this.fetchCount < 5 ||
      this.fetchCount % 10 === 0 ||
      newTrades.length > 0
    ) {
      const cyclesForFullCoverage = Math.ceil(wallets.length / BATCH_SIZE);
      console.log(
        `📊 [API Poll #${this.fetchCount}] Batch ${startIdx + 1}-${endIdx} of ${wallets.length} wallets (cycle ${(this.fetchCount % cyclesForFullCoverage) + 1}/${cyclesForFullCoverage}) | ` +
          `Success: ${successfulFetches} | Trades found: ${totalTradesFound} | In window: ${tradesInWindow} | New BUYs: ${newTrades.length}`,
      );
    }

    // Debug: Show individual trades found
    if (DEBUG && newTrades.length > 0) {
      for (const trade of newTrades.slice(0, 5)) {
        debug(
          `  Trade: ${trade.tokenId.slice(0, 12)}... | $${trade.sizeUsd.toFixed(0)} | wallet: ${trade.wallet.slice(0, 10)}...`,
        );
      }
      if (newTrades.length > 5) {
        debug(`  ... and ${newTrades.length - 5} more trades`);
      }
    }

    this.fetchCount++;

    // Add to accumulator and prune old trades
    this.addTrades(newTrades);

    return newTrades;
  }

  private fetchCount = 0;

  /**
   * Add trades and maintain window
   * Deduplicates by txHash+tokenId+wallet to prevent counting the same trade twice
   * (e.g., from both on-chain events and API polling)
   *
   * Also applies price-range filtering if WHALE_PRICE_MIN/MAX are configured
   */
  private addTrades(trades: LeaderboardTrade[]): void {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    // Track ingested trades in funnel
    this.funnelStats.tradesIngested += trades.length;

    // Apply price range filtering
    let filteredCount = 0;
    const filteredTrades = trades.filter((trade) => {
      if (this.passesWhalePriceFilter(trade)) {
        return true;
      }
      filteredCount++;
      return false;
    });

    // Track filtered trades in funnel
    this.funnelStats.tradesFilteredByPrice += filteredCount;

    // Log filtering summary (once per batch if any filtered)
    if (filteredCount > 0 && this.priceFilterEnabled) {
      const { whalePriceMin, whalePriceMax } = this.config;
      const minStr =
        whalePriceMin !== undefined
          ? `${(whalePriceMin * 100).toFixed(0)}¢`
          : "none";
      const maxStr =
        whalePriceMax !== undefined
          ? `${(whalePriceMax * 100).toFixed(0)}¢`
          : "none";
      console.log(
        `🎯 [Price Filter] Filtered ${filteredCount}/${trades.length} whale trades (range: ${minStr}-${maxStr})`,
      );
      this.priceFilterLoggedOnce = true;
    }

    for (const trade of filteredTrades) {
      const existing = this.trades.get(trade.tokenId) || [];

      // Deduplication: check if this trade already exists
      // Use a composite key of timestamp + wallet + size to identify duplicates
      // (On-chain and API trades may have slightly different timestamps)
      const isDuplicate = existing.some(
        (t) =>
          t.wallet.toLowerCase() === trade.wallet.toLowerCase() &&
          Math.abs(t.sizeUsd - trade.sizeUsd) < 0.01 && // Same size (within rounding)
          Math.abs(t.timestamp - trade.timestamp) < 60000, // Within 1 minute
      );

      if (!isDuplicate) {
        existing.push(trade);
        this.trades.set(trade.tokenId, existing);
      }
    }

    // Prune old trades from all tokens
    for (const [tokenId, tokenTrades] of this.trades.entries()) {
      const recent = tokenTrades.filter((t) => t.timestamp >= windowStart);
      if (recent.length === 0) {
        this.trades.delete(tokenId);
      } else {
        this.trades.set(tokenId, recent);
      }
    }
  }

  /**
   * Get bias for a specific token
   * Since we only track BUY trades, positive netUsd = whales are buying = LONG signal
   */
  getBias(tokenId: string): TokenBias {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;
    const staleThreshold = now - this.config.biasStaleSeconds * 1000;

    const tokenTrades = this.trades.get(tokenId) || [];
    const recentTrades = tokenTrades.filter((t) => t.timestamp >= windowStart);

    // Sum up BUY volume (we only track BUYs)
    let netUsd = 0;
    let lastActivityTime = 0;

    for (const trade of recentTrades) {
      // All trades are BUYs now (we filter in fetchLeaderboardTrades)
      netUsd += trade.sizeUsd;
      if (trade.timestamp > lastActivityTime) {
        lastActivityTime = trade.timestamp;
      }
    }

    const tradeCount = recentTrades.length;
    const isStale = lastActivityTime > 0 && lastActivityTime < staleThreshold;

    // Determine direction - STRICT eligibility check
    // In copyAnyWhaleBuy mode: allow 1 trade minimum
    // Otherwise: require ALL criteria (flow >= min, trades >= min, not stale)
    let direction: BiasDirection = "NONE";

    if (this.config.copyAnyWhaleBuy) {
      // Copy-any-buy mode: just need 1 trade and not stale
      if (tradeCount >= 1 && !isStale) {
        direction = "LONG";
      }
    } else {
      // Conservative mode: ALL criteria must be met
      if (
        !isStale &&
        tradeCount >= this.config.biasMinTrades &&
        netUsd >= this.config.biasMinNetUsd
      ) {
        direction = "LONG";
      }
    }

    return {
      tokenId,
      marketId: recentTrades[0]?.marketId,
      direction,
      netUsd,
      tradeCount,
      lastActivityTime,
      isStale,
    };
  }

  /**
   * Get all tokens with active bias
   */
  getActiveBiases(): TokenBias[] {
    const biases: TokenBias[] = [];

    for (const tokenId of this.trades.keys()) {
      const bias = this.getBias(tokenId);

      // COPY_ANY_WHALE_BUY mode: return ANY token with at least 1 whale buy
      // This is the key fix - we don't need 3 trades or $300 flow to copy
      if (this.config.copyAnyWhaleBuy) {
        // Return as LONG if we have at least 1 trade (all trades are BUYs)
        if (bias.tradeCount >= 1 && !bias.isStale) {
          // Override direction to LONG since we're in copy-any-buy mode
          biases.push({
            ...bias,
            direction: "LONG",
          });
        }
      } else {
        // Conservative mode: require full bias confirmation
        // Only add if direction is LONG (which means ALL criteria passed)
        if (bias.direction === "LONG") {
          biases.push(bias);
        }
      }
    }

    return biases;
  }

  /**
   * Check if bias allows entry for a token
   */
  canEnter(tokenId: string): { allowed: boolean; reason?: string } {
    // COPY_ANY_WHALE_BUY mode: allow entry if we've seen ANY whale buy on this token
    // No need for $300 flow or 3 trades - just one whale buy is enough
    if (this.config.copyAnyWhaleBuy) {
      const bias = this.getBias(tokenId);
      // Allow if we've seen at least 1 trade (which must be a BUY since we only track buys)
      // Also check staleness for consistency with getActiveBiases()
      if (bias.tradeCount >= 1 && !bias.isStale) {
        return { allowed: true };
      }
      if (bias.isStale) {
        return {
          allowed: false,
          reason: `BIAS_STALE (last: ${Math.round((Date.now() - bias.lastActivityTime) / 1000)}s ago)`,
        };
      }
      return { allowed: false, reason: "NO_WHALE_BUY_SEEN" };
    }

    if (!this.config.allowEntriesOnlyWithBias) {
      return { allowed: true };
    }

    const bias = this.getBias(tokenId);

    // Strict eligibility: check ALL criteria
    if (bias.direction === "NONE") {
      if (bias.isStale) {
        return {
          allowed: false,
          reason: `BIAS_STALE (last: ${Math.round((Date.now() - bias.lastActivityTime) / 1000)}s ago)`,
        };
      }
      if (bias.tradeCount < this.config.biasMinTrades) {
        return {
          allowed: false,
          reason: `BIAS_BELOW_MIN_TRADES (${bias.tradeCount} < ${this.config.biasMinTrades})`,
        };
      }
      if (bias.netUsd < this.config.biasMinNetUsd) {
        return {
          allowed: false,
          reason: `BIAS_BELOW_MIN_FLOW ($${bias.netUsd.toFixed(0)} < $${this.config.biasMinNetUsd})`,
        };
      }
      return {
        allowed: false,
        reason: `BIAS_NONE (net=$${bias.netUsd.toFixed(0)}, trades=${bias.tradeCount})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a manual trade observation (for testing or direct integration)
   */
  recordTrade(trade: LeaderboardTrade): void {
    if (!this.leaderboardWallets.has(trade.wallet.toLowerCase())) {
      return; // Ignore non-leaderboard wallets
    }

    const previousBias = this.getBias(trade.tokenId);
    this.addTrades([trade]);
    const newBias = this.getBias(trade.tokenId);

    // Fire callback if direction changed
    if (previousBias.direction !== newBias.direction) {
      const event: BiasChangeEvent = {
        tokenId: trade.tokenId,
        marketId: trade.marketId,
        previousDirection: previousBias.direction,
        newDirection: newBias.direction,
        netUsd: newBias.netUsd,
        tradeCount: newBias.tradeCount,
        timestamp: Date.now(),
      };

      for (const callback of this.biasChangeCallbacks) {
        callback(event);
      }
    }
  }

  /**
   * Add wallet to leaderboard manually (for testing)
   */
  addLeaderboardWallet(wallet: string): void {
    this.leaderboardWallets.add(wallet.toLowerCase());
  }

  /**
   * Get the count of tracked leaderboard wallets
   */
  getTrackedWalletCount(): number {
    return this.leaderboardWallets.size;
  }

  /**
   * Get the set of tracked whale wallets (for on-chain monitoring)
   * Returns a reference to the internal Set - updates automatically when leaderboard refreshes
   */
  getWhaleWallets(): Set<string> {
    return this.leaderboardWallets;
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.trades.clear();
    this.leaderboardWallets.clear();
    this.lastLeaderboardFetch = 0;
  }

  /**
   * Convert to JSON log entry
   */
  toLogEntry(): object {
    const activeBiases = this.getActiveBiases();
    return {
      type: "bias_state",
      timestamp: new Date().toISOString(),
      leaderboardWallets: this.leaderboardWallets.size,
      totalTokensTracked: this.trades.size,
      activeBiases: activeBiases.map((b) => ({
        tokenId: b.tokenId.slice(0, 12) + "...",
        direction: b.direction,
        netUsd: parseFloat(b.netUsd.toFixed(2)),
        tradeCount: b.tradeCount,
        isStale: b.isStale,
      })),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET SCANNER - Scan for most active/trending markets
// ═══════════════════════════════════════════════════════════════════════════

interface ActiveMarket {
  tokenId: string;
  conditionId: string;
  marketId: string;
  question: string;
  volume24h: number;
  price: number;
  lastTradeTime: number;
}

class MarketScanner {
  private readonly config: ChurnConfig;
  private readonly DATA_API = "https://data-api.polymarket.com";
  private readonly GAMMA_API = "https://gamma-api.polymarket.com";
  private activeMarkets: ActiveMarket[] = [];
  private lastScanTime = 0;

  constructor(config: ChurnConfig) {
    this.config = config;
  }

  /**
   * Scan for the most active markets on Polymarket
   * Returns markets sorted by 24h volume that meet minimum criteria
   */
  async scanActiveMarkets(): Promise<ActiveMarket[]> {
    const now = Date.now();

    // Only scan at configured interval
    if (now - this.lastScanTime < this.config.scanIntervalSeconds * 1000) {
      return this.activeMarkets;
    }

    try {
      // Fetch active markets from Gamma API sorted by volume
      const url = `${this.GAMMA_API}/markets?closed=false&active=true&limit=${this.config.scanTopNMarkets * 2}&order=volume24hr&ascending=false`;
      const { data } = await axios.get(url, { timeout: 10000 });

      if (!Array.isArray(data)) {
        console.warn("[Scanner] Invalid response from markets API");
        return this.activeMarkets;
      }

      const markets: ActiveMarket[] = [];

      for (const market of data) {
        try {
          // Parse token IDs from clobTokenIds JSON string
          const tokenIds = JSON.parse(market.clobTokenIds || "[]");
          if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;

          const volume24h = parseFloat(market.volume24hr || "0");

          // Skip markets below minimum volume
          if (volume24h < this.config.scanMinVolumeUsd) continue;

          // Parse prices
          const prices = JSON.parse(market.outcomePrices || "[]");
          const yesPrice = parseFloat(prices[0] || "0.5");

          // Only consider markets in tradeable price range (20-80¢)
          if (yesPrice < 0.2 || yesPrice > 0.8) continue;

          markets.push({
            tokenId: tokenIds[0], // YES token
            conditionId: market.conditionId,
            marketId: market.id,
            question: market.question || "Unknown",
            volume24h,
            price: yesPrice,
            lastTradeTime: new Date(market.updatedAt || Date.now()).getTime(),
          });
        } catch {
          // Skip malformed market entries
          continue;
        }
      }

      // Sort by volume and take top N
      this.activeMarkets = markets
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, this.config.scanTopNMarkets);

      this.lastScanTime = now;

      if (this.activeMarkets.length > 0) {
        console.log(
          `📊 Scanned ${this.activeMarkets.length} active markets (top by 24h volume)`,
        );
      }

      return this.activeMarkets;
    } catch (err) {
      console.warn(
        `[Scanner] Failed to scan markets: ${err instanceof Error ? err.message : err}`,
      );
      return this.activeMarkets;
    }
  }

  /**
   * Get token IDs from scanned active markets
   * These can be used as additional trading opportunities
   */
  getActiveTokenIds(): string[] {
    return this.activeMarkets.map((m) => m.tokenId);
  }

  /**
   * Get count of active markets being tracked
   */
  getActiveMarketCount(): number {
    return this.activeMarkets.length;
  }

  /**
   * Clear scanner cache (for testing)
   */
  clear(): void {
    this.activeMarkets = [];
    this.lastScanTime = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC RESERVES - Self-balancing reserve system
// ═══════════════════════════════════════════════════════════════════════════

interface MissedOpportunity {
  tokenId: string;
  sizeUsd: number;
  reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED";
  timestamp: number;
}

interface DynamicReserveState {
  baseReserveFraction: number;
  adaptedReserveFraction: number;
  missedOpportunitiesUsd: number;
  hedgeNeedsUsd: number;
  missedCount: number;
  hedgesMissed: number;
}

class DynamicReserveManager {
  private readonly config: ChurnConfig;
  private missedOpportunities: MissedOpportunity[] = [];
  private hedgesMissed = 0;
  private adaptedReserveFraction: number;
  private readonly WINDOW_MS = 30 * 60 * 1000; // 30 minute window

  constructor(config: ChurnConfig) {
    this.config = config;
    this.adaptedReserveFraction = config.reserveFraction;
  }

  /**
   * Record a missed trading opportunity due to insufficient reserves
   */
  recordMissedOpportunity(
    tokenId: string,
    sizeUsd: number,
    reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED",
  ): void {
    if (!this.config.dynamicReservesEnabled) return;

    this.missedOpportunities.push({
      tokenId,
      sizeUsd,
      reason,
      timestamp: Date.now(),
    });

    // Prune old entries
    this.pruneOldEntries();

    // Adapt reserves
    this.adaptReserves();
  }

  /**
   * Record a missed hedge opportunity
   */
  recordMissedHedge(sizeUsd: number): void {
    if (!this.config.dynamicReservesEnabled) return;
    this.hedgesMissed++;
    this.adaptReserves();
  }

  /**
   * Get the dynamically calculated effective reserve fraction
   * Balances between:
   * - Base reserve fraction (configured minimum)
   * - Missed opportunities (need more capital available)
   * - Hedge needs (need reserve for hedging)
   */
  getEffectiveReserveFraction(): number {
    if (!this.config.dynamicReservesEnabled) {
      return this.config.reserveFraction;
    }
    return this.adaptedReserveFraction;
  }

  /**
   * Calculate effective bankroll with dynamic reserves
   */
  getEffectiveBankroll(balance: number): {
    effectiveBankroll: number;
    reserveUsd: number;
  } {
    const reserveFraction = this.getEffectiveReserveFraction();
    const reserveUsd = Math.max(
      balance * reserveFraction,
      this.config.minReserveUsd,
    );
    return {
      effectiveBankroll: Math.max(0, balance - reserveUsd),
      reserveUsd,
    };
  }

  /**
   * Adapt reserves based on missed opportunities and hedge needs
   */
  private adaptReserves(): void {
    this.pruneOldEntries();

    const now = Date.now();
    const windowStart = now - this.WINDOW_MS;

    // Count recent missed opportunities
    const recentMissed = this.missedOpportunities.filter(
      (m) => m.timestamp >= windowStart,
    );
    const missedCount = recentMissed.length;

    // Calculate adjustment factors
    // More missed opportunities → LOWER reserves (need more capital available)
    // More missed hedges → HIGHER reserves (need capital for hedging)

    const missedFactor = Math.min(missedCount * 0.02, 0.15); // Up to 15% reduction
    const hedgeFactor = Math.min(this.hedgesMissed * 0.03, 0.1); // Up to 10% increase

    // Apply weighted adjustments
    const missedAdjustment = missedFactor * this.config.missedOpportunityWeight;
    const hedgeAdjustment = hedgeFactor * this.config.hedgeCoverageWeight;

    // Calculate target reserve fraction
    const targetFraction =
      this.config.reserveFraction - missedAdjustment + hedgeAdjustment;

    // Clamp to valid range
    const clampedTarget = Math.max(
      0.1,
      Math.min(this.config.maxReserveFraction, targetFraction),
    );

    // Smooth adaptation
    this.adaptedReserveFraction =
      this.adaptedReserveFraction +
      (clampedTarget - this.adaptedReserveFraction) *
        this.config.reserveAdaptationRate;
  }

  /**
   * Remove old entries outside the window
   */
  private pruneOldEntries(): void {
    const cutoff = Date.now() - this.WINDOW_MS;
    this.missedOpportunities = this.missedOpportunities.filter(
      (m) => m.timestamp >= cutoff,
    );

    // Decay hedges missed over time
    if (this.hedgesMissed > 0 && this.missedOpportunities.length === 0) {
      this.hedgesMissed = Math.max(0, this.hedgesMissed - 1);
    }
  }

  /**
   * Get current state for logging
   */
  getState(): DynamicReserveState {
    this.pruneOldEntries();
    const recentMissed = this.missedOpportunities;

    return {
      baseReserveFraction: this.config.reserveFraction,
      adaptedReserveFraction: this.adaptedReserveFraction,
      missedOpportunitiesUsd: recentMissed.reduce(
        (sum, m) => sum + m.sizeUsd,
        0,
      ),
      hedgeNeedsUsd:
        this.hedgesMissed * this.config.maxTradeUsd * this.config.hedgeRatio,
      missedCount: recentMissed.length,
      hedgesMissed: this.hedgesMissed,
    };
  }

  /**
   * Reset state (for testing or after liquidation)
   */
  reset(): void {
    this.missedOpportunities = [];
    this.hedgesMissed = 0;
    this.adaptedReserveFraction = this.config.reserveFraction;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION STATE MACHINE - Types and PositionManager class imported from ./core
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// DECISION ENGINE - Types and DecisionEngine class imported from ./core
// ═══════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ENGINE - Types and ExecutionEngine class imported from ./core
// ExecutionResult, TokenMarketData, ChurnLogger interfaces imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA FETCH RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Reason codes for market data fetch failures */
type MarketDataFailureReason =
  | "NO_ORDERBOOK" // Market closed/settled, no orderbook exists
  | "NOT_FOUND" // Token ID not found in system
  | "RATE_LIMIT" // API rate limit hit
  | "NETWORK_ERROR" // Network/connection failure
  | "PARSE_ERROR" // Response parsing failed
  | "INVALID_LIQUIDITY" // Spread too wide (permanent market condition)
  | "DUST_BOOK" // 1¢/99¢ spreads - no room to trade (permanent)
  | "INVALID_PRICES"; // Missing/zero/NaN prices (permanent)

/** Structured result from fetchTokenMarketData */
type FetchMarketDataResult =
  | { ok: true; data: TokenMarketData }
  | { ok: false; reason: MarketDataFailureReason; detail?: string };

/** Check if failure reason warrants long cooldown (market legitimately inactive) */
function shouldApplyLongCooldown(reason: MarketDataFailureReason): boolean {
  return reason === "NO_ORDERBOOK" || reason === "NOT_FOUND";
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET DATA COOLDOWN MANAGER - Exponential backoff for inactive markets
// ═══════════════════════════════════════════════════════════════════════════

interface CooldownEntry {
  strikes: number; // Consecutive failures
  nextEligibleTime: number; // Timestamp when retry is allowed
  lastReason: MarketDataFailureReason;
}

interface CooldownStats {
  cooldownHits: number; // Total times a token was blocked by cooldown
  totalTokensCooledDown: number; // Total times tokens have been put into cooldown since start (may count the same token multiple times)
  resolvedLaterCount: number; // Tokens that succeeded after being in cooldown
}

class MarketDataCooldownManager {
  // Backoff schedule: 10m, 30m, 2h, 24h cap
  private static readonly BACKOFF_SCHEDULE_MS = [
    10 * 60 * 1000, // 10 minutes
    30 * 60 * 1000, // 30 minutes
    2 * 60 * 60 * 1000, // 2 hours
    24 * 60 * 60 * 1000, // 24 hours (cap)
  ];

  private cooldowns = new Map<string, CooldownEntry>();
  private stats: CooldownStats = {
    cooldownHits: 0,
    totalTokensCooledDown: 0,
    resolvedLaterCount: 0,
  };

  /**
   * Check if a token is currently on cooldown
   * @returns true if blocked, false if eligible for retry
   */
  isOnCooldown(tokenId: string): boolean {
    const entry = this.cooldowns.get(tokenId);
    if (!entry) return false;

    const now = Date.now();
    if (now >= entry.nextEligibleTime) {
      return false; // Cooldown expired, eligible for retry
    }

    this.stats.cooldownHits++;
    return true;
  }

  /**
   * Record a failure and apply exponential backoff
   * Only applies long cooldown for NO_ORDERBOOK/NOT_FOUND
   * Transient errors (RATE_LIMIT, NETWORK_ERROR, PARSE_ERROR) use short cooldown
   * but don't reset existing strikes from long-cooldown failures
   */
  recordFailure(tokenId: string, reason: MarketDataFailureReason): number {
    const now = Date.now();
    const existing = this.cooldowns.get(tokenId);

    // For transient errors (RATE_LIMIT, NETWORK_ERROR, PARSE_ERROR), use short 30s cooldown
    // Preserve existing strikes only if they came from long-cooldown failures (strikes > 1)
    if (!shouldApplyLongCooldown(reason)) {
      const shortCooldownMs = 30 * 1000; // 30 seconds
      // If we have strikes > 1, it means previous long-cooldown failures occurred - preserve them
      // Otherwise, keep strikes at 1 (no accumulation for transient errors)
      const preservedStrikes =
        existing && existing.strikes > 1 ? existing.strikes : 1;
      this.cooldowns.set(tokenId, {
        strikes: preservedStrikes,
        nextEligibleTime: now + shortCooldownMs,
        lastReason: reason,
      });
      return shortCooldownMs;
    }

    // For NO_ORDERBOOK/NOT_FOUND, apply exponential backoff
    // Increment strikes only if:
    // 1. strikes > 1 (we have accumulated long-cooldown failures), OR
    // 2. The previous failure was a long-cooldown type (meaning we're at strike 1 from that)
    // This ensures transient-only tokens start fresh when they first get a long-cooldown failure
    const shouldIncrement =
      existing &&
      (existing.strikes > 1 || shouldApplyLongCooldown(existing.lastReason));
    const strikes = shouldIncrement ? existing.strikes + 1 : 1;
    const backoffIndex = Math.min(
      strikes - 1,
      MarketDataCooldownManager.BACKOFF_SCHEDULE_MS.length - 1,
    );
    const cooldownMs =
      MarketDataCooldownManager.BACKOFF_SCHEDULE_MS[backoffIndex];

    const wasNew = !this.cooldowns.has(tokenId);
    this.cooldowns.set(tokenId, {
      strikes,
      nextEligibleTime: now + cooldownMs,
      lastReason: reason,
    });

    if (wasNew) {
      this.stats.totalTokensCooledDown++;
    }

    return cooldownMs;
  }

  /**
   * Record a successful fetch - reset backoff for the token
   */
  recordSuccess(tokenId: string): void {
    if (this.cooldowns.has(tokenId)) {
      this.stats.resolvedLaterCount++;
      this.cooldowns.delete(tokenId);
    }
  }

  /**
   * Get cooldown info for a token (for logging)
   */
  getCooldownInfo(tokenId: string): {
    strikes: number;
    nextEligibleTime: number;
    lastReason: MarketDataFailureReason;
  } | null {
    return this.cooldowns.get(tokenId) || null;
  }

  /**
   * Get current stats
   */
  getStats(): CooldownStats {
    return { ...this.stats };
  }

  /**
   * Get count of tokens currently on cooldown
   */
  getActiveCooldownCount(): number {
    const now = Date.now();
    let count = 0;
    for (const entry of this.cooldowns.values()) {
      if (now < entry.nextEligibleTime) count++;
    }
    return count;
  }

  /**
   * Clean up expired cooldowns (call periodically)
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [tokenId, entry] of this.cooldowns.entries()) {
      // Remove entries that have been expired for more than 1 hour
      if (now > entry.nextEligibleTime + 60 * 60 * 1000) {
        this.cooldowns.delete(tokenId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Format cooldown duration for logging
   */
  static formatDuration(ms: number): string {
    if (ms < 60 * 1000) return `${Math.round(ms / 1000)}s`;
    if (ms < 60 * 60 * 1000) return `${Math.round(ms / 60 / 1000)}m`;
    return `${(ms / 60 / 60 / 1000).toFixed(1)}h`;
  }
}

// ChurnLogger interface imported from ./core

class SimpleLogger implements ChurnLogger {
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
// ExecutionEngine class imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const POLYMARKET_API = {
  CLOB: "https://clob.polymarket.com",
  DATA: "https://data-api.polymarket.com",
  GAMMA: "https://gamma-api.polymarket.com",
};

// ═══════════════════════════════════════════════════════════════════════════
// POLYMARKET BOT
// ═══════════════════════════════════════════════════════════════════════════

class ChurnEngine {
  private config: ChurnConfig;
  private logger: SimpleLogger;
  private evTracker: EvTracker;
  private biasAccumulator: BiasAccumulator;
  private positionManager: PositionManager;
  private decisionEngine: DecisionEngine;
  private executionEngine: ExecutionEngine;
  private onchainMonitor: OnChainMonitor | null = null;
  private marketScanner: MarketScanner;
  private dynamicReserveManager: DynamicReserveManager;
  private latencyMonitor: LatencyMonitor;
  private marketDataFacade: MarketDataFacade | null = null;
  // Balance cache for RPC throttling - reduces Infura calls
  private balanceCache: BalanceCache | null = null;

  private client: any = null;
  private wallet: any = null;
  private address: string = "";

  private running = false;
  private cycleCount = 0;
  private lastRedeemTime = 0;
  // Position tracking - no cache needed, API is fast
  private lastSummaryTime = 0;
  private lastPolCheckTime = 0;
  private lastScanTime = 0;
  // Liquidation mode - when true, prioritize selling existing positions
  private liquidationMode = false;
  // Track recently sold positions to prevent re-selling during API cache delay
  // Maps tokenId to timestamp when it was sold
  private recentlySoldPositions = new Map<string, number>();
  private readonly SOLD_POSITION_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown

  // Cooldown for tokens that fail entry checks (transient errors only)
  // Prevents spamming the same failing token repeatedly
  private failedEntryCooldowns = new Map<string, number>();
  // TASK 5: Use config value for transient error cooldown
  private get FAILED_ENTRY_COOLDOWN_MS(): number {
    return this.config.entryCooldownSecondsTransient * 1000;
  }
  // Market data cooldown manager with exponential backoff for closed/settled markets
  private marketDataCooldownManager = new MarketDataCooldownManager();
  // Summary logging interval for market data cooldowns
  private readonly COOLDOWN_SUMMARY_INTERVAL = 100; // Log every 100 cycles
  // Throttle for dust book REST verification (once per token per 5 minutes)
  private dustBookRestVerifyThrottle = new Map<string, number>();
  private readonly DUST_BOOK_VERIFY_THROTTLE_MS = 5 * 60 * 1000; // 5 minutes

  // Intervals
  private readonly REDEEM_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  private readonly SUMMARY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS - Track what's happening for debugging trade detection issues
  // ═══════════════════════════════════════════════════════════════════════════
  private diagnostics = {
    startTime: Date.now(),
    whaleTradesDetected: 0,
    entryAttempts: 0,
    entrySuccesses: 0,
    entryFailureReasons: [] as string[], // Keep last 50 only
    orderbookFetchFailures: 0,
    marketDataFetchAttempts: 0,
    marketDataFetchSuccesses: 0,
    startupReportSent: false,
    // TASK 6: Add funnel tracking counters
    candidatesSeen: 0, // Total candidates processed
    candidatesRejectedLiquidity: 0, // Rejected due to spread/depth/dust book
    // Enhanced funnel metrics - track where signals die
    // Note: Some metrics are cumulative (rejected/skipped), others are per-cycle snapshots
    funnel: {
      tradesIngested: 0, // Total trades ingested into BiasAccumulator
      tradesFilteredByPrice: 0, // Filtered by price range
      // biasesCreated is NOT tracked here - use biasAccumulator.getFunnelStats().uniqueTokensWithTrades instead
      biasesRejectedStale: 0, // Rejected: bias is stale (cumulative)
      biasesRejectedTrades: 0, // Rejected: trades below min (cumulative)
      biasesRejectedFlow: 0, // Rejected: flow below min (cumulative)
      biasesSkippedCooldown: 0, // Skipped due to cooldown (cumulative)
      eligibleSignals: 0, // Passed all checks, eligible for entry (cumulative)
      entryAttemptsFromBias: 0, // Entry attempts from bias signals (cumulative)
    },
  };
  private readonly STARTUP_DIAGNOSTIC_DELAY_MS = 60 * 1000; // Send diagnostic after 60 seconds
  private readonly MAX_FAILURE_REASONS = 50;

  /**
   * Track an entry failure reason with size limit
   */
  private trackFailureReason(reason: string): void {
    this.diagnostics.entryFailureReasons.push(reason);
    // Keep only the last MAX_FAILURE_REASONS entries
    if (
      this.diagnostics.entryFailureReasons.length > this.MAX_FAILURE_REASONS
    ) {
      this.diagnostics.entryFailureReasons.shift();
    }
  }

  constructor() {
    this.config = loadConfig();
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
    this.biasAccumulator = new BiasAccumulator(this.config);
    this.marketScanner = new MarketScanner(this.config);
    this.dynamicReserveManager = new DynamicReserveManager(this.config);
    this.positionManager = new PositionManager({
      tpCents: this.config.tpCents,
      hedgeTriggerCents: this.config.hedgeTriggerCents,
      maxAdverseCents: this.config.maxAdverseCents,
      maxHoldSeconds: this.config.maxHoldSeconds,
      hedgeRatio: this.config.hedgeRatio,
      maxHedgeRatio: this.config.maxHedgeRatio,
    });

    // Create DecisionEngine config from ChurnConfig
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

    // Create ExecutionEngine config from ChurnConfig
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

    // Initialize latency monitor for dynamic slippage calculation
    this.latencyMonitor = initLatencyMonitor({
      rpcUrl: this.config.rpcUrl,
      measureIntervalMs: 30000, // Check every 30s
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
        wsUserClient.connect(this.client).catch((retryErr) => {
          const retryMsg =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`📡 User WebSocket retry failed: ${retryMsg}`);
          // After retry failure, the built-in reconnection logic will continue attempts
        });
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
      if (process.env.VPN_BYPASS_RPC !== "false") {
        await setupRpcBypass(this.config.rpcUrl, this.logger);
      }

      // Bypass read-only APIs (gamma-api, data-api) - they don't need VPN
      // Use the polymarket-specific bypass when explicitly enabled; otherwise use the generic one.
      if (process.env.VPN_BYPASS_POLYMARKET_READS === "true") {
        await setupPolymarketReadBypass(this.logger);
      } else {
        await setupReadApiBypass(this.logger);
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
      const scanPromise = this.marketScanner
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
      scannedOpportunities = this.marketScanner.getActiveTokenIds();
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. ENTER IF BIAS ALLOWS OR SCANNED OPPORTUNITY AVAILABLE
    // ─────────────────────────────────────────────────────────────────
    const evAllowed = this.evTracker.isTradingAllowed();
    const activeBiases = this.biasAccumulator.getActiveBiases();

    // Debug: show all active biases before filtering
    if (DEBUG && activeBiases.length > 0) {
      debug(`Active biases before cooldown filter: ${activeBiases.length}`);
      for (const bias of activeBiases.slice(0, 5)) {
        const onCooldown = this.failedEntryCooldowns.has(bias.tokenId);
        debug(
          `  ${bias.tokenId.slice(0, 12)}... | dir: ${bias.direction} | $${bias.netUsd.toFixed(0)} flow | trades: ${bias.tradeCount} | cooldown: ${onCooldown}`,
        );
      }
    }

    // Clean up expired cooldowns
    for (const [tokenId, expiry] of this.failedEntryCooldowns.entries()) {
      if (now >= expiry) {
        debug(`Cooldown expired for ${tokenId.slice(0, 12)}...`);
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
        if (DEBUG || this.cycleCount % 100 === 0) {
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
          if (DEBUG || this.cycleCount % 100 === 0) {
            console.log(
              `🚫 [REJECT_BIAS] ${bias.tokenId.slice(0, 12)}... | TRADES_BELOW_MIN | trades=${bias.tradeCount} < min=${this.config.biasMinTrades}`,
            );
          }
          skippedTradesBelowMin++;
          continue;
        }

        if (Math.abs(bias.netUsd) < this.config.biasMinNetUsd) {
          if (DEBUG || this.cycleCount % 100 === 0) {
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
              debug(
                `📡 [WS] Subscribed to ${biasTokensToSubscribe.length} whale signal tokens`,
              );
            }
          }
        } catch (wsErr) {
          // WS subscription failed - will use REST fallback in fetchTokenMarketDataWithReason
          debug(
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
          debug(
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

              debug(
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
                if (shouldCooldownOnFailure(result.reason)) {
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
              debug(
                `📡 [WS] Subscribed to ${scannedToSubscribe.length} scanned tokens`,
              );
            }
          }
        } catch (wsErr) {
          // WS subscription failed - will use REST fallback
          debug(
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
                  if (shouldCooldownOnFailure(result.reason)) {
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
      ? this.marketScanner.getActiveMarketCount()
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
        debug(
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
              const restOrderbook = await this.client.getOrderBook(tokenId);
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
        orderbook = await this.client.getOrderBook(tokenId);
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
      if (bestBid <= 0.02 && bestAsk >= 0.98) {
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
      ? this.marketScanner.getActiveMarketCount()
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
    const markets = await this.marketScanner.scanActiveMarkets();

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

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  // CHECK FOR DIAGNOSTIC MODE FIRST
  // ─────────────────────────────────────────────────────────────────────────
  if (isDiagModeEnabled()) {
    console.log("");
    console.log("═".repeat(60));
    console.log("  🔬 DIAGNOSTIC MODE DETECTED");
    console.log("═".repeat(60));
    console.log("");

    if (isGitHubActions()) {
      ghNotice("Diagnostic mode enabled - running one-shot workflow");
    }

    const diagConfig = parseDiagModeConfig();
    const engine = new ChurnEngine();

    // Track whether diagnostic workflow completed successfully
    let diagWorkflowCompleted = false;
    let diagExitCode = 0;

    // Handle shutdown - use exit code 0 if workflow completed, 1 if interrupted
    process.on("SIGINT", () => {
      console.log("\nReceived SIGINT, shutting down...");
      engine.stop();
      process.exit(diagWorkflowCompleted ? diagExitCode : 1);
    });

    process.on("SIGTERM", () => {
      console.log("\nReceived SIGTERM, shutting down...");
      engine.stop();
      process.exit(diagWorkflowCompleted ? diagExitCode : 1);
    });

    // Initialize engine (but don't run normal loop)
    const initialized = await engine.initialize();
    if (!initialized) {
      console.error("Failed to initialize engine for diagnostic mode");
      process.exit(1);
    }

    // Run diagnostic workflow
    try {
      const result = await runDiagWorkflow(engine.getDiagDeps(), diagConfig);

      // Stop engine
      engine.stop();

      // Report diagnostic results to GitHub Issues if configured
      const reporter = getGitHubReporter();
      if (reporter.isEnabled()) {
        console.log("\n📋 Reporting diagnostic results to GitHub Issues...");
        try {
          const durationMs =
            result.endTime.getTime() - result.startTime.getTime();

          // Get rejection stats for candidate summary
          const rejectionStats = getRejectionStats();

          // Get write route check results
          const writeRouteChecks = [...WRITE_HOSTS].map((hostname) =>
            checkWriteHostRoute(hostname),
          );

          // Determine env overrides
          const envOverrides: Record<string, string> = {};
          if (process.env.VPN_BYPASS_RPC !== undefined) {
            envOverrides.VPN_BYPASS_RPC = process.env.VPN_BYPASS_RPC;
          }
          if (process.env.VPN_BYPASS_POLYMARKET_READS !== undefined) {
            envOverrides.VPN_BYPASS_POLYMARKET_READS =
              process.env.VPN_BYPASS_POLYMARKET_READS;
          }
          if (process.env.VPN_BYPASS_POLYMARKET_WS !== undefined) {
            envOverrides.VPN_BYPASS_POLYMARKET_WS =
              process.env.VPN_BYPASS_POLYMARKET_WS;
          }

          // Detect key failures from step results
          const keyFailures: Array<{
            type:
              | "CLOUDFLARE_BLOCKED"
              | "WRITE_ROUTE_MISMATCH"
              | "EMPTY_BOOK"
              | "AUTH_FAILED"
              | "OTHER";
            host?: string;
            statusCode?: number;
            marketId?: string;
            tokenId?: string;
            details?: string;
          }> = [];

          // Check for write route mismatch
          for (const check of writeRouteChecks) {
            if (check.mismatch) {
              keyFailures.push({
                type: "WRITE_ROUTE_MISMATCH",
                host: check.hostname,
                details: `IP=${check.resolvedIp}, Interface=${check.outgoingInterface}, Gateway=${check.outgoingGateway}`,
              });
            }
          }

          // Check for empty book rejections
          if (rejectionStats.byRule.emptyBook > 0) {
            const sample = rejectionStats.sampleRejected.find(
              (s) => s.rule === "empty_book",
            );
            keyFailures.push({
              type: "EMPTY_BOOK",
              marketId: sample?.marketId,
              tokenId: sample?.tokenId,
              details: `${rejectionStats.byRule.emptyBook} candidates had empty books`,
            });
          }

          // Check step results for auth failures or cloudflare blocks
          // Use a Set to track already-added failure types to avoid duplicates
          const addedFailureTypes = new Set<string>();

          for (const step of result.steps) {
            // More specific matching for Cloudflare 403 blocks
            // Look for patterns like "403", "geo-block", "cloudflare"
            const reasonLower = step.reason?.toLowerCase() ?? "";
            if (
              !addedFailureTypes.has("CLOUDFLARE_BLOCKED") &&
              (reasonLower.includes("403 forbidden") ||
                reasonLower.includes("geo-block") ||
                reasonLower.includes("cloudflare") ||
                (reasonLower.includes("blocked") &&
                  reasonLower.includes("clob")))
            ) {
              keyFailures.push({
                type: "CLOUDFLARE_BLOCKED",
                host: "clob.polymarket.com",
                statusCode: 403,
                details: step.reason,
              });
              addedFailureTypes.add("CLOUDFLARE_BLOCKED");
            }

            // More specific matching for auth failures
            if (
              !addedFailureTypes.has("AUTH_FAILED") &&
              (reasonLower.includes("authentication") ||
                reasonLower.includes("unauthorized") ||
                reasonLower.includes("401") ||
                reasonLower.includes("invalid credential") ||
                reasonLower.includes("api key"))
            ) {
              keyFailures.push({
                type: "AUTH_FAILED",
                details: step.reason,
              });
              addedFailureTypes.add("AUTH_FAILED");
            }
          }

          const reported = await reporter.reportDiagnosticWorkflow({
            traceId: result.traceId,
            durationMs,
            steps: result.steps.map((s) => ({
              step: s.step,
              result: s.result,
              reason: s.reason,
              marketId: s.marketId,
              tokenId: s.tokenId,
              detail: s.detail,
            })),
            vpnRoutingPolicy: {
              vpnActive: isVpnActive(),
              vpnType: getVpnType(),
              defaultsApplied: {
                VPN_BYPASS_RPC: VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
                VPN_BYPASS_POLYMARKET_READS:
                  VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
                VPN_BYPASS_POLYMARKET_WS:
                  VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
              },
              envOverrides,
              bypassedHosts: getBypassedHosts(),
              writeHosts: [...WRITE_HOSTS],
              writeRouteCheck: writeRouteChecks,
            },
            candidateRejectionSummary: {
              totalCandidates: rejectionStats.totalCandidates,
              byRule: {
                askTooHigh: rejectionStats.byRule.askTooHigh,
                spreadTooWide: rejectionStats.byRule.spreadTooWide,
                emptyBook: rejectionStats.byRule.emptyBook,
                cooldown: rejectionStats.skippedCooldown,
              },
              sampleRejected: rejectionStats.sampleRejected.map((s) => ({
                tokenId: s.tokenId,
                rule: s.rule,
                bestBid: s.bestBid,
                bestAsk: s.bestAsk,
              })),
            },
            keyFailures: keyFailures.length > 0 ? keyFailures : undefined,
            diagConfig: {
              whaleTimeoutSec: diagConfig.whaleTimeoutSec,
              orderTimeoutSec: diagConfig.orderTimeoutSec,
              maxAttempts: diagConfig.maxCandidateAttempts,
              bookMaxAsk: diagConfig.bookMaxAsk,
              bookMaxSpread: diagConfig.bookMaxSpread,
            },
          });
          if (reported) {
            console.log("📋 Diagnostic results reported to GitHub Issues");
          } else {
            console.log(
              "📋 Diagnostic results skipped (dedupe/rate-limit/severity)",
            );
          }
        } catch (reportErr) {
          console.warn(
            `📋 Failed to report to GitHub: ${reportErr instanceof Error ? reportErr.message : reportErr}`,
          );
        }
      } else {
        console.log(
          "\n📋 GitHub reporter not enabled - skipping issue creation",
        );
      }

      // Mark workflow as completed with its exit code
      diagWorkflowCompleted = true;
      diagExitCode = result.exitCode;

      // Log workflow completion
      console.log(
        `\n🔬 Diagnostic workflow completed. Exit code: ${result.exitCode}`,
      );

      // Write diagnostic trace to JSONL file for artifact upload
      const { writeDiagWorkflowTrace, getDiagTracePath } =
        await import("./infra/github-reporter");
      writeDiagWorkflowTrace({
        traceId: result.traceId,
        startTime: result.startTime,
        endTime: result.endTime,
        steps: result.steps.map((s) => ({
          step: s.step,
          result: s.result,
          reason: s.reason,
          marketId: s.marketId,
          tokenId: s.tokenId,
          traceEvents: s.traceEvents as unknown as Array<
            Record<string, unknown>
          >,
        })),
        exitCode: result.exitCode,
      });
      console.log(`📋 Diagnostic trace written to: ${getDiagTracePath()}`);

      // Determine exit behavior using DIAGNOSTIC_POST_ACTION env var:
      // - "exit": Exit immediately with exit code (for CI/testing)
      // - "halt" (default): Keep process alive indefinitely to prevent restart loops
      //
      // Legacy env vars (DIAG_EXIT, DIAG_HOLD_SECONDS) are still supported for backward compatibility.
      const postAction = (
        process.env.DIAGNOSTIC_POST_ACTION ?? "halt"
      ).toLowerCase();

      // Legacy support: DIAG_EXIT=1 overrides to "exit"
      const legacyDiagExit =
        process.env.DIAG_EXIT === "1" || process.env.DIAG_EXIT === "true";
      const effectivePostAction = legacyDiagExit ? "exit" : postAction;

      // Log the decision
      console.log("");
      console.log("═".repeat(60));
      console.log("  📋 DIAGNOSTIC POST-ACTION");
      console.log("═".repeat(60));
      console.log(
        `  DIAGNOSTIC_POST_ACTION: ${process.env.DIAGNOSTIC_POST_ACTION ?? "(not set)"}`,
      );
      console.log(
        `  DIAG_EXIT (legacy): ${process.env.DIAG_EXIT ?? "(not set)"}`,
      );
      console.log(
        `  DIAG_HOLD_SECONDS (legacy): ${process.env.DIAG_HOLD_SECONDS ?? "(not set)"}`,
      );
      console.log(`  Effective action: ${effectivePostAction}`);
      console.log("═".repeat(60));

      if (effectivePostAction === "exit") {
        console.log(
          `\n🏁 Post-action=exit - exiting after diagnostic workflow.`,
        );
        process.exit(diagExitCode);
      }

      // Legacy: DIAG_HOLD_SECONDS for timed hold before exit
      const holdSeconds = parseInt(process.env.DIAG_HOLD_SECONDS ?? "0", 10);
      if (holdSeconds > 0) {
        console.log(
          `\n💤 Holding for ${holdSeconds} seconds (DIAG_HOLD_SECONDS)...`,
        );
        console.log("   Press Ctrl+C to stop earlier.");
        await new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000));
        console.log("🏁 Hold period complete, exiting.");
        process.exit(diagExitCode);
      }

      // Default (halt): Enter idle state indefinitely (safest for containers)
      // This prevents restart loops in container orchestrators
      console.log(
        "\n💤 Post-action=halt - holding indefinitely (container will not restart)...",
      );
      console.log(
        "   Set DIAGNOSTIC_POST_ACTION=exit to exit immediately after diagnostic.",
      );
      console.log("   Press Ctrl+C to stop the container manually.");

      // ═══════════════════════════════════════════════════════════════════════
      // Part F: Gracefully stop WebSocket connections before entering halt mode
      // This prevents the WS 1006 reconnect loop observed in diagnostics
      // ═══════════════════════════════════════════════════════════════════════
      console.log("\n🔌 Gracefully disconnecting WebSocket connections...");
      try {
        const marketWs = getWebSocketMarketClient();
        const userWs = getWebSocketUserClient();

        // Log final metrics before disconnect
        const marketMetrics = marketWs.getMetrics();
        const userMetrics = userWs.getMetrics();
        console.log(
          `   [WS-Market] Final metrics: disconnectCount=${marketMetrics.disconnectCount}, lastCode=${marketMetrics.lastDisconnectCode}`,
        );
        console.log(
          `   [WS-User] Final metrics: disconnectCount=${userMetrics.disconnectCount}, lastCode=${userMetrics.lastDisconnectCode}`,
        );

        // Gracefully disconnect both WS clients
        marketWs.disconnect();
        userWs.disconnect();
        console.log("✅ WebSocket connections gracefully closed.");
      } catch (wsErr) {
        console.warn(
          `⚠️ Error disconnecting WebSocket: ${wsErr instanceof Error ? wsErr.message : wsErr}`,
        );
      }

      // Keep the process alive indefinitely without a constant-condition loop.
      // Signal handlers (SIGINT/SIGTERM) above will still terminate the process.
      // IMPORTANT: We do NOT re-enter trading loops in halt mode.
      // WS connections are now STOPPED and will not reconnect.
      await new Promise<never>(() => {
        // Intentionally never resolve: idle until the process receives a termination signal.
      });
    } catch (err) {
      console.error("Fatal error in diagnostic workflow:", err);
      engine.stop();
      process.exit(1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NORMAL MODE
  // ─────────────────────────────────────────────────────────────────────────
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
// Check if this file is the entry point by examining the call stack
function isDirectlyExecuted(): boolean {
  // If we're in a test environment, don't run
  if (process.env.NODE_ENV === "test") return false;

  // Check if process.argv[1] ends with our filename (start.js or start.ts)
  const scriptPath = process.argv[1] || "";
  return scriptPath.endsWith("start.js") || scriptPath.endsWith("start.ts");
}

if (isDirectlyExecuted()) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

// Exports for testing
export {
  ChurnEngine,
  ChurnConfig,
  ValidationError,
  loadConfig,
  validateConfig,
  logConfig,
  calculateEffectiveBankroll,
  calculateTradeSize,
  TradeResult,
  EvMetrics,
  EvTracker,
  calculatePnlCents,
  calculatePnlUsd,
  createTradeResult,
  BiasDirection,
  LeaderboardTrade,
  TokenBias,
  BiasChangeEvent,
  BiasAccumulator,
  PositionState,
  ExitReason,
  HedgeLeg,
  StateTransition,
  ManagedPosition,
  PositionManagerConfig,
  PositionManager,
  OrderbookState,
  MarketActivity,
  EntryDecision,
  ExitDecision,
  DecisionEngine,
  ExecutionResult,
  TokenMarketData,
  ChurnLogger,
  SimpleLogger,
  ExecutionEngine,
};
