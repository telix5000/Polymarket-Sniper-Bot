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
  // Extracted modules
  BiasAccumulator,
  type BiasAccumulatorConfig,
  type LeaderboardTrade,
  type TokenBias,
  type BiasChangeEvent,
  VolumeScanner,
  type ActiveMarket,
  type VolumeScannerConfig,
  MarketDataCooldownManager,
  type MarketDataFailureReason,
  type CooldownEntry,
  type CooldownStats,
  shouldApplyLongCooldown,
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
  DynamicReserveManager,
  type ReserveManagerConfig,
  type MissedOpportunity,
  type DynamicReserveState,
  // ChurnEngine - main trading orchestrator
  ChurnEngine,
  SimpleLogger,
  type ChurnEngineDeps,
  type ChurnConfig,
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

// ChurnConfig interface imported from ./core

function loadConfig(): ChurnConfig {
  const maxTradeUsd = envNum("MAX_TRADE_USD", 25); // 💰 Your max bet size (default: $25)
  // Default minTradeUsd to maxTradeUsd if not specified
  // This ensures the bot trades at the max amount by default
  const minTradeUsd = envNum("MIN_TRADE_USD", maxTradeUsd);
  
  return {
    // ═══════════════════════════════════════════════════════════════════════
    // USER CONFIGURABLE - This is the ONLY thing you should change
    // ═══════════════════════════════════════════════════════════════════════
    maxTradeUsd, // 💰 Your max bet size (default: $25)
    minTradeUsd, // 💰 Your min bet size (default: same as maxTradeUsd)

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

  // User-configurable: min bet size must be positive
  if (config.minTradeUsd <= 0) {
    errors.push({ field: "MIN_TRADE_USD", message: "Must be positive" });
  }

  // Min trade should not exceed max trade
  if (config.minTradeUsd > config.maxTradeUsd) {
    errors.push({ field: "MIN_TRADE_USD", message: "Must not exceed MAX_TRADE_USD" });
  }

  return errors;
}

function logConfig(config: ChurnConfig, log: (msg: string) => void): void {
  log("");
  log("🤖 POLYMARKET BOT");
  log("═".repeat(50));
  log("");
  log("💰 YOUR SETTINGS:");
  log(`   Bet size: $${config.minTradeUsd}-$${config.maxTradeUsd} per trade`);
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
  // Apply both min and max bounds:
  // - First ensure we don't go below minTradeUsd (for small bankrolls)
  // - Then cap at maxTradeUsd (for large bankrolls)
  // If effectiveBankroll is too small to meet minTradeUsd, use fractionalSize
  // to avoid over-leveraging (can't trade more than we can afford)
  const withMinimum = Math.max(fractionalSize, Math.min(config.minTradeUsd, effectiveBankroll));
  return Math.min(withMinimum, config.maxTradeUsd);
}

// ═══════════════════════════════════════════════════════════════════════════
// EV METRICS - Types and classes imported from ./core
// Helper functions (calculatePnlCents, calculatePnlUsd, createTradeResult) imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// BIAS ACCUMULATOR - Imported from ./lib
// BiasDirection type imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// VOLUME SCANNER - Imported from ./lib (renamed from MarketScanner)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC RESERVES - Imported from ./core
// ═══════════════════════════════════════════════════════════════════════════

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

// ChurnEngine, SimpleLogger imported from ./core

// ═══════════════════════════════════════════════════════════════════════════
// CHURN ENGINE DEPENDENCIES
// Creates the dependencies object needed by ChurnEngine
// ═══════════════════════════════════════════════════════════════════════════

function createChurnEngineDeps(): ChurnEngineDeps {
  return {
    loadConfig,
    validateConfig,
    logConfig,
    debug,
    shouldCooldownOnFailure,
    isDebugEnabled: () => DEBUG,
  };
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
    const engine = new ChurnEngine(createChurnEngineDeps());

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
  const engine = new ChurnEngine(createChurnEngineDeps());

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
