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
 *   - Web dashboard (DASHBOARD_PORT=3000)
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
  invalidatePositions,
  smartSell,
  type Position,
  // On-chain event monitoring (confirmed trades)
  OnChainMonitor,
  createOnChainMonitorConfig,
  type OnChainTradeEvent,
  type OnChainMonitorConfig,
  type PositionChangeEvent,
  type OnChainPriceUpdate,
  // Mempool monitoring (PENDING trades - faster!)
  MempoolMonitor,
  createMempoolMonitorConfig,
  type PendingTradeSignal,
  // Market utilities for hedge token lookup
  getOppositeTokenId,
  // GitHub error reporting
  initGitHubReporter,
  reportError,
  // Latency monitoring for dynamic slippage
  LatencyMonitor,
  initLatencyMonitor,
  getLatencyMonitor,
} from "./lib";

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

interface ChurnConfig {
  // ═══════════════════════════════════════════════════════════════════════════
  // USER CONFIGURABLE (the ONLY thing you should change)
  // ═══════════════════════════════════════════════════════════════════════════
  maxTradeUsd: number;  // Your bet size in USD (default: $25)

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
  logLevel: string;

  // Wallet / Reserve Management
  reserveFraction: number;
  minReserveUsd: number;
  useAvailableBalanceOnly: boolean;

  // Liquidation Mode
  liquidationMode: "off" | "losing" | "all";  // "off" = normal trading, "losing" = sell losing positions, "all" = sell everything
  liquidationMaxSlippagePct: number;  // Max slippage for liquidation sells (default: 10%)
  liquidationPollIntervalMs: number;  // Poll interval in liquidation mode (default: 1000ms)

  // Aggressive Whale Copy Mode
  copyAnyWhaleBuy: boolean;  // If true, copy ANY whale buy without waiting for bias confirmation

  // Market Scanner - Scan for most active/trending markets
  scanActiveMarkets: boolean;  // If true, scan for active markets to trade
  scanMinVolumeUsd: number;    // Minimum 24h volume to consider a market
  scanTopNMarkets: number;     // Number of top markets to scan
  scanIntervalSeconds: number; // How often to refresh the market scan

  // Dynamic Reserves - Self-balancing reserve system
  dynamicReservesEnabled: boolean;    // If true, use dynamic reserve calculation
  reserveAdaptationRate: number;      // How quickly reserves adapt (0-1, default: 0.1)
  missedOpportunityWeight: number;    // Weight for missed opportunities (default: 0.5)
  hedgeCoverageWeight: number;        // Weight for hedge coverage needs (default: 0.5)
  maxReserveFraction: number;         // Maximum reserve as fraction of balance (default: 0.5)

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

  // Mempool Monitoring - sees PENDING trades (faster than on-chain!)
  mempoolMonitorEnabled: boolean;
  mempoolGasPriceMultiplier: number;  // How much higher gas to use (1.2 = 20% higher)
}

function loadConfig(): ChurnConfig {
  return {
    // ═══════════════════════════════════════════════════════════════════════
    // USER CONFIGURABLE - This is the ONLY thing you should change
    // ═══════════════════════════════════════════════════════════════════════
    maxTradeUsd: envNum("MAX_TRADE_USD", 25),  // 💰 Your bet size (default: $25)

    // ═══════════════════════════════════════════════════════════════════════
    // FIXED BY THE MATH - Do NOT change these values
    // The math equation requires these exact parameters to work
    // ═══════════════════════════════════════════════════════════════════════

    // Capital sizing (fixed ratios that scale with MAX_TRADE_USD)
    tradeFraction: 0.01,              // 1% of bankroll per trade
    maxDeployedFractionTotal: 0.3,    // 30% max exposure
    maxOpenPositionsTotal: 12,        // Max concurrent positions
    maxOpenPositionsPerMarket: 1,     // 1 entry per token (hedges are stored inside position, not as separate entries)
    cooldownSecondsPerToken: 180,     // 3min between trades same token

    // Entry/Exit bands - produces avg_win=14¢, avg_loss=9¢
    entryBandCents: 12,               // Min price movement to enter
    tpCents: 14,                      // Take profit = 14¢
    hedgeTriggerCents: 16,            // Hedge at 16¢ adverse
    maxAdverseCents: 30,              // HARD STOP at 30¢ loss
    maxHoldSeconds: 3600,             // 1 hour max hold

    // Hedge behavior - caps avg_loss to ~9¢ instead of 30¢
    hedgeRatio: 0.4,                  // Hedge 40% on first trigger
    maxHedgeRatio: 0.7,               // Never hedge more than 70%

    // Entry price bounds - room to win, hedge, and be wrong
    minEntryPriceCents: 30,           // <30¢ = one bad tick kills you
    maxEntryPriceCents: 82,           // >82¢ = no room for TP
    preferredEntryLowCents: 35,       // Ideal zone starts
    preferredEntryHighCents: 65,      // Ideal zone ends
    entryBufferCents: 4,              // Safety buffer

    // Liquidity gates - keeps churn cost at ~2¢
    minSpreadCents: 6,                // Max acceptable spread
    minDepthUsdAtExit: 25,            // Need liquidity to exit
    minTradesLastX: 10,               // Market must be active
    minBookUpdatesLastX: 20,          // Book must be updating
    activityWindowSeconds: 300,       // 5min activity window

    // EV controls - bot stops itself when math says stop
    rollingWindowTrades: 200,         // Sample size for stats
    churnCostCentsEstimate: 2,        // 2¢ churn cost
    minEvCents: 0,                    // Pause if EV < 0
    minProfitFactor: 1.25,            // avg_win/avg_loss >= 1.25
    pauseSeconds: 300,                // 5min pause when table closed

    // Bias (Leaderboard flow) - permission, not prediction
    // Track top 100 wallets for maximum signal coverage (churn all day)
    biasMode: "leaderboard_flow",
    leaderboardTopN: 100,             // Track top 100 wallets for more signals
    biasWindowSeconds: 3600,          // 1 hour window
    biasMinNetUsd: 300,               // $300 net flow minimum
    biasMinTrades: 3,                 // At least 3 trades
    biasStaleSeconds: 900,            // Bias expires after 15min
    allowEntriesOnlyWithBias: true,
    onBiasFlip: "MANAGE_EXITS_ONLY",
    onBiasNone: "PAUSE_ENTRIES",

    // Polling (fixed - fast polling for accurate position tracking)
    pollIntervalMs: 200,              // 200ms = 5 req/sec
    positionPollIntervalMs: 100,      // 100ms when holding positions
    logLevel: envStr("LOG_LEVEL", "info"),

    // Wallet / Reserve (fixed - survive variance)
    reserveFraction: 0.25,            // 25% always reserved
    minReserveUsd: 100,               // $100 minimum reserve
    useAvailableBalanceOnly: true,

    // Liquidation Mode - force sell existing positions
    // "off" = normal trading (default)
    // "losing" = only sell positions with negative P&L
    // "all" = sell all positions regardless of P&L
    liquidationMode: parseLiquidationMode(process.env.LIQUIDATION_MODE || process.env.FORCE_LIQUIDATION),
    liquidationMaxSlippagePct: envNum("LIQUIDATION_MAX_SLIPPAGE_PCT", 10),  // 10% default
    liquidationPollIntervalMs: envNum("LIQUIDATION_POLL_INTERVAL_MS", 1000),  // 1s default

    // Aggressive Whale Copy Mode - copy ANY whale buy without waiting for bias
    // When true: sees whale buy → immediately copies (no $300 flow / 3 trade requirement)
    // When false: requires bias confirmation (multiple whale trades in same direction)
    // DEFAULT: true - for best copy trading results, copy immediately!
    copyAnyWhaleBuy: envBool("COPY_ANY_WHALE_BUY", true),

    // Market Scanner - Scan for most active/trending markets to trade
    // When enabled, the bot will scan Polymarket for the most active markets
    // and consider them as additional trading opportunities
    scanActiveMarkets: envBool("SCAN_ACTIVE_MARKETS", true),
    scanMinVolumeUsd: envNum("SCAN_MIN_VOLUME_USD", 10000),  // $10k minimum 24h volume
    scanTopNMarkets: envNum("SCAN_TOP_N_MARKETS", 20),        // Top 20 most active markets
    scanIntervalSeconds: envNum("SCAN_INTERVAL_SECONDS", 300), // Refresh every 5 minutes

    // Dynamic Reserves - Self-balancing reserve system
    // Automatically adjusts reserves based on missed opportunities and hedge needs
    dynamicReservesEnabled: envBool("DYNAMIC_RESERVES_ENABLED", true),
    reserveAdaptationRate: envNum("RESERVE_ADAPTATION_RATE", 0.1),      // 10% adaptation per cycle
    missedOpportunityWeight: envNum("MISSED_OPPORTUNITY_WEIGHT", 0.5),  // Weight for missed trades
    hedgeCoverageWeight: envNum("HEDGE_COVERAGE_WEIGHT", 0.5),          // Weight for hedge needs
    maxReserveFraction: envNum("MAX_RESERVE_FRACTION", 0.5),            // Max 50% reserve

    // ═══════════════════════════════════════════════════════════════════════
    // AUTH & INTEGRATIONS (user provides these)
    // ═══════════════════════════════════════════════════════════════════════
    privateKey: process.env.PRIVATE_KEY ?? "",
    rpcUrl: envStr("RPC_URL", "https://polygon-rpc.com"),
    liveTradingEnabled:
      envStr("LIVE_TRADING", "") === "I_UNDERSTAND_THE_RISKS",

    // Telegram (optional)
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,

    // POL Reserve - auto-fill gas
    // IMPORTANT: Only tops off when POL falls below polReserveMin (0.5)
    // Does NOT proactively top off to polReserveTarget (50) - saves USDC
    // When triggered: swaps up to polReserveMaxSwapUsd USDC to reach target
    polReserveEnabled: true,
    polReserveTarget: envNum("POL_RESERVE_TARGET", 50),  // Target POL when refilling
    polReserveMin: envNum("POL_RESERVE_MIN", 0.5),       // Trigger threshold (refill when below this)
    polReserveMaxSwapUsd: envNum("POL_RESERVE_MAX_SWAP_USD", 10),  // Max USDC per swap
    polReserveCheckIntervalMin: envNum("POL_RESERVE_CHECK_INTERVAL_MIN", 5),  // Check every 5 min
    polReserveSlippagePct: 3,

    // On-Chain Monitoring - Watch CTF Exchange contract via Infura WebSocket
    // This provides faster whale detection than API polling (blockchain-level speed)
    // Requires Infura RPC URL with WebSocket support
    onchainMonitorEnabled: envBool("ONCHAIN_MONITOR_ENABLED", true),
    // Min trade size to detect as a "whale trade" - supports both env names for convenience
    // WHALE_TRADE_USD is the simpler name, ONCHAIN_MIN_WHALE_TRADE_USD for backward compatibility
    // DEFAULT: $100 - lower threshold catches more whale activity
    onchainMinWhaleTradeUsd: envNum("WHALE_TRADE_USD", envNum("ONCHAIN_MIN_WHALE_TRADE_USD", 100)),
    // Infura tier plan: "core" (free), "developer" ($50/mo), "team" ($225/mo), "growth" (enterprise)
    // Affects rate limiting to avoid hitting API caps
    infuraTier: parseInfuraTierEnv(process.env.INFURA_TIER),

    // Mempool Monitoring - Watch for PENDING whale transactions (FASTER than on-chain!)
    // Sees trades BEFORE they're confirmed, allowing us to copy at the same price
    mempoolMonitorEnabled: envBool("MEMPOOL_MONITOR_ENABLED", true),
    // Gas price multiplier for priority execution (1.2 = 20% higher gas than whale's tx)
    mempoolGasPriceMultiplier: envNum("MEMPOOL_GAS_MULTIPLIER", 1.2),
  };
}

/**
 * Parse Infura tier from environment variable
 */
function parseInfuraTierEnv(tierStr?: string): "core" | "developer" | "team" | "growth" {
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
  if (normalized === "losing" || normalized === "losers" || normalized === "red") return "losing";
  if (normalized === "all" || normalized === "everything") return "all";
  if (normalized === "off" || normalized === "false" || normalized === "no") return "off";
  
  // Legacy FORCE_LIQUIDATION=true support (maps to "all")
  if (normalized === "true" || normalized === "yes" || normalized === "1") return "all";
  
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
  log(`   Live trading: ${config.liveTradingEnabled ? "✅ ENABLED" : "⚠️ SIMULATION"}`);
  log(`   Telegram: ${config.telegramBotToken && config.telegramChatId ? "✅ ENABLED" : "❌ DISABLED"}`);
  if (config.liquidationMode !== "off") {
    const modeDesc = config.liquidationMode === "losing" ? "LOSING ONLY (negative P&L)" : "ALL POSITIONS";
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
  log(`   Min trade size: $${config.onchainMinWhaleTradeUsd} (WHALE_TRADE_USD)`);
  if (config.copyAnyWhaleBuy) {
    log(`   Mode: INSTANT COPY - copy ANY whale buy ≥ $${config.onchainMinWhaleTradeUsd}`);
  } else {
    log(`   Mode: CONFIRMED - need $${config.biasMinNetUsd} flow + ${config.biasMinTrades} trades`);
  }
  log("");
  log("🔍 MARKET SCANNER:");
  log(`   Scan active markets: ${config.scanActiveMarkets ? "✅ ENABLED" : "❌ DISABLED"}`);
  if (config.scanActiveMarkets) {
    log(`   Min 24h volume: $${config.scanMinVolumeUsd.toLocaleString()}`);
    log(`   Top markets: ${config.scanTopNMarkets}`);
    log(`   Scan interval: ${config.scanIntervalSeconds}s`);
  }
  log("");
  log("🏦 DYNAMIC RESERVES:");
  log(`   Dynamic reserves: ${config.dynamicReservesEnabled ? "✅ ENABLED" : "❌ DISABLED"}`);
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
// EV METRICS
// ═══════════════════════════════════════════════════════════════════════════

interface TradeResult {
  tokenId: string;
  side: "LONG" | "SHORT";
  entryPriceCents: number;
  exitPriceCents: number;
  sizeUsd: number;
  timestamp: number;
  pnlCents: number; // Per share
  pnlUsd: number;
  isWin: boolean;
}

interface EvMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinCents: number;
  avgLossCents: number;
  evCents: number;
  profitFactor: number;
  totalPnlUsd: number;
  lastUpdated: number;
}

class EvTracker {
  private trades: TradeResult[] = [];
  private readonly config: ChurnConfig;
  private pausedUntil = 0;

  constructor(config: ChurnConfig) {
    this.config = config;
  }

  /**
   * Record a completed trade
   */
  recordTrade(trade: TradeResult): void {
    this.trades.push(trade);

    // Trim to rolling window
    while (this.trades.length > this.config.rollingWindowTrades) {
      this.trades.shift();
    }

    // Check if we should pause
    const metrics = this.getMetrics();
    if (
      metrics.totalTrades >= 10 &&
      (metrics.evCents < this.config.minEvCents ||
        metrics.profitFactor < this.config.minProfitFactor)
    ) {
      this.pausedUntil = Date.now() + this.config.pauseSeconds * 1000;
    }
  }

  /**
   * Get current EV metrics
   */
  getMetrics(): EvMetrics {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgWinCents: 0,
        avgLossCents: 0,
        evCents: 0,
        profitFactor: 0,
        totalPnlUsd: 0,
        lastUpdated: Date.now(),
      };
    }

    const wins = this.trades.filter((t) => t.isWin);
    const losses = this.trades.filter((t) => !t.isWin);

    const totalTrades = this.trades.length;
    const winCount = wins.length;
    const lossCount = losses.length;
    const winRate = winCount / totalTrades;

    // Average win/loss in cents per share
    const avgWinCents =
      winCount > 0
        ? wins.reduce((sum, t) => sum + t.pnlCents, 0) / winCount
        : 0;
    const avgLossCents =
      lossCount > 0
        ? Math.abs(losses.reduce((sum, t) => sum + t.pnlCents, 0) / lossCount)
        : 0;

    // EV = p(win) * avg_win - p(loss) * avg_loss - churn_cost
    const pWin = winRate;
    const pLoss = 1 - winRate;
    const evCents =
      pWin * avgWinCents -
      pLoss * avgLossCents -
      this.config.churnCostCentsEstimate;

    // Profit factor = avg_win / avg_loss
    const profitFactor = avgLossCents > 0 ? avgWinCents / avgLossCents : 0;

    // Total P&L
    const totalPnlUsd = this.trades.reduce((sum, t) => sum + t.pnlUsd, 0);

    return {
      totalTrades,
      wins: winCount,
      losses: lossCount,
      winRate,
      avgWinCents,
      avgLossCents,
      evCents,
      profitFactor,
      totalPnlUsd,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Check if trading is allowed based on EV metrics
   */
  isTradingAllowed(): { allowed: boolean; reason?: string } {
    // Check pause
    if (this.pausedUntil > Date.now()) {
      const remainingMs = this.pausedUntil - Date.now();
      return {
        allowed: false,
        reason: `PAUSED (${Math.ceil(remainingMs / 1000)}s remaining)`,
      };
    }

    const metrics = this.getMetrics();

    // Need minimum trades for meaningful metrics
    if (metrics.totalTrades < 10) {
      return { allowed: true }; // Allow during warmup
    }

    // Check EV threshold
    if (metrics.evCents < this.config.minEvCents) {
      return {
        allowed: false,
        reason: `EV too low (${metrics.evCents.toFixed(2)}¢ < ${this.config.minEvCents}¢)`,
      };
    }

    // Check profit factor
    if (metrics.profitFactor < this.config.minProfitFactor) {
      return {
        allowed: false,
        reason: `Profit factor too low (${metrics.profitFactor.toFixed(2)} < ${this.config.minProfitFactor})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Force unpause (for testing or manual override)
   */
  unpause(): void {
    this.pausedUntil = 0;
  }

  /**
   * Get pause status
   */
  isPaused(): boolean {
    return this.pausedUntil > Date.now();
  }

  /**
   * Get remaining pause time in seconds
   */
  getPauseRemainingSeconds(): number {
    if (!this.isPaused()) return 0;
    return Math.ceil((this.pausedUntil - Date.now()) / 1000);
  }

  /**
   * Clear all trades (for testing)
   */
  clear(): void {
    this.trades = [];
    this.pausedUntil = 0;
  }

  /**
   * Get recent trades (for debugging)
   */
  getRecentTrades(count = 10): TradeResult[] {
    return this.trades.slice(-count);
  }

  /**
   * Convert to JSON log entry
   */
  toLogEntry(): object {
    const metrics = this.getMetrics();
    const tradingStatus = this.isTradingAllowed();
    return {
      type: "ev_metrics",
      timestamp: new Date().toISOString(),
      metrics: {
        totalTrades: metrics.totalTrades,
        wins: metrics.wins,
        losses: metrics.losses,
        winRate: parseFloat(metrics.winRate.toFixed(4)),
        avgWinCents: parseFloat(metrics.avgWinCents.toFixed(2)),
        avgLossCents: parseFloat(metrics.avgLossCents.toFixed(2)),
        evCents: parseFloat(metrics.evCents.toFixed(2)),
        profitFactor: parseFloat(metrics.profitFactor.toFixed(2)),
        totalPnlUsd: parseFloat(metrics.totalPnlUsd.toFixed(2)),
      },
      tradingAllowed: tradingStatus.allowed,
      tradingBlockedReason: tradingStatus.reason || null,
      paused: this.isPaused(),
      pauseRemainingSeconds: this.getPauseRemainingSeconds(),
    };
  }
}

function calculatePnlCents(
  side: "LONG" | "SHORT",
  entryPriceCents: number,
  exitPriceCents: number,
): number {
  if (side === "LONG") {
    return exitPriceCents - entryPriceCents;
  } else {
    return entryPriceCents - exitPriceCents;
  }
}

function calculatePnlUsd(
  pnlCents: number,
  sizeUsd: number,
  entryPriceCents: number,
): number {
  if (entryPriceCents === 0) return 0;
  const shares = sizeUsd / (entryPriceCents / 100);
  return (pnlCents / 100) * shares;
}

function createTradeResult(
  tokenId: string,
  side: "LONG" | "SHORT",
  entryPriceCents: number,
  exitPriceCents: number,
  sizeUsd: number,
): TradeResult {
  const pnlCents = calculatePnlCents(side, entryPriceCents, exitPriceCents);
  const pnlUsd = calculatePnlUsd(pnlCents, sizeUsd, entryPriceCents);
  return {
    tokenId,
    side,
    entryPriceCents,
    exitPriceCents,
    sizeUsd,
    timestamp: Date.now(),
    pnlCents,
    pnlUsd,
    isWin: pnlCents > 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BIAS ACCUMULATOR
// ═══════════════════════════════════════════════════════════════════════════

type BiasDirection = "LONG" | "SHORT" | "NONE";

interface LeaderboardTrade {
  tokenId: string;
  marketId?: string;
  wallet: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  timestamp: number;
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

  // API endpoints - using data-api v1 for leaderboard (gamma-api leaderboard is deprecated)
  private readonly DATA_API = "https://data-api.polymarket.com";

  constructor(config: ChurnConfig) {
    this.config = config;
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
                { timeout: 5000 }
              );
              const lastTraded = Array.isArray(data) && data.length > 0 ? Number(data[0].timestamp || 0) * 1000 : 0;
              return { ...entry, lastTraded };
            } catch (err) {
              // Activity fetch failed - trader may have no activity or API issue
              // Continue gracefully - they'll show with N/A timestamp
              console.debug?.(`   Activity fetch for ${wallet.slice(0, 10)}... failed: ${err instanceof Error ? err.message : 'Unknown'}`);
              return { ...entry, lastTraded: 0 };
            }
          });
          
          const top10WithActivity = await Promise.all(activityPromises);
          
          // Sort by last traded (most recent first)
          top10WithActivity.sort((a, b) => b.lastTraded - a.lastTraded);
          
          console.log(`\n🐋 TOP 10 TRADERS (sorted by last traded, from ${allEntries.length} tracked):`);
          for (const entry of top10WithActivity) {
            const wallet = (entry.proxyWallet || entry.address || '').slice(0, 12);
            const pnl = Number(entry.pnl || 0);
            const vol = Number(entry.vol || 0);
            const name = entry.userName || 'anon';
            const lastTradedStr = entry.lastTraded > 0 
              ? new Date(entry.lastTraded).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
              : 'N/A';
            console.log(`   ${wallet}... | Last: ${lastTradedStr} | PNL: $${pnl >= 1000 ? (pnl/1000).toFixed(0) + 'k' : pnl.toFixed(0)} | Vol: $${vol >= 1000 ? (vol/1000).toFixed(0) + 'k' : vol.toFixed(0)} | @${name}`);
          }
          console.log('');
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
        console.log(`🐋 Tracking ${trackedCount} top traders (requested: ${targetCount})`);
        
        // Report if we got significantly fewer wallets than requested (potential issue)
        if (trackedCount < targetCount * 0.95) {
          reportError(
            "Leaderboard Wallet Count Mismatch",
            `Got ${trackedCount} unique wallets instead of requested ${targetCount}. May have duplicates or API limit.`,
            "info",
            { trackedCount, requestedCount: targetCount, entriesReturned: allEntries.length }
          );
        }
      }
    } catch (err) {
      // Keep existing wallets on error
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`⚠️ Leaderboard fetch failed: ${errorMsg}`);
      reportError(
        "Leaderboard Fetch Failed",
        errorMsg,
        "warning",
        { requestedCount: targetCount }
      );
    }

    return Array.from(this.leaderboardWallets);
  }

  /**
   * Fetch recent trades for leaderboard wallets - PARALLEL EXECUTION
   * Only tracks BUY trades - we have our own exit math, don't copy sells
   */
  async fetchLeaderboardTrades(): Promise<LeaderboardTrade[]> {
    const wallets = await this.refreshLeaderboard();
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    if (wallets.length === 0) {
      return [];
    }

    // Fetch all wallets in parallel for speed
    // API can handle concurrent requests, and we want to catch whale movement FAST
    const fetchPromises = wallets.map(async (wallet) => {
      try {
        const url = `${this.DATA_API}/trades?user=${wallet}&limit=20`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (!Array.isArray(data)) return [];

        const trades: LeaderboardTrade[] = [];
        for (const trade of data) {
          // Only track BUY trades - we don't copy sells, we have our own exit math
          if (trade.side?.toUpperCase() !== "BUY") continue;

          const timestamp = new Date(
            trade.timestamp || trade.createdAt,
          ).getTime();

          // Only trades within window
          if (timestamp < windowStart) continue;

          const tokenId = trade.asset || trade.tokenId;
          if (!tokenId) continue;

          const sizeUsd = Number(trade.size) * Number(trade.price) || 0;
          if (sizeUsd <= 0) continue;

          trades.push({
            tokenId,
            marketId: trade.marketId,
            wallet: wallet,
            side: "BUY", // Only BUY trades
            sizeUsd,
            timestamp,
          });
        }
        return trades;
      } catch {
        // Continue on error - don't block other wallets
        return [];
      }
    });

    // Wait for all fetches to complete in parallel
    const results = await Promise.all(fetchPromises);
    const newTrades = results.flat();

    // Add to accumulator and prune old trades
    this.addTrades(newTrades);

    return newTrades;
  }

  /**
   * Add trades and maintain window
   * Deduplicates by txHash+tokenId+wallet to prevent counting the same trade twice
   * (e.g., from both on-chain events and API polling)
   */
  private addTrades(trades: LeaderboardTrade[]): void {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    for (const trade of trades) {
      const existing = this.trades.get(trade.tokenId) || [];
      
      // Deduplication: check if this trade already exists
      // Use a composite key of timestamp + wallet + size to identify duplicates
      // (On-chain and API trades may have slightly different timestamps)
      const isDuplicate = existing.some(t => 
        t.wallet.toLowerCase() === trade.wallet.toLowerCase() &&
        Math.abs(t.sizeUsd - trade.sizeUsd) < 0.01 && // Same size (within rounding)
        Math.abs(t.timestamp - trade.timestamp) < 60000 // Within 1 minute
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

    // Determine direction - only LONG since we only track BUYs
    // Whales buying = we buy too
    let direction: BiasDirection = "NONE";
    if (!isStale && tradeCount >= this.config.biasMinTrades) {
      if (netUsd >= this.config.biasMinNetUsd) {
        direction = "LONG";
      }
      // No SHORT direction - we don't copy sells, we have our own exit math
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
        if (bias.direction !== "NONE") {
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
        return { allowed: false, reason: "BIAS_STALE" };
      }
      return { allowed: false, reason: "NO_WHALE_BUY_SEEN" };
    }

    if (!this.config.allowEntriesOnlyWithBias) {
      return { allowed: true };
    }

    const bias = this.getBias(tokenId);

    if (bias.direction === "NONE") {
      if (bias.isStale) {
        return { allowed: false, reason: "BIAS_STALE" };
      }
      if (bias.tradeCount < this.config.biasMinTrades) {
        return {
          allowed: false,
          reason: `BIAS_INSUFFICIENT_TRADES (${bias.tradeCount} < ${this.config.biasMinTrades})`,
        };
      }
      return {
        allowed: false,
        reason: `BIAS_NONE (net_usd=${bias.netUsd.toFixed(2)})`,
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
          if (yesPrice < 0.20 || yesPrice > 0.80) continue;

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
        console.log(`📊 Scanned ${this.activeMarkets.length} active markets (top by 24h volume)`);
      }

      return this.activeMarkets;
    } catch (err) {
      console.warn(`[Scanner] Failed to scan markets: ${err instanceof Error ? err.message : err}`);
      return this.activeMarkets;
    }
  }

  /**
   * Get token IDs from scanned active markets
   * These can be used as additional trading opportunities
   */
  getActiveTokenIds(): string[] {
    return this.activeMarkets.map(m => m.tokenId);
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
  recordMissedOpportunity(tokenId: string, sizeUsd: number, reason: "INSUFFICIENT_BALANCE" | "RESERVE_BLOCKED"): void {
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
  getEffectiveBankroll(balance: number): { effectiveBankroll: number; reserveUsd: number } {
    const reserveFraction = this.getEffectiveReserveFraction();
    const reserveUsd = Math.max(balance * reserveFraction, this.config.minReserveUsd);
    return { 
      effectiveBankroll: Math.max(0, balance - reserveUsd), 
      reserveUsd 
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
    const recentMissed = this.missedOpportunities.filter(m => m.timestamp >= windowStart);
    const missedCount = recentMissed.length;

    // Calculate adjustment factors
    // More missed opportunities → LOWER reserves (need more capital available)
    // More missed hedges → HIGHER reserves (need capital for hedging)
    
    const missedFactor = Math.min(missedCount * 0.02, 0.15); // Up to 15% reduction
    const hedgeFactor = Math.min(this.hedgesMissed * 0.03, 0.10); // Up to 10% increase

    // Apply weighted adjustments
    const missedAdjustment = missedFactor * this.config.missedOpportunityWeight;
    const hedgeAdjustment = hedgeFactor * this.config.hedgeCoverageWeight;

    // Calculate target reserve fraction
    const targetFraction = this.config.reserveFraction - missedAdjustment + hedgeAdjustment;
    
    // Clamp to valid range
    const clampedTarget = Math.max(0.10, Math.min(this.config.maxReserveFraction, targetFraction));

    // Smooth adaptation
    this.adaptedReserveFraction = this.adaptedReserveFraction + 
      (clampedTarget - this.adaptedReserveFraction) * this.config.reserveAdaptationRate;
  }

  /**
   * Remove old entries outside the window
   */
  private pruneOldEntries(): void {
    const cutoff = Date.now() - this.WINDOW_MS;
    this.missedOpportunities = this.missedOpportunities.filter(m => m.timestamp >= cutoff);
    
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
      missedOpportunitiesUsd: recentMissed.reduce((sum, m) => sum + m.sizeUsd, 0),
      hedgeNeedsUsd: this.hedgesMissed * this.config.maxTradeUsd * this.config.hedgeRatio,
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
// POSITION STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

type PositionState = "OPEN" | "HEDGED" | "EXITING" | "CLOSED";

type ExitReason =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "TIME_STOP"
  | "HARD_EXIT"
  | "BIAS_FLIP"
  | "EV_DEGRADED"
  | "MANUAL";

interface HedgeLeg {
  tokenId: string; // Opposite side token
  sizeUsd: number;
  entryPriceCents: number;
  entryTime: number;
  pnlCents: number;
}

interface StateTransition {
  positionId: string;
  fromState: PositionState;
  toState: PositionState;
  reason: string;
  timestamp: number;
  pnlCents: number;
  pnlUsd: number;
  evSnapshot: EvMetrics | null;
  biasDirection: BiasDirection;
}

interface ManagedPosition {
  id: string;
  tokenId: string;
  marketId?: string;
  side: "LONG" | "SHORT";
  state: PositionState;

  // Entry
  entryPriceCents: number;
  entrySizeUsd: number;
  entryTime: number;

  // Current
  currentPriceCents: number;
  unrealizedPnlCents: number;
  unrealizedPnlUsd: number;

  // Targets
  takeProfitPriceCents: number;
  hedgeTriggerPriceCents: number;
  hardExitPriceCents: number;

  // Hedge - including opposite token for proper hedging
  hedges: HedgeLeg[];
  totalHedgeRatio: number;
  oppositeTokenId?: string; // The opposite outcome token for hedging (YES↔NO)

  // Reference
  referencePriceCents: number;

  // History
  transitions: StateTransition[];
  lastUpdateTime: number;

  // External position flag - true if not opened by the bot
  isExternal?: boolean;
}

interface PositionManagerConfig {
  tpCents: number;
  hedgeTriggerCents: number;
  maxAdverseCents: number;
  maxHoldSeconds: number;
  hedgeRatio: number;
  maxHedgeRatio: number;
}

class PositionManager {
  private positions: Map<string, ManagedPosition> = new Map();
  private readonly config: PositionManagerConfig;
  private transitionCallbacks: ((t: StateTransition) => void)[] = [];

  constructor(config: PositionManagerConfig) {
    this.config = config;
  }

  /**
   * Register callback for state transitions
   */
  onTransition(callback: (t: StateTransition) => void): void {
    this.transitionCallbacks.push(callback);
  }

  /**
   * Open a new position
   */
  openPosition(params: {
    tokenId: string;
    marketId?: string;
    side: "LONG" | "SHORT";
    entryPriceCents: number;
    sizeUsd: number;
    referencePriceCents: number;
    evSnapshot: EvMetrics | null;
    biasDirection: BiasDirection;
  }): ManagedPosition {
    const id = `${params.tokenId}-${Date.now()}`;
    const now = Date.now();

    // Calculate targets based on side
    let takeProfitPriceCents: number;
    let hedgeTriggerPriceCents: number;
    let hardExitPriceCents: number;

    if (params.side === "LONG") {
      takeProfitPriceCents = params.entryPriceCents + this.config.tpCents;
      hedgeTriggerPriceCents =
        params.entryPriceCents - this.config.hedgeTriggerCents;
      hardExitPriceCents = params.entryPriceCents - this.config.maxAdverseCents;
    } else {
      takeProfitPriceCents = params.entryPriceCents - this.config.tpCents;
      hedgeTriggerPriceCents =
        params.entryPriceCents + this.config.hedgeTriggerCents;
      hardExitPriceCents = params.entryPriceCents + this.config.maxAdverseCents;
    }

    const position: ManagedPosition = {
      id,
      tokenId: params.tokenId,
      marketId: params.marketId,
      side: params.side,
      state: "OPEN",
      entryPriceCents: params.entryPriceCents,
      entrySizeUsd: params.sizeUsd,
      entryTime: now,
      currentPriceCents: params.entryPriceCents,
      unrealizedPnlCents: 0,
      unrealizedPnlUsd: 0,
      takeProfitPriceCents,
      hedgeTriggerPriceCents,
      hardExitPriceCents,
      hedges: [],
      totalHedgeRatio: 0,
      referencePriceCents: params.referencePriceCents,
      transitions: [],
      lastUpdateTime: now,
    };

    this.positions.set(id, position);

    // Record initial transition
    this.recordTransition(position, "OPEN", "OPEN", "POSITION_OPENED", {
      evSnapshot: params.evSnapshot,
      biasDirection: params.biasDirection,
    });

    return position;
  }

  /**
   * Set the opposite token ID for a position (for hedging)
   * This should be called after opening a position with the result of getOppositeTokenId()
   */
  setOppositeToken(positionId: string, oppositeTokenId: string): void {
    const position = this.positions.get(positionId);
    if (position) {
      position.oppositeTokenId = oppositeTokenId;
      console.log(`🔗 [HEDGE] Linked opposite token ${oppositeTokenId.slice(0, 16)}... for position ${positionId.slice(0, 16)}...`);
    }
  }

  /**
   * Get the opposite token ID for a position
   */
  getOppositeToken(positionId: string): string | undefined {
    return this.positions.get(positionId)?.oppositeTokenId;
  }

  /**
   * Register an external position for monitoring
   * This allows the bot to apply exit math (TP, stop loss, hedging) to positions
   * that were not opened by the bot (e.g., manual trades, pre-existing positions)
   * 
   * Note: This is async because it needs to fetch the opposite token ID for hedging
   */
  async registerExternalPosition(pos: Position): Promise<ManagedPosition | null> {
    // Check if already tracked
    for (const [, managed] of this.positions) {
      if (managed.tokenId === pos.tokenId && managed.state !== "CLOSED") {
        return null; // Already tracking
      }
    }

    const id = `ext-${pos.tokenId}-${Date.now()}`;
    const now = Date.now();
    
    // Determine side based on outcome (YES = LONG, NO = SHORT)
    const side: "LONG" | "SHORT" = pos.outcome?.toUpperCase() === "NO" ? "SHORT" : "LONG";
    
    // Convert current price to cents
    const currentPriceCents = pos.curPrice * 100;
    
    // Use average price as entry (best guess for external positions)
    const entryPriceCents = pos.avgPrice * 100;
    
    // Calculate targets based on current price (since we don't know original entry intent)
    let takeProfitPriceCents: number;
    let hedgeTriggerPriceCents: number;
    let hardExitPriceCents: number;

    if (side === "LONG") {
      takeProfitPriceCents = entryPriceCents + this.config.tpCents;
      hedgeTriggerPriceCents = entryPriceCents - this.config.hedgeTriggerCents;
      hardExitPriceCents = entryPriceCents - this.config.maxAdverseCents;
    } else {
      takeProfitPriceCents = entryPriceCents - this.config.tpCents;
      hedgeTriggerPriceCents = entryPriceCents + this.config.hedgeTriggerCents;
      hardExitPriceCents = entryPriceCents + this.config.maxAdverseCents;
    }

    // Calculate P&L correctly based on side
    const pnlCents = pos.gainCents || (side === "LONG" 
      ? (currentPriceCents - entryPriceCents) 
      : (entryPriceCents - currentPriceCents));

    const position: ManagedPosition = {
      id,
      tokenId: pos.tokenId,
      marketId: pos.marketId,
      side,
      state: "OPEN",
      entryPriceCents,
      entrySizeUsd: pos.value,
      entryTime: pos.entryTime || now - 60000, // Default to 1 min ago if unknown
      currentPriceCents,
      unrealizedPnlCents: pnlCents,
      unrealizedPnlUsd: pos.pnlUsd,
      takeProfitPriceCents,
      hedgeTriggerPriceCents,
      hardExitPriceCents,
      hedges: [],
      totalHedgeRatio: 0,
      referencePriceCents: currentPriceCents,
      transitions: [],
      lastUpdateTime: now,
      isExternal: true, // Flag to identify external positions
    };

    this.positions.set(id, position);
    
    // Fetch opposite token ID for hedging capability
    try {
      const oppositeTokenId = await getOppositeTokenId(pos.tokenId);
      if (oppositeTokenId) {
        position.oppositeTokenId = oppositeTokenId;
        console.log(`📋 Registered external position: ${pos.outcome} @ ${(entryPriceCents).toFixed(0)}¢ (P&L: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}%) [hedge-ready]`);
      } else {
        console.log(`📋 Registered external position: ${pos.outcome} @ ${(entryPriceCents).toFixed(0)}¢ (P&L: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}%) [no hedge]`);
      }
    } catch {
      console.log(`📋 Registered external position: ${pos.outcome} @ ${(entryPriceCents).toFixed(0)}¢ (P&L: ${pos.pnlPct >= 0 ? '+' : ''}${pos.pnlPct.toFixed(1)}%) [no hedge]`);
    }

    return position;
  }

  /**
   * Update position with current price
   */
  updatePrice(
    positionId: string,
    currentPriceCents: number,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): {
    action: "NONE" | "HEDGE" | "EXIT";
    reason?: ExitReason;
  } {
    const position = this.positions.get(positionId);
    if (!position || position.state === "CLOSED") {
      return { action: "NONE" };
    }

    const now = Date.now();
    position.currentPriceCents = currentPriceCents;
    position.lastUpdateTime = now;

    // Calculate unrealized P&L
    if (position.side === "LONG") {
      position.unrealizedPnlCents =
        currentPriceCents - position.entryPriceCents;
    } else {
      position.unrealizedPnlCents =
        position.entryPriceCents - currentPriceCents;
    }

    const shares = position.entrySizeUsd / (position.entryPriceCents / 100);
    position.unrealizedPnlUsd = (position.unrealizedPnlCents / 100) * shares;

    // Check exit conditions (ANY triggers exit)

    // 1. Take profit
    if (this.checkTakeProfit(position)) {
      return { action: "EXIT", reason: "TAKE_PROFIT" };
    }

    // 2. Hard exit (max adverse)
    if (this.checkHardExit(position)) {
      return { action: "EXIT", reason: "HARD_EXIT" };
    }

    // 3. Time stop
    const holdTime = (now - position.entryTime) / 1000;
    if (holdTime >= this.config.maxHoldSeconds) {
      return { action: "EXIT", reason: "TIME_STOP" };
    }

    // 4. Hedge trigger (if not already fully hedged)
    if (
      position.state === "OPEN" &&
      position.totalHedgeRatio < this.config.maxHedgeRatio &&
      this.checkHedgeTrigger(position)
    ) {
      return { action: "HEDGE" };
    }

    return { action: "NONE" };
  }

  /**
   * Check if take profit is triggered
   */
  private checkTakeProfit(position: ManagedPosition): boolean {
    if (position.side === "LONG") {
      return position.currentPriceCents >= position.takeProfitPriceCents;
    } else {
      return position.currentPriceCents <= position.takeProfitPriceCents;
    }
  }

  /**
   * Check if hard exit is triggered
   */
  private checkHardExit(position: ManagedPosition): boolean {
    if (position.side === "LONG") {
      return position.currentPriceCents <= position.hardExitPriceCents;
    } else {
      return position.currentPriceCents >= position.hardExitPriceCents;
    }
  }

  /**
   * Check if hedge trigger is hit
   */
  private checkHedgeTrigger(position: ManagedPosition): boolean {
    if (position.side === "LONG") {
      return position.currentPriceCents <= position.hedgeTriggerPriceCents;
    } else {
      return position.currentPriceCents >= position.hedgeTriggerPriceCents;
    }
  }

  /**
   * Record a hedge being placed
   */
  recordHedge(
    positionId: string,
    hedge: Omit<HedgeLeg, "pnlCents">,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): void {
    const position = this.positions.get(positionId);
    if (!position) return;

    const hedgeLeg: HedgeLeg = {
      ...hedge,
      pnlCents: 0,
    };

    position.hedges.push(hedgeLeg);
    position.totalHedgeRatio += this.config.hedgeRatio;

    // Transition to HEDGED state
    if (position.state === "OPEN") {
      this.recordTransition(position, "OPEN", "HEDGED", "HEDGE_PLACED", {
        evSnapshot,
        biasDirection,
      });
      position.state = "HEDGED";
    }
  }

  /**
   * Begin exit process
   */
  beginExit(
    positionId: string,
    reason: ExitReason,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): void {
    const position = this.positions.get(positionId);
    if (!position || position.state === "CLOSED") return;

    this.recordTransition(position, position.state, "EXITING", reason, {
      evSnapshot,
      biasDirection,
    });
    position.state = "EXITING";
  }

  /**
   * Complete exit and close position
   */
  closePosition(
    positionId: string,
    exitPriceCents: number,
    evSnapshot: EvMetrics | null,
    biasDirection: BiasDirection,
  ): ManagedPosition | null {
    const position = this.positions.get(positionId);
    if (!position) return null;

    // Calculate final P&L
    if (position.side === "LONG") {
      position.unrealizedPnlCents = exitPriceCents - position.entryPriceCents;
    } else {
      position.unrealizedPnlCents = position.entryPriceCents - exitPriceCents;
    }

    const shares = position.entrySizeUsd / (position.entryPriceCents / 100);
    position.unrealizedPnlUsd = (position.unrealizedPnlCents / 100) * shares;
    position.currentPriceCents = exitPriceCents;

    this.recordTransition(position, position.state, "CLOSED", "POSITION_CLOSED", {
      evSnapshot,
      biasDirection,
    });
    position.state = "CLOSED";

    return position;
  }

  /**
   * Record a state transition
   */
  private recordTransition(
    position: ManagedPosition,
    fromState: PositionState,
    toState: PositionState,
    reason: string,
    context: {
      evSnapshot: EvMetrics | null;
      biasDirection: BiasDirection;
    },
  ): void {
    const transition: StateTransition = {
      positionId: position.id,
      fromState,
      toState,
      reason,
      timestamp: Date.now(),
      pnlCents: position.unrealizedPnlCents,
      pnlUsd: position.unrealizedPnlUsd,
      evSnapshot: context.evSnapshot,
      biasDirection: context.biasDirection,
    };

    position.transitions.push(transition);

    // Fire callbacks
    for (const callback of this.transitionCallbacks) {
      callback(transition);
    }
  }

  /**
   * Get position by ID
   */
  getPosition(positionId: string): ManagedPosition | undefined {
    return this.positions.get(positionId);
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): ManagedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.state !== "CLOSED",
    );
  }

  /**
   * Get positions by token
   */
  getPositionsByToken(tokenId: string): ManagedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.tokenId === tokenId && p.state !== "CLOSED",
    );
  }

  /**
   * Get positions by market
   */
  getPositionsByMarket(marketId: string): ManagedPosition[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.marketId === marketId && p.state !== "CLOSED",
    );
  }

  /**
   * Get total deployed USD
   */
  getTotalDeployedUsd(): number {
    return this.getOpenPositions().reduce((sum, p) => sum + p.entrySizeUsd, 0);
  }

  /**
   * Remove closed positions older than specified age
   */
  pruneClosedPositions(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const [id, position] of this.positions.entries()) {
      if (position.state === "CLOSED" && position.lastUpdateTime < cutoff) {
        this.positions.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  /**
   * Clear all positions (for testing)
   */
  clear(): void {
    this.positions.clear();
  }

  /**
   * Convert position to JSON log entry
   */
  positionToLogEntry(position: ManagedPosition): object {
    return {
      type: "position",
      timestamp: new Date().toISOString(),
      id: position.id,
      tokenId: position.tokenId.slice(0, 12) + "...",
      marketId: position.marketId,
      side: position.side,
      state: position.state,
      entryPriceCents: position.entryPriceCents,
      currentPriceCents: position.currentPriceCents,
      unrealizedPnlCents: parseFloat(position.unrealizedPnlCents.toFixed(2)),
      unrealizedPnlUsd: parseFloat(position.unrealizedPnlUsd.toFixed(2)),
      takeProfitCents: position.takeProfitPriceCents,
      hedgeTriggerCents: position.hedgeTriggerPriceCents,
      hardExitCents: position.hardExitPriceCents,
      hedgeCount: position.hedges.length,
      totalHedgeRatio: parseFloat(position.totalHedgeRatio.toFixed(2)),
      holdTimeSeconds: Math.round(
        (Date.now() - position.entryTime) / 1000,
      ),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DECISION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

interface OrderbookState {
  bestBidCents: number;
  bestAskCents: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  spreadCents: number;
  midPriceCents: number;
}

interface MarketActivity {
  tradesInWindow: number;
  bookUpdatesInWindow: number;
  lastTradeTime: number;
  lastUpdateTime: number;
}

interface EntryDecision {
  allowed: boolean;
  side?: "LONG" | "SHORT";
  priceCents?: number;
  sizeUsd?: number;
  reason?: string;
  checks: {
    bias: { passed: boolean; value: BiasDirection; reason?: string };
    liquidity: { passed: boolean; reason?: string };
    priceDeviation: { passed: boolean; reason?: string };
    priceBounds: { passed: boolean; reason?: string };
    riskLimits: { passed: boolean; reason?: string };
    evAllowed: { passed: boolean; reason?: string };
  };
}

interface ExitDecision {
  shouldExit: boolean;
  reason?:
    | "TAKE_PROFIT"
    | "STOP_LOSS"
    | "TIME_STOP"
    | "HARD_EXIT"
    | "BIAS_FLIP"
    | "EV_DEGRADED";
  urgency: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
}

class DecisionEngine {
  private readonly config: ChurnConfig;

  constructor(config: ChurnConfig) {
    this.config = config;
  }

  /**
   * Evaluate entry conditions
   */
  evaluateEntry(params: {
    tokenId: string;
    bias: BiasDirection;
    orderbook: OrderbookState;
    activity: MarketActivity;
    referencePriceCents: number;
    evMetrics: EvMetrics;
    evAllowed: { allowed: boolean; reason?: string };
    currentPositions: ManagedPosition[];
    effectiveBankroll: number;
    totalDeployedUsd: number;
  }): EntryDecision {
    const checks: EntryDecision["checks"] = {
      bias: { passed: false, value: params.bias },
      liquidity: { passed: false },
      priceDeviation: { passed: false },
      priceBounds: { passed: false },
      riskLimits: { passed: false },
      evAllowed: { passed: false },
    };

    // 1) Check bias
    if (params.bias === "NONE") {
      checks.bias.reason = "No bias signal";
    } else {
      checks.bias.passed = true;
    }

    // 2) Check liquidity gates
    const liquidityCheck = this.checkLiquidity(params.orderbook, params.activity);
    checks.liquidity = liquidityCheck;

    // 3) Check price deviation from reference
    // NOTE: For NEW entries, referencePriceCents equals current midPrice (no historical reference)
    // The deviation check is only meaningful for RE-ENTRY after exiting a position.
    // For new entries triggered by whale signals or scanner, we skip this check since:
    // - Price bounds check (30-82¢) ensures we enter at reasonable prices
    // - Whale signals provide the "edge" that replaces price deviation requirement
    const currentPriceCents = params.orderbook.midPriceCents;
    const deviation = Math.abs(currentPriceCents - params.referencePriceCents);
    
    // Threshold for considering prices equal (accounts for floating point imprecision)
    const PRICE_EQUALITY_THRESHOLD_CENTS = 0.01;
    
    // If reference equals current (new entry), skip this check - the bias signal is our edge
    // If reference differs (re-entry), require minimum deviation
    if (deviation < PRICE_EQUALITY_THRESHOLD_CENTS) {
      // New entry: reference price equals current price, skip deviation check
      checks.priceDeviation.passed = true;
      checks.priceDeviation.reason = "New entry (whale/scanner signal)";
    } else if (deviation >= this.config.entryBandCents) {
      checks.priceDeviation.passed = true;
    } else {
      checks.priceDeviation.reason = `Deviation ${deviation.toFixed(1)}¢ < ${this.config.entryBandCents}¢`;
    }

    // 4) Check entry price bounds
    const entryPriceCents =
      params.bias === "LONG"
        ? params.orderbook.bestAskCents
        : params.orderbook.bestBidCents;

    if (
      entryPriceCents >= this.config.minEntryPriceCents &&
      entryPriceCents <= this.config.maxEntryPriceCents
    ) {
      checks.priceBounds.passed = true;
    } else {
      checks.priceBounds.reason = `Price ${entryPriceCents}¢ outside [${this.config.minEntryPriceCents}, ${this.config.maxEntryPriceCents}]`;
    }

    // 5) Check risk limits
    const riskCheck = this.checkRiskLimits(
      params.tokenId,
      params.currentPositions,
      params.effectiveBankroll,
      params.totalDeployedUsd,
    );
    checks.riskLimits = riskCheck;

    // 6) Check EV allows trading
    if (params.evAllowed.allowed) {
      checks.evAllowed.passed = true;
    } else {
      checks.evAllowed.reason = params.evAllowed.reason;
    }

    // All checks must pass
    const allPassed = Object.values(checks).every((c) => c.passed);

    if (!allPassed) {
      const failedChecks = Object.entries(checks)
        .filter(([_, v]) => !v.passed)
        .map(([k, v]) => `${k}: ${v.reason || "failed"}`)
        .join("; ");

      return {
        allowed: false,
        reason: failedChecks,
        checks,
      };
    }

    // Calculate size
    const sizeUsd = this.calculateSize(params.effectiveBankroll);

    return {
      allowed: true,
      side: params.bias as "LONG" | "SHORT",
      priceCents: entryPriceCents,
      sizeUsd,
      checks,
    };
  }

  /**
   * Check liquidity gates
   */
  private checkLiquidity(
    orderbook: OrderbookState,
    activity: MarketActivity,
  ): { passed: boolean; reason?: string } {
    // Spread check
    if (orderbook.spreadCents > this.config.minSpreadCents) {
      return {
        passed: false,
        reason: `Spread ${orderbook.spreadCents}¢ > ${this.config.minSpreadCents}¢`,
      };
    }

    // Depth check (need enough depth to exit)
    const minDepth = Math.min(orderbook.bidDepthUsd, orderbook.askDepthUsd);
    if (minDepth < this.config.minDepthUsdAtExit) {
      return {
        passed: false,
        reason: `Depth $${minDepth.toFixed(0)} < $${this.config.minDepthUsdAtExit}`,
      };
    }

    // Activity check
    if (
      activity.tradesInWindow < this.config.minTradesLastX &&
      activity.bookUpdatesInWindow < this.config.minBookUpdatesLastX
    ) {
      return {
        passed: false,
        reason: `Activity too low (${activity.tradesInWindow} trades, ${activity.bookUpdatesInWindow} updates)`,
      };
    }

    return { passed: true };
  }

  /**
   * Check risk limits
   */
  private checkRiskLimits(
    tokenId: string,
    currentPositions: ManagedPosition[],
    effectiveBankroll: number,
    totalDeployedUsd: number,
  ): { passed: boolean; reason?: string } {
    // Max total positions
    if (currentPositions.length >= this.config.maxOpenPositionsTotal) {
      return {
        passed: false,
        reason: `Max positions (${this.config.maxOpenPositionsTotal})`,
      };
    }

    // Max positions per market/token - prevents duplicate entries on same token
    // NOTE: Hedges are stored inside the position object (position.hedges[]), not as separate positions
    // So this check only blocks NEW entries, not hedging operations
    const tokenPositions = currentPositions.filter(
      (p) => p.tokenId === tokenId && p.state !== "CLOSED",
    );
    if (tokenPositions.length >= this.config.maxOpenPositionsPerMarket) {
      return {
        passed: false,
        reason: `Already holding position on this token (${tokenPositions.length}/${this.config.maxOpenPositionsPerMarket})`,
      };
    }

    // Max deployed fraction
    const maxDeployed = effectiveBankroll * this.config.maxDeployedFractionTotal;
    if (totalDeployedUsd >= maxDeployed) {
      return {
        passed: false,
        reason: `Max deployed $${maxDeployed.toFixed(0)}`,
      };
    }

    // Effective bankroll must be positive
    if (effectiveBankroll <= 0) {
      return {
        passed: false,
        reason: "No effective bankroll",
      };
    }

    return { passed: true };
  }

  /**
   * Calculate trade size
   */
  private calculateSize(effectiveBankroll: number): number {
    const fractionalSize = effectiveBankroll * this.config.tradeFraction;
    return Math.min(fractionalSize, this.config.maxTradeUsd);
  }

  /**
   * Check if entry is in preferred zone
   */
  isInPreferredZone(priceCents: number): boolean {
    return (
      priceCents >= this.config.preferredEntryLowCents &&
      priceCents <= this.config.preferredEntryHighCents
    );
  }

  /**
   * Calculate entry score (higher = better entry)
   */
  calculateEntryScore(params: {
    priceCents: number;
    spreadCents: number;
    depthUsd: number;
    activityScore: number;
  }): number {
    let score = 0;

    // Preferred zone bonus (0-30 points)
    if (this.isInPreferredZone(params.priceCents)) {
      // Center of preferred zone is ideal
      const center =
        (this.config.preferredEntryLowCents + this.config.preferredEntryHighCents) /
        2;
      const distFromCenter = Math.abs(params.priceCents - center);
      const maxDist =
        (this.config.preferredEntryHighCents - this.config.preferredEntryLowCents) /
        2;
      score += 30 * (1 - distFromCenter / maxDist);
    }

    // Tight spread bonus (0-25 points)
    const spreadRatio = params.spreadCents / this.config.minSpreadCents;
    score += Math.max(0, 25 * (2 - spreadRatio));

    // Depth bonus (0-25 points)
    const depthRatio = params.depthUsd / this.config.minDepthUsdAtExit;
    score += Math.min(25, 25 * (depthRatio - 1));

    // Activity bonus (0-20 points)
    score += Math.min(20, params.activityScore * 20);

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Evaluate exit conditions for a position
   */
  evaluateExit(params: {
    position: ManagedPosition;
    currentPriceCents: number;
    bias: BiasDirection;
    evAllowed: { allowed: boolean; reason?: string };
  }): ExitDecision {
    const { position, currentPriceCents, bias, evAllowed } = params;

    // Calculate current P&L
    let pnlCents: number;
    if (position.side === "LONG") {
      pnlCents = currentPriceCents - position.entryPriceCents;
    } else {
      pnlCents = position.entryPriceCents - currentPriceCents;
    }

    // 1) Take profit
    if (pnlCents >= this.config.tpCents) {
      return {
        shouldExit: true,
        reason: "TAKE_PROFIT",
        urgency: "MEDIUM",
      };
    }

    // 2) Hard exit (max adverse)
    if (pnlCents <= -this.config.maxAdverseCents) {
      return {
        shouldExit: true,
        reason: "HARD_EXIT",
        urgency: "CRITICAL",
      };
    }

    // 3) Time stop
    const holdTimeSeconds = (Date.now() - position.entryTime) / 1000;
    if (holdTimeSeconds >= this.config.maxHoldSeconds) {
      return {
        shouldExit: true,
        reason: "TIME_STOP",
        urgency: pnlCents > 0 ? "LOW" : "MEDIUM",
      };
    }

    // 4) Bias flip (position direction no longer matches bias)
    if (
      (position.side === "LONG" && bias === "SHORT") ||
      (position.side === "SHORT" && bias === "LONG")
    ) {
      // Only exit if we're profitable or at small loss
      if (pnlCents > -this.config.hedgeTriggerCents) {
        return {
          shouldExit: true,
          reason: "BIAS_FLIP",
          urgency: "LOW",
        };
      }
    }

    // 5) EV degraded
    if (!evAllowed.allowed && pnlCents > 0) {
      return {
        shouldExit: true,
        reason: "EV_DEGRADED",
        urgency: "LOW",
      };
    }

    return {
      shouldExit: false,
      urgency: "LOW",
    };
  }

  /**
   * Check if position needs hedging
   */
  needsHedge(position: ManagedPosition, currentPriceCents: number): boolean {
    if (position.totalHedgeRatio >= this.config.maxHedgeRatio) {
      return false;
    }

    let adverseMove: number;
    if (position.side === "LONG") {
      adverseMove = position.entryPriceCents - currentPriceCents;
    } else {
      adverseMove = currentPriceCents - position.entryPriceCents;
    }

    return adverseMove >= this.config.hedgeTriggerCents;
  }

  /**
   * Calculate hedge size
   */
  calculateHedgeSize(position: ManagedPosition): number {
    const remainingHedgeRoom =
      this.config.maxHedgeRatio - position.totalHedgeRatio;
    const hedgeRatio = Math.min(this.config.hedgeRatio, remainingHedgeRoom);
    return position.entrySizeUsd * hedgeRatio;
  }

  /**
   * Convert to JSON log entry
   */
  toLogEntry(decision: EntryDecision): object {
    return {
      type: "entry_decision",
      timestamp: new Date().toISOString(),
      allowed: decision.allowed,
      side: decision.side || null,
      priceCents: decision.priceCents || null,
      sizeUsd: decision.sizeUsd
        ? parseFloat(decision.sizeUsd.toFixed(2))
        : null,
      reason: decision.reason || null,
      checks: {
        bias: {
          passed: decision.checks.bias.passed,
          value: decision.checks.bias.value,
        },
        liquidity: decision.checks.liquidity.passed,
        priceDeviation: decision.checks.priceDeviation.passed,
        priceBounds: decision.checks.priceBounds.passed,
        riskLimits: decision.checks.riskLimits.passed,
        evAllowed: decision.checks.evAllowed.passed,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

interface ExecutionResult {
  success: boolean;
  filledUsd?: number;
  filledPriceCents?: number;
  reason?: string;
  pending?: boolean;  // True if order is GTC and waiting for fill
}

interface TokenMarketData {
  tokenId: string;
  marketId?: string;
  orderbook: OrderbookState;
  activity: MarketActivity;
  referencePriceCents: number;
  // Opposite token data for hedging - proactively monitored
  oppositeTokenId?: string;
  oppositeOrderbook?: OrderbookState;
}

interface ChurnLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

class SimpleLogger implements ChurnLogger {
  info(msg: string): void { console.log(msg); }
  warn(msg: string): void { console.log(`⚠️ ${msg}`); }
  error(msg: string): void { console.log(`❌ ${msg}`); }
}

class ExecutionEngine {
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

  async processEntry(tokenId: string, marketData: TokenMarketData, balance: number, skipBiasCheck = false): Promise<ExecutionResult> {
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
    } else if (this.config.copyAnyWhaleBuy && bias.tradeCount >= 1 && !bias.isStale) {
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

    // Look up the opposite token ID for hedging BEFORE opening position
    // This is crucial for proper hedging - we need to know what to buy if we need to hedge
    let oppositeTokenId: string | null = null;
    try {
      oppositeTokenId = await getOppositeTokenId(tokenId);
      if (oppositeTokenId) {
        console.log(`🔍 [HEDGE] Found opposite token for hedging: ${oppositeTokenId.slice(0, 16)}...`);
      } else {
        console.warn(`⚠️ [HEDGE] Could not find opposite token for ${tokenId.slice(0, 16)}... - hedging will be disabled`);
      }
    } catch (err) {
      console.warn(`⚠️ [HEDGE] Error looking up opposite token: ${err instanceof Error ? err.message : err}`);
    }

    // Simulation mode
    if (!this.config.liveTradingEnabled) {
      const position = this.positionManager.openPosition({
        tokenId, marketId, side,
        entryPriceCents: priceCents,
        sizeUsd,
        referencePriceCents,
        evSnapshot: evMetrics,
        biasDirection,
      });
      // Store opposite token for hedging
      if (oppositeTokenId) {
        this.positionManager.setOppositeToken(position.id, oppositeTokenId);
      }
      console.log(`🎲 [SIM] ${side} $${sizeUsd.toFixed(2)} @ ${priceCents.toFixed(1)}¢`);
      return { success: true, filledUsd: sizeUsd, filledPriceCents: priceCents };
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
        console.error(`🚨 TRADING BLOCKED - Network unsafe: ${tradingSafety.reason}`);
        console.error(`   Trade NOT executed to protect your funds. Waiting for network to stabilize...`);
        reportError(
          "Trading Blocked - Network Unsafe",
          `Trade blocked due to unsafe network conditions: ${tradingSafety.reason}`,
          "warning",
          { tokenId, side, sizeUsd, reason: tradingSafety.reason }
        );
        return { success: false, reason: `NETWORK_UNSAFE: ${tradingSafety.reason}` };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // LATENCY-AWARE SLIPPAGE - Critical for high-volume markets!
      // ═══════════════════════════════════════════════════════════════════════
      const networkHealth = latencyMonitor.getNetworkHealth();
      const dynamicSlippagePct = networkHealth.recommendedSlippagePct;
      
      // Warn if network is degraded - higher chance of missed fills or bad slippage
      if (networkHealth.status === "critical") {
        console.warn(`🔴 CRITICAL LATENCY: ${networkHealth.rpcLatencyMs.toFixed(0)}ms RPC, ${networkHealth.apiLatencyMs.toFixed(0)}ms API`);
        console.warn(`   Using ${dynamicSlippagePct.toFixed(1)}% slippage buffer - HIGH RISK of slippage loss!`);
        reportError(
          "Critical Network Latency",
          `Attempting trade with critical latency: RPC ${networkHealth.rpcLatencyMs.toFixed(0)}ms, API ${networkHealth.apiLatencyMs.toFixed(0)}ms`,
          "warning",
          { rpcLatencyMs: networkHealth.rpcLatencyMs, apiLatencyMs: networkHealth.apiLatencyMs, slippagePct: dynamicSlippagePct }
        );
      } else if (networkHealth.status === "degraded") {
        console.warn(`🟡 High latency: ${networkHealth.rpcLatencyMs.toFixed(0)}ms RPC - using ${dynamicSlippagePct.toFixed(1)}% slippage`);
      }

      const orderBook = await this.client.getOrderBook(tokenId);
      const levels = side === "LONG" ? orderBook?.asks : orderBook?.bids;
      if (!levels?.length) return { success: false, reason: "NO_LIQUIDITY" };

      const bestPrice = parseFloat(levels[0].price);
      
      // Apply latency-adjusted slippage buffer to price
      // For BUY: We're willing to pay MORE (price + slippage) to ensure fill
      // For SELL: We're willing to accept LESS (price - slippage) to ensure fill
      const slippageMultiplier = dynamicSlippagePct / 100;
      const fokPrice = side === "LONG" 
        ? bestPrice * (1 + slippageMultiplier)  // BUY: pay up to X% more
        : bestPrice * (1 - slippageMultiplier); // SELL: accept X% less
      
      const shares = sizeUsd / bestPrice; // Use best price for share calculation

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
        console.warn(`⏱️ Slow order execution: ${execLatencyMs.toFixed(0)}ms - consider the slippage impact`);
      }

      if (fokResponse.success) {
        const position = this.positionManager.openPosition({
          tokenId, marketId, side,
          entryPriceCents: bestPrice * 100,
          sizeUsd,
          referencePriceCents,
          evSnapshot: evMetrics,
          biasDirection,
        });
        if (oppositeTokenId) {
          this.positionManager.setOppositeToken(position.id, oppositeTokenId);
        }
        console.log(`📥 FOK ${side} $${sizeUsd.toFixed(2)} @ ${(bestPrice * 100).toFixed(1)}¢ (slippage: ${dynamicSlippagePct.toFixed(1)}%, exec: ${execLatencyMs.toFixed(0)}ms)`);
        return { success: true, filledUsd: sizeUsd, filledPriceCents: bestPrice * 100 };
      }

      // STEP 2: FOK failed - try GTC (limit order) as fallback
      // Use a tighter price for GTC - we're willing to wait for a better fill
      console.log(`⏳ FOK missed, trying GTC limit order...`);
      
      const gtcPrice = side === "LONG"
        ? bestPrice * (1 + slippageMultiplier * 0.5)  // Tighter slippage for GTC
        : bestPrice * (1 - slippageMultiplier * 0.5);
      
      try {
        const gtcOrder = await this.client.createOrder({
          side: side === "LONG" ? Side.BUY : Side.SELL,
          tokenID: tokenId,
          size: shares,
          price: gtcPrice,
        });

        const gtcResponse = await this.client.postOrder(gtcOrder, OrderType.GTC);
        
        if (gtcResponse.success) {
          // GTC order posted - it will sit on the book until filled
          console.log(`📋 GTC order posted @ ${(gtcPrice * 100).toFixed(1)}¢ - waiting for fill...`);
          
          // Note: For GTC, we don't immediately open a position
          // The position will be tracked when the order fills (via on-chain monitor)
          // For now, return success but note it's pending
          return { success: true, filledUsd: 0, filledPriceCents: gtcPrice * 100, pending: true };
        }
      } catch (gtcErr) {
        console.warn(`⚠️ GTC fallback also failed: ${gtcErr instanceof Error ? gtcErr.message : gtcErr}`);
      }

      // Both FOK and GTC failed
      reportError(
        "Order Rejected (FOK + GTC)",
        `Both FOK and GTC orders rejected for ${tokenId.slice(0, 16)}...`,
        "warning",
        { tokenId, side, sizeUsd, priceCents: bestPrice * 100, marketId, slippagePct: dynamicSlippagePct, execLatencyMs }
      );
      return { success: false, reason: "ORDER_REJECTED" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "ERROR";
      // Report execution error to GitHub
      reportError(
        "Entry Execution Failed",
        errorMsg,
        "error",
        { tokenId, side, sizeUsd, marketId }
      );
      return { success: false, reason: errorMsg };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // EXIT (uses smart-sell for reliable fills)
  // ─────────────────────────────────────────────────────────────────────────

  async processExits(marketDataMap: Map<string, TokenMarketData>): Promise<{ exited: string[]; hedged: string[] }> {
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
      const update = this.positionManager.updatePrice(position.id, priceCents, evMetrics, bias.direction);

      if (update.action === "EXIT") {
        pendingActions.push({ position, action: "EXIT", reason: update.reason, priceCents, biasDirection: bias.direction, marketData });
      } else if (update.action === "HEDGE") {
        pendingActions.push({ position, action: "HEDGE", priceCents, biasDirection: bias.direction, marketData });
      } else {
        // Check decision engine for other exit conditions
        const exitCheck = this.decisionEngine.evaluateExit({
          position,
          currentPriceCents: priceCents,
          bias: bias.direction,
          evAllowed: this.evTracker.isTradingAllowed(),
        });
        if (exitCheck.shouldExit) {
          pendingActions.push({ position, action: "EXIT", reason: exitCheck.reason, priceCents, biasDirection: bias.direction, marketData });
        }
      }
    }

    // Second pass: execute all actions in parallel
    if (pendingActions.length > 0) {
      const results = await Promise.all(
        pendingActions.map(async (action) => {
          try {
            if (action.action === "EXIT") {
              const result = await this.executeExit(action.position, action.reason!, action.priceCents, action.biasDirection);
              return { id: action.position.id, action: "EXIT" as const, success: result.success };
            } else {
              // Pass the proactively-monitored opposite orderbook to executeHedge
              const result = await this.executeHedge(
                action.position, 
                action.biasDirection,
                action.marketData.oppositeOrderbook, // Use pre-fetched opposite data!
              );
              return { id: action.position.id, action: "HEDGE" as const, success: result.success };
            }
          } catch (err) {
            console.warn(`⚠️ ${action.action} failed for ${action.position.id}: ${err instanceof Error ? err.message : err}`);
            return { id: action.position.id, action: action.action, success: false };
          }
        })
      );

      // Collect results
      for (const result of results) {
        if (result.success) {
          if (result.action === "EXIT") exited.push(result.id);
          else hedged.push(result.id);
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
      console.warn(`⚠️ [HEDGE] No opposite token available for position ${position.id.slice(0, 16)}... - cannot hedge`);
      return { success: false, reason: "NO_OPPOSITE_TOKEN" };
    }

    // Simulation mode - just record the hedge
    if (!this.config.liveTradingEnabled) {
      // Use pre-fetched price if available, otherwise use position's current price as estimate
      const hedgePrice = prefetchedOppositeOrderbook?.bestAskCents 
        ? prefetchedOppositeOrderbook.bestAskCents 
        : position.currentPriceCents;
      
      this.positionManager.recordHedge(position.id, {
        tokenId: oppositeTokenId, // Use REAL opposite token ID!
        sizeUsd: hedgeSize,
        entryPriceCents: hedgePrice,
        entryTime: Date.now(),
      }, evMetrics, biasDirection);

      const proactiveTag = prefetchedOppositeOrderbook ? " [PROACTIVE]" : "";
      console.log(`🛡️ [SIM]${proactiveTag} Hedged $${hedgeSize.toFixed(2)} by buying opposite @ ${hedgePrice.toFixed(1)}¢`);
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
      const hasPrefetchedData = prefetchedOppositeOrderbook && 
        prefetchedOppositeOrderbook.bestAskCents > 0 &&
        prefetchedOppositeOrderbook.askDepthUsd >= MIN_LIQUIDITY_USD;
      
      if (hasPrefetchedData) {
        price = prefetchedOppositeOrderbook!.bestAskCents / 100; // Convert cents to dollars
        console.log(`🔄 [HEDGE] Using proactively monitored opposite price: ${(price * 100).toFixed(1)}¢ (depth: $${prefetchedOppositeOrderbook!.askDepthUsd.toFixed(0)})`);
      } else {
        // Fallback: fetch fresh orderbook (no pre-fetched data or insufficient liquidity)
        const reason = prefetchedOppositeOrderbook 
          ? `insufficient liquidity ($${prefetchedOppositeOrderbook.askDepthUsd?.toFixed(0) || 0})`
          : "no pre-fetched data";
        console.log(`📡 [HEDGE] Fetching fresh opposite orderbook (${reason})`);
        const orderBook = await this.client.getOrderBook(oppositeTokenId);
        const asks = orderBook?.asks;
        
        if (!asks?.length) {
          console.warn(`⚠️ [HEDGE] No asks available for opposite token - cannot hedge`);
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
        console.warn(`⚠️ [HEDGE] Calculated shares ${shares} is below minimum ${MIN_SHARES}`);
        return { success: false, reason: "SIZE_TOO_SMALL" };
      }

      console.log(`🛡️ [HEDGE] Placing hedge order: BUY ${shares.toFixed(4)} shares @ ${(price * 100).toFixed(1)}¢`);

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
        
        this.positionManager.recordHedge(position.id, {
          tokenId: oppositeTokenId,
          sizeUsd: hedgeSize,
          entryPriceCents: fillPriceCents,
          entryTime: Date.now(),
        }, evMetrics, biasDirection);

        console.log(`✅ [HEDGE] Successfully hedged $${hedgeSize.toFixed(2)} @ ${fillPriceCents.toFixed(1)}¢`);
        return { success: true, filledUsd: hedgeSize, filledPriceCents: fillPriceCents };
      } else {
        console.warn(`⚠️ [HEDGE] Hedge order rejected: ${response.errorMsg || "unknown reason"}`);
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
  private mempoolMonitor: MempoolMonitor | null = null;
  private marketScanner: MarketScanner;
  private dynamicReserveManager: DynamicReserveManager;
  private latencyMonitor: LatencyMonitor;

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
  
  // Pending whale signals from mempool - for fast copy trading
  private pendingWhaleSignals: Map<string, PendingTradeSignal> = new Map();
  private readonly PENDING_SIGNAL_EXPIRY_MS = 30 * 1000; // 30 seconds

  // Intervals
  private readonly REDEEM_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  private readonly SUMMARY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  constructor() {
    this.config = loadConfig();
    this.logger = new SimpleLogger();

    this.evTracker = new EvTracker(this.config);
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
    this.decisionEngine = new DecisionEngine(this.config);
    this.executionEngine = new ExecutionEngine(
      this.config,
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
      const explicitlyDisabled = process.env.GITHUB_ERROR_REPORTER_ENABLED === "false";
      
      if (explicitlyDisabled) {
        console.log("📋 GitHub error reporting disabled (GITHUB_ERROR_REPORTER_ENABLED=false)");
      } else if (hasToken && !hasRepo) {
        console.log("📋 GitHub error reporting disabled - GITHUB_ERROR_REPORTER_REPO not set");
        console.log("   ↳ Set GITHUB_ERROR_REPORTER_REPO=owner/repo-name to enable");
      } else if (!hasToken && hasRepo) {
        console.log("📋 GitHub error reporting disabled - GITHUB_ERROR_REPORTER_TOKEN not set");
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
    console.log(`${this.config.liveTradingEnabled ? "🟢" : "🔴"} Mode: ${this.config.liveTradingEnabled ? "LIVE TRADING" : "SIMULATION"}`);
    console.log("");

    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDATION MODE - Force sell positions based on mode
    // ═══════════════════════════════════════════════════════════════════════
    // LIQUIDATION_MODE=losing - Only sell positions with negative P&L
    // LIQUIDATION_MODE=all - Sell all positions regardless of P&L
    // FORCE_LIQUIDATION=true (legacy) - Same as LIQUIDATION_MODE=all
    if (this.config.liquidationMode !== "off" && existingPositions.length > 0) {
      // Filter positions based on liquidation mode
      const positionsToLiquidate = this.config.liquidationMode === "losing"
        ? existingPositions.filter(p => p.pnlPct < 0)
        : existingPositions;
      
      const liquidateValue = positionsToLiquidate.reduce((sum, p) => sum + p.value, 0);
      const modeDesc = this.config.liquidationMode === "losing" ? "LOSING ONLY" : "ALL";
      
      if (positionsToLiquidate.length > 0) {
        console.log("━".repeat(60));
        console.log(`🔥 LIQUIDATION MODE ACTIVATED (${modeDesc})`);
        console.log("━".repeat(60));
        console.log(`   Mode: ${this.config.liquidationMode === "losing" ? "Selling losing positions only" : "Selling ALL positions"}`);
        console.log(`   Current balance: $${usdcBalance.toFixed(2)}`);
        console.log(`   Total positions: ${existingPositions.length} (worth $${positionValue.toFixed(2)})`);
        console.log(`   To liquidate: ${positionsToLiquidate.length} (worth $${liquidateValue.toFixed(2)})`);
        console.log("━".repeat(60));
        console.log("");

        this.liquidationMode = true;

        if (this.config.telegramBotToken) {
          await sendTelegram(
            `🔥 Liquidation Mode (${modeDesc})`,
            `Balance: $${usdcBalance.toFixed(2)}\n` +
              `Total positions: ${existingPositions.length} ($${positionValue.toFixed(2)})\n` +
              `To liquidate: ${positionsToLiquidate.length} ($${liquidateValue.toFixed(2)})`,
          ).catch(() => {});
        }

        return true;
      } else {
        console.log(`ℹ️ Liquidation mode (${modeDesc}) enabled but no matching positions to sell`);
      }
    }

    // If no effective bankroll and positions exist, suggest enabling liquidation
    if (effectiveBankroll <= 0) {
      if (existingPositions.length > 0) {
        console.error("❌ No effective bankroll available");
        console.error(`   You have ${existingPositions.length} positions worth $${positionValue.toFixed(2)}`);
        console.error(`   Set LIQUIDATION_MODE=all to sell all, or LIQUIDATION_MODE=losing to sell only losing positions`);
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
        console.warn(`⚠️ On-chain monitor background init failed: ${err instanceof Error ? err.message : err}`);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // MEMPOOL MONITORING - See PENDING trades BEFORE they confirm!
    // Runs independently of on-chain monitor - can use either or both
    // ═══════════════════════════════════════════════════════════════════════
    if (this.config.mempoolMonitorEnabled) {
      // Fire and forget - don't await, let it run in parallel
      this.initializeMempoolMonitor().catch((err) => {
        console.warn(`⚠️ Mempool monitor background init failed: ${err instanceof Error ? err.message : err}`);
      });
    }

    // Send startup notification
    if (this.config.telegramBotToken) {
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
   * Initialize on-chain monitor for real-time whale detection AND position monitoring
   * Connects to CTF Exchange contract via Infura WebSocket
   * 
   * RUNS IN PARALLEL - WebSocket events fire independently of main loop
   * This gives us blockchain-speed detection while API polling continues
   * 
   * DATA PRIORITY: On-chain signals are FASTER than API and take precedence!
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
        }
      );

      this.onchainMonitor = new OnChainMonitor(monitorConfig);

      // ═══════════════════════════════════════════════════════════════════════
      // WHALE TRADE CALLBACK - On-chain signals take PRIORITY over API!
      // Deduplication is handled by BiasAccumulator.addTrades()
      // ═══════════════════════════════════════════════════════════════════════
      this.onchainMonitor.onWhaleTrade((trade) => {
        // Log ALL whale trades for visibility
        console.log(`🐋 Whale ${trade.side} detected | $${trade.sizeUsd.toFixed(0)} @ ${(trade.price * 100).toFixed(1)}¢ | Block #${trade.blockNumber}`);
        
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

          // Feed to bias accumulator - this is the speed advantage!
          // On-chain signals arrive BEFORE Polymarket API reports them
          // Deduplication prevents double-counting with API data
          this.biasAccumulator.recordTrade({
            tokenId: trade.tokenId,
            wallet: whaleWallet,
            side: "BUY",
            sizeUsd: trade.sizeUsd,
            timestamp: trade.timestamp,
          });
          
          console.log(`⚡ On-chain → Bias | Block #${trade.blockNumber} | $${trade.sizeUsd.toFixed(0)} BUY | PRIORITY SIGNAL`);
          
          // In COPY_ANY_WHALE_BUY mode, log that we should copy this
          if (this.config.copyAnyWhaleBuy) {
            console.log(`   🎯 COPY_ANY_WHALE_BUY: Signal ready to copy!`);
          }
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
          console.log(`⚡ Position FILLED | +${change.amountFormatted.toFixed(2)} tokens | Block #${change.blockNumber}`);
          
          // Invalidate position cache to force refresh
          invalidatePositions();
        } else {
          // We sent tokens - we sold or transferred
          console.log(`⚡ Position SOLD | -${change.amountFormatted.toFixed(2)} tokens | Block #${change.blockNumber}`);
          
          // Invalidate position cache
          invalidatePositions();
        }
      });

      // Start the monitor - WebSocket runs in background, events fire in parallel
      const started = await this.onchainMonitor.start();
      if (started) {
        const stats = this.onchainMonitor.getStats();
        console.log(`📡 On-chain monitor: Infura ${stats.infuraTier} tier | ${stats.trackedWallets} whales | Position monitoring: ${stats.monitoringOwnPositions ? 'ON' : 'OFF'}`);
        console.log(`📡 Data priority: ON-CHAIN > API (blockchain-speed edge)`);
      }
    } catch (err) {
      console.warn(`⚠️ On-chain monitor init failed: ${err instanceof Error ? err.message : err}`);
      console.warn(`   Falling back to API polling only (still works, just slower)`);
    }
  }

  /**
   * Initialize mempool monitor for PENDING trade detection
   * This is FASTER than on-chain events - sees trades BEFORE they confirm!
   * 
   * NOTE: Runs independently of on-chain monitor - you can use either or both
   */
  private async initializeMempoolMonitor(): Promise<void> {
    if (!this.config.mempoolMonitorEnabled) {
      return;
    }

    try {
      // Detect WebSocket URL from RPC URL
      let wsUrl = this.config.rpcUrl;
      if (wsUrl.startsWith("https://")) {
        wsUrl = wsUrl.replace("https://", "wss://").replace("/v3/", "/ws/v3/");
      }

      const mempoolConfig = createMempoolMonitorConfig(
        wsUrl,
        this.biasAccumulator.getWhaleWallets(),
        {
          enabled: true,
          minTradeSizeUsd: this.config.onchainMinWhaleTradeUsd,
          gasPriceMultiplier: this.config.mempoolGasPriceMultiplier,
        }
      );

      this.mempoolMonitor = new MempoolMonitor(mempoolConfig);

      // ═══════════════════════════════════════════════════════════════════
      // PENDING BUY → COPY IMMEDIATELY (faster than on-chain!)
      // ═══════════════════════════════════════════════════════════════════
      this.mempoolMonitor.onPendingTrade((signal) => {
        if (signal.side === "BUY") {
          console.log(`🔮 MEMPOOL: Whale BUY pending | $${signal.estimatedSizeUsd.toFixed(0)} | Token: ${signal.tokenId.slice(0, 12)}...`);
          console.log(`   ⚡ COPY SIGNAL - Execute with gas > ${(signal.gasPriceGwei * this.config.mempoolGasPriceMultiplier).toFixed(1)} gwei`);
          
          // Store the pending signal for the next cycle to act on
          this.pendingWhaleSignals.set(signal.tokenId, signal);
          
          // Feed to bias accumulator immediately
          this.biasAccumulator.recordTrade({
            tokenId: signal.tokenId,
            wallet: signal.whaleWallet,
            side: "BUY",
            sizeUsd: signal.estimatedSizeUsd,
            timestamp: signal.detectedAt,
          });
        }

        // ═══════════════════════════════════════════════════════════════════
        // PENDING SELL → EARLY EXIT WARNING (get out before price drops!)
        // ═══════════════════════════════════════════════════════════════════
        if (signal.side === "SELL") {
          // Check if we hold this token
          const ourPositions = this.positionManager.getPositionsByToken(signal.tokenId);
          if (ourPositions.length > 0) {
            console.log(`🚨 MEMPOOL: Whale SELLING our token! | $${signal.estimatedSizeUsd.toFixed(0)}`);
            console.log(`   ⚠️ EARLY EXIT SIGNAL - Consider selling before price drops!`);
            
            // Mark positions for urgent exit
            for (const pos of ourPositions) {
              console.log(`   📍 Position ${pos.id.slice(0, 8)}... | Entry: ${pos.entryPriceCents.toFixed(1)}¢ | Size: $${pos.entrySizeUsd.toFixed(2)}`);
              // The next cycle will see this and can prioritize exit
            }
          }
        }
      });

      const started = await this.mempoolMonitor.start();
      if (started) {
        console.log(`🔮 Mempool monitor: ACTIVE | Watching for PENDING whale trades`);
        console.log(`🔮 Speed advantage: See trades BEFORE confirmation → copy at same price!`);
      }
    } catch (err) {
      console.warn(`⚠️ Mempool monitor init failed: ${err instanceof Error ? err.message : err}`);
      console.warn(`   Note: Not all RPC providers support pending tx subscription`);
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
      // In liquidation mode, use configurable slower interval to avoid rate limits
      const openCount = this.positionManager.getOpenPositions().length;
      const pollInterval = this.liquidationMode
        ? this.config.liquidationPollIntervalMs
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
    // 2. GET BALANCES
    // ─────────────────────────────────────────────────────────────────
    const usdcBalance = await getUsdcBalance(this.wallet, this.address);
    const { reserveUsd } = this.executionEngine.getEffectiveBankroll(usdcBalance);

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
      // ─────────────────────────────────────────────────────────────────
      // LIQUIDATION COMPLETE - Transition back to normal trading
      // ─────────────────────────────────────────────────────────────────
      const { effectiveBankroll } = this.dynamicReserveManager.getEffectiveBankroll(usdcBalance);
      
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

        if (this.config.telegramBotToken) {
          await sendTelegram(
            "✅ Liquidation Complete",
            `All positions sold!\nBalance: $${usdcBalance.toFixed(2)}\nResuming normal trading...`,
          ).catch(() => {});
        }

        return; // Next cycle will be normal trading
      } else {
        console.log("📦 No positions to liquidate");
        console.log(`   Balance: $${usdcBalance.toFixed(2)} (need $${reserveUsd.toFixed(2)} for trading)`);
        console.log(`   Waiting for deposits or position settlements...`);
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // FILTER POSITIONS BASED ON LIQUIDATION MODE
    // ─────────────────────────────────────────────────────────────────
    // "losing" mode: Only liquidate positions with negative P&L
    // "all" mode: Liquidate all positions
    const modeFilteredPositions = this.config.liquidationMode === "losing"
      ? positions.filter(p => p.pnlPct < 0)
      : positions;

    if (modeFilteredPositions.length === 0 && this.config.liquidationMode === "losing") {
      // All remaining positions are winners - exit liquidation mode
      const { effectiveBankroll } = this.dynamicReserveManager.getEffectiveBankroll(usdcBalance);
      
      console.log("");
      console.log("━".repeat(60));
      console.log("✅ LIQUIDATION COMPLETE (losers only) - Resuming normal trading");
      console.log("━".repeat(60));
      console.log(`   All losing positions sold!`);
      console.log(`   Remaining winners: ${positions.length} (will be managed normally)`);
      console.log(`   Balance: $${usdcBalance.toFixed(2)}`);
      console.log(`   Effective bankroll: $${effectiveBankroll.toFixed(2)}`);
      console.log("━".repeat(60));
      console.log("");

      // Reset liquidation mode
      this.liquidationMode = false;
      this.recentlySoldPositions.clear();
      this.dynamicReserveManager.reset();

      if (this.config.telegramBotToken) {
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
    const eligiblePositions = modeFilteredPositions.filter(p => {
      const soldTime = this.recentlySoldPositions.get(p.tokenId);
      if (soldTime && now - soldTime < this.SOLD_POSITION_COOLDOWN_MS) {
        return false; // Skip - recently sold, waiting for API to reflect
      }
      return true;
    });

    // Sort by value descending - sell largest positions first for fastest capital recovery
    const sortedPositions = [...eligiblePositions].sort((a, b) => b.value - a.value);

    if (sortedPositions.length === 0) {
      const cooldownCount = modeFilteredPositions.length - eligiblePositions.length;
      console.log(`⏳ Waiting for ${cooldownCount} recent sell(s) to settle...`);
      return;
    }

    const modeLabel = this.config.liquidationMode === "losing" ? " (losing)" : "";
    console.log(`🔥 Liquidating ${sortedPositions.length} positions${modeLabel} (total value: $${sortedPositions.reduce((s, p) => s + p.value, 0).toFixed(2)})`);

    // Sell one position per cycle to avoid overwhelming the API
    const positionToSell = sortedPositions[0];
    if (positionToSell) {
      console.log(`📤 Selling: $${positionToSell.value.toFixed(2)} @ ${(positionToSell.curPrice * 100).toFixed(1)}¢ (P&L: ${positionToSell.pnlPct >= 0 ? '+' : ''}${positionToSell.pnlPct.toFixed(1)}%)`);

      if (!this.config.liveTradingEnabled) {
        console.log(`   [SIM] Would sell ${positionToSell.size.toFixed(2)} shares`);
      } else if (!this.client) {
        console.warn(`   ⚠️ No client available for selling`);
      } else {
        try {
          const result = await smartSell(this.client, positionToSell, {
            maxSlippagePct: this.config.liquidationMaxSlippagePct,
            forceSell: true,     // Force sell even if conditions aren't ideal
            logger: this.logger,
          });

          if (result.success) {
            console.log(`   ✅ Sold for $${result.filledUsd?.toFixed(2) || 'unknown'}`);

            // Track this position as recently sold to prevent re-selling
            // while waiting for position API to reflect the change
            this.recentlySoldPositions.set(positionToSell.tokenId, now);

            // Invalidate position cache to ensure fresh data on next fetch
            invalidatePositions();

            if (this.config.telegramBotToken) {
              await sendTelegram(
                "🔥 Position Liquidated",
                `Sold: $${result.filledUsd?.toFixed(2) || positionToSell.value.toFixed(2)}\n` +
                  `P&L: ${positionToSell.pnlPct >= 0 ? '+' : ''}${positionToSell.pnlPct.toFixed(1)}%`,
              ).catch(() => {});
            }
          } else {
            // If sell failed due to balance issue, the position might already be sold
            // (API cache delay). Add to cooldown to prevent spamming the same position.
            // This also helps avoid rate limiting when there's a genuine issue.
            if (result.reason === "INSUFFICIENT_BALANCE" || result.reason === "INSUFFICIENT_ALLOWANCE") {
              console.log(`   ⏳ Adding to cooldown (likely already sold, waiting for API update)`);
              this.recentlySoldPositions.set(positionToSell.tokenId, now);
            }
            console.log(`   ❌ Sell failed: ${result.reason}`);
          }
        } catch (err) {
          console.warn(`   ⚠️ Sell error: ${err instanceof Error ? err.message : err}`);
        }
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
   * 4. Scan active markets for opportunities
   * 5. Enter if bias allows OR scanned opportunity available
   * 6. Periodic housekeeping
   */
  private async cycle(): Promise<void> {
    this.cycleCount++;
    const now = Date.now();

    // ─────────────────────────────────────────────────────────────────
    // 1. GET BALANCES (parallel fetch)
    // ─────────────────────────────────────────────────────────────────
    const [usdcBalance, polBalance] = await Promise.all([
      getUsdcBalance(this.wallet, this.address),
      getPolBalance(this.wallet, this.address),
    ]);
    
    // Use dynamic reserves for effective bankroll calculation
    const { effectiveBankroll } = this.dynamicReserveManager.getEffectiveBankroll(usdcBalance);

    if (effectiveBankroll <= 0) {
      // No effective bankroll available this cycle; skip trading logic
      return; // No money to trade
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. MONITOR ALL POSITIONS - Apply math to ALL positions, not just bot-opened ones
    // ─────────────────────────────────────────────────────────────────
    // This includes positions from before the bot started, manual trades, etc.
    // The bot will apply TP, stop loss, hedging, and time stops to everything.
    
    // First, sync any on-chain positions not yet tracked by the position manager
    // Only sync every 10 cycles to reduce API load
    let allPositions: Position[] = [];
    if (this.cycleCount % 10 === 0) {
      try {
        allPositions = await getPositions(this.address, true);
        
        // Register any untracked positions with the position manager
        // so they get the same exit logic applied
        for (const pos of allPositions) {
          const existingPositions = this.positionManager.getPositionsByToken(pos.tokenId);
          if (existingPositions.length === 0) {
            // This is an external position - register it for monitoring (async)
            await this.positionManager.registerExternalPosition(pos);
          }
        }
      } catch {
        // Continue with managed positions only if fetch fails
      }
    }
    
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
    // 4. SCAN ACTIVE MARKETS FOR OPPORTUNITIES
    // ─────────────────────────────────────────────────────────────────
    let scannedOpportunities: string[] = [];
    if (this.config.scanActiveMarkets) {
      const scanInterval = this.config.scanIntervalSeconds * 1000;
      if (now - this.lastScanTime >= scanInterval) {
        await this.marketScanner.scanActiveMarkets();
        this.lastScanTime = now;
      }
      scannedOpportunities = this.marketScanner.getActiveTokenIds();
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. ENTER IF BIAS ALLOWS OR SCANNED OPPORTUNITY AVAILABLE
    // ─────────────────────────────────────────────────────────────────
    const evAllowed = this.evTracker.isTradingAllowed();
    const activeBiases = this.biasAccumulator.getActiveBiases();
    
    if (evAllowed.allowed) {
      if (activeBiases.length > 0) {
        // Execute whale-signal entries in parallel to avoid missing opportunities
        // when multiple whale signals arrive simultaneously.
        // 
        // RACE CONDITION SAFEGUARD: The position manager enforces:
        // - maxOpenPositionsTotal (12) - hard limit on concurrent positions
        // - maxDeployedFractionTotal (30%) - max exposure cap
        // - maxOpenPositionsPerMarket (2) - per-token limit
        // These checks happen atomically in processEntry, preventing over-allocation.
        const entryPromises = activeBiases.slice(0, 3).map(async (bias) => {
          try {
            const marketData = await this.fetchTokenMarketData(bias.tokenId);
            if (marketData) {
              const result = await this.executionEngine.processEntry(bias.tokenId, marketData, usdcBalance);
              // Track missed opportunities - check for actual reason strings from processEntry
              if (!result.success && (result.reason === "NO_BANKROLL" || result.reason?.startsWith("Max deployed") || result.reason === "No effective bankroll")) {
                this.dynamicReserveManager.recordMissedOpportunity(bias.tokenId, this.config.maxTradeUsd, "RESERVE_BLOCKED");
              }
              return result;
            }
          } catch (err) {
            console.warn(`⚠️ Entry failed for ${bias.tokenId.slice(0, 8)}...: ${err instanceof Error ? err.message : err}`);
          }
          return null;
        });
        
        await Promise.all(entryPromises);
      } else if (scannedOpportunities.length > 0 && this.config.scanActiveMarkets) {
        // No whale signals - scan for trades from active markets
        // Only log occasionally to avoid spam
        if (this.cycleCount % 50 === 0) {
          console.log(`🔍 No active whale signals - scanning ${scannedOpportunities.length} active markets for opportunities...`);
        }
        
        // Try top scanned markets (limit to avoid rate limiting)
        const scannedEntryPromises = scannedOpportunities.slice(0, 2).map(async (tokenId) => {
          try {
            // Check if we already have a position in this market
            const existingPositions = this.positionManager.getPositionsByToken(tokenId);
            if (existingPositions.length > 0) return null;

            const marketData = await this.fetchTokenMarketData(tokenId);
            if (marketData) {
              // For scanned markets, bypass bias check since these are high-volume
              // markets selected by the scanner based on activity metrics
              const result = await this.executionEngine.processEntry(tokenId, marketData, usdcBalance, true);
              // Track missed opportunities - check for actual reason strings from processEntry
              if (!result.success && (result.reason === "NO_BANKROLL" || result.reason?.startsWith("Max deployed") || result.reason === "No effective bankroll")) {
                this.dynamicReserveManager.recordMissedOpportunity(tokenId, this.config.maxTradeUsd, "RESERVE_BLOCKED");
              }
              return result;
            }
          } catch {
            // Silently skip failed scanned entries
          }
          return null;
        });
        
        await Promise.all(scannedEntryPromises);
      } else if (this.cycleCount % 100 === 0) {
        // No opportunities at all - keep churning message
        console.log(`🔄 No active signals - keeping the churn going, waiting for opportunities...`);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // 6. PERIODIC HOUSEKEEPING
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
  private async logStatus(usdcBalance: number, effectiveBankroll: number, polBalance: number): Promise<void> {
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
    const positionDisplay = actualPositions.length > 0 
      ? `${actualPositions.length} (${managedPositions.length} managed)`
      : `${managedPositions.length}`;
    
    // Get active biases count for diagnostic
    const activeBiases = this.biasAccumulator.getActiveBiases();
    
    // Get dynamic reserve state
    const reserveState = this.dynamicReserveManager.getState();
    const reservePct = (reserveState.adaptedReserveFraction * 100).toFixed(0);
    
    // Get scanned markets count
    const scannedMarkets = this.config.scanActiveMarkets ? this.marketScanner.getActiveMarketCount() : 0;
    
    console.log("");
    console.log(`📊 STATUS | ${new Date().toLocaleTimeString()}`);
    console.log(`   💰 Balance: $${usdcBalance.toFixed(2)} | Bankroll: $${effectiveBankroll.toFixed(2)} | ⛽ POL: ${polBalance.toFixed(1)}${polWarning}`);
    console.log(`   📈 Positions: ${positionDisplay} | Trades: ${metrics.totalTrades} | 🐋 Following: ${trackedWallets}`);
    console.log(`   🎯 Win: ${winPct}% | EV: ${evSign}${metrics.evCents.toFixed(1)}¢ | P&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`);
    
    // Show whale copy mode status
    if (this.config.copyAnyWhaleBuy) {
      console.log(`   ⚡ Mode: INSTANT COPY (copy any whale buy ≥ $${this.config.onchainMinWhaleTradeUsd})`);
    } else {
      console.log(`   🐢 Mode: CONFIRMED (need $${this.config.biasMinNetUsd} flow + ${this.config.biasMinTrades} trades)`);
    }
    
    // Show active signals and scanning status
    if (activeBiases.length > 0) {
      console.log(`   📡 Active whale signals: ${activeBiases.length} | Live trading: ${this.config.liveTradingEnabled ? 'ON' : 'OFF (simulation)'}`);
    } else if (scannedMarkets > 0) {
      console.log(`   🔍 No whale signals - scanning ${scannedMarkets} active markets | Live trading: ${this.config.liveTradingEnabled ? 'ON' : 'OFF (simulation)'}`);
    } else {
      console.log(`   ⏳ Waiting for signals... | Live trading: ${this.config.liveTradingEnabled ? 'ON' : 'OFF (simulation)'}`);
    }
    
    // Show dynamic reserves status if enabled
    if (this.config.dynamicReservesEnabled) {
      const missedInfo = reserveState.missedCount > 0 ? ` | Missed: ${reserveState.missedCount}` : '';
      console.log(`   🏦 Dynamic Reserve: ${reservePct}% (base: ${(reserveState.baseReserveFraction * 100).toFixed(0)}%)${missedInfo}`);
    }
    
    // Show network health - CRITICAL for understanding slippage risk!
    const networkHealth = this.latencyMonitor.getNetworkHealth();
    const networkEmoji = networkHealth.status === "healthy" ? "🟢" : networkHealth.status === "degraded" ? "🟡" : "🔴";
    console.log(`   ${networkEmoji} Network: ${networkHealth.status.toUpperCase()} | RPC: ${networkHealth.rpcLatencyMs.toFixed(0)}ms | API: ${networkHealth.apiLatencyMs.toFixed(0)}ms | Slippage: ${networkHealth.recommendedSlippagePct.toFixed(1)}%`);
    
    // Warn if network is not healthy
    if (networkHealth.warnings.length > 0 && networkHealth.status !== "healthy") {
      for (const warning of networkHealth.warnings) {
        console.log(`   ⚠️ ${warning}`);
      }
    }
    console.log("");
    
    // Telegram update
    if (this.config.telegramBotToken && metrics.totalTrades > 0) {
      await sendTelegram(
        "📊 Status",
        `Balance: $${usdcBalance.toFixed(2)}\nPOL: ${polBalance.toFixed(1)}${polWarning}\nPositions: ${positionDisplay}\nFollowing: ${trackedWallets} wallets\nWin: ${winPct}%\nP&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`
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
   * 
   * PROACTIVE MONITORING: Fetches BOTH the position's token AND the opposite
   * token's orderbook. This gives us real-time hedge signal data without
   * having to look it up when we need to hedge. Increases API calls proportionally
   * to positions with opposite tokens configured (typically up to 2x if all have opposites).
   */
  private async buildMarketData(positions: any[]): Promise<Map<string, TokenMarketData>> {
    const map = new Map<string, TokenMarketData>();
    
    // Deduplicate tokens to fetch - avoid fetching same token multiple times
    // Key: tokenId, Value: { positions that need this token, isOpposite flag }
    const tokensToFetch = new Map<string, { 
      tokenId: string;
      forPositions: Set<string>; // Position tokenIds that need this orderbook
      isOpposite: boolean;
    }>();
    
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
    
    // Fetch all unique tokens in parallel - API can handle it
    const fetchPromises = Array.from(tokensToFetch.values()).map(async (task) => {
      const orderbook = await this.getOrderbookState(task.tokenId);
      return { ...task, orderbook };
    });
    
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
        // Include opposite token data for proactive hedge monitoring
        oppositeTokenId: pos.oppositeTokenId,
        oppositeOrderbook: oppositeOrderbooks.get(pos.tokenId),
      });
    }

    // Log when we have both tokens monitored
    const withOpposite = Array.from(map.values()).filter(m => m.oppositeOrderbook).length;
    const apiCalls = tokensToFetch.size;
    if (withOpposite > 0) {
      console.log(`🔄 Monitoring ${map.size} positions + ${withOpposite} opposite tokens (${apiCalls} API calls)`);
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

    // Stop latency monitoring
    this.latencyMonitor.stop();

    // Stop on-chain monitor if running
    if (this.onchainMonitor) {
      this.onchainMonitor.stop();
    }

    if (this.config.telegramBotToken) {
      sendTelegram("🛑 Bot Stopped", "Polymarket Bot has been stopped").catch(() => {});
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
