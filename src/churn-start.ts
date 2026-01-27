/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET CASINO BOT - Consolidated Churn Engine
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

  // EV / Casino Controls
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
  forceLiquidation: boolean;  // If true, start liquidating positions even with no effective bankroll
  liquidationMaxSlippagePct: number;  // Max slippage for liquidation sells (default: 10%)
  liquidationPollIntervalMs: number;  // Poll interval in liquidation mode (default: 1000ms)

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
    maxOpenPositionsPerMarket: 2,     // Max per market
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

    // EV / Casino controls - bot stops itself when math says stop
    rollingWindowTrades: 200,         // Sample size for stats
    churnCostCentsEstimate: 2,        // 2¢ churn cost
    minEvCents: 0,                    // Pause if EV < 0
    minProfitFactor: 1.25,            // avg_win/avg_loss >= 1.25
    pauseSeconds: 300,                // 5min pause when table closed

    // Bias (Leaderboard flow) - permission, not prediction
    biasMode: "leaderboard_flow",
    leaderboardTopN: 50,              // Track top 50 wallets
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

    // Liquidation Mode - force sell existing positions when balance is too low
    forceLiquidation: envBool("FORCE_LIQUIDATION", false),
    liquidationMaxSlippagePct: envNum("LIQUIDATION_MAX_SLIPPAGE_PCT", 10),  // 10% default
    liquidationPollIntervalMs: envNum("LIQUIDATION_POLL_INTERVAL_MS", 1000),  // 1s default

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
    polReserveMaxSwapUsd: envNum("POL_RESERVE_MAX_SWAP_USD", 25),  // Max USDC per swap
    polReserveCheckIntervalMin: envNum("POL_RESERVE_CHECK_INTERVAL_MIN", 5),  // Check every 5 min
    polReserveSlippagePct: 3,
  };
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
  log("🎰 POLYMARKET CASINO BOT");
  log("═".repeat(50));
  log("");
  log("💰 YOUR SETTINGS:");
  log(`   Bet size: $${config.maxTradeUsd} per trade`);
  log(`   Live trading: ${config.liveTradingEnabled ? "✅ ENABLED" : "⚠️ SIMULATION"}`);
  log(`   Telegram: ${config.telegramBotToken && config.telegramChatId ? "✅ ENABLED" : "❌ DISABLED"}`);
  if (config.forceLiquidation) {
    log(`   Force liquidation: ⚠️ ENABLED`);
  }
  log("");
  log("📊 THE MATH (fixed, don't change):");
  log(`   Take profit: +${config.tpCents}¢ (avg win)`);
  log(`   Hedge trigger: -${config.hedgeTriggerCents}¢`);
  log(`   Hard stop: -${config.maxAdverseCents}¢`);
  log(`   Avg loss after hedge: ~9¢`);
  log(`   Break-even: 48% win rate`);
  log("");
  log("🐋 WHALE TRACKING:");
  log(`   Following top ${config.leaderboardTopN} wallets`);
  log(`   Min flow: $${config.biasMinNetUsd}`);
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

  // API endpoints
  private readonly GAMMA_API = "https://gamma-api.polymarket.com";
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
   * Fetch top leaderboard wallets
   */
  async refreshLeaderboard(): Promise<string[]> {
    const now = Date.now();
    // Only fetch every 5 minutes
    if (now - this.lastLeaderboardFetch < 5 * 60 * 1000) {
      return Array.from(this.leaderboardWallets);
    }

    try {
      const url = `${this.GAMMA_API}/leaderboard?limit=${this.config.leaderboardTopN}`;
      const { data } = await axios.get(url, { timeout: 10000 });

      if (Array.isArray(data)) {
        this.leaderboardWallets.clear();
        for (const entry of data) {
          if (entry.address) {
            this.leaderboardWallets.add(entry.address.toLowerCase());
          }
        }
        this.lastLeaderboardFetch = now;
      }
    } catch {
      // Keep existing wallets on error
    }

    return Array.from(this.leaderboardWallets);
  }

  /**
   * Fetch recent trades for leaderboard wallets - PARALLEL EXECUTION
   * Fetches all whale wallets simultaneously for maximum speed
   */
  async fetchLeaderboardTrades(): Promise<LeaderboardTrade[]> {
    const wallets = await this.refreshLeaderboard();
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    // Fetch all wallets in parallel for speed
    // API can handle concurrent requests, and we want to catch whale movement FAST
    const fetchPromises = wallets.map(async (wallet) => {
      try {
        const url = `${this.DATA_API}/trades?user=${wallet}&limit=20`;
        const { data } = await axios.get(url, { timeout: 5000 });

        if (!Array.isArray(data)) return [];

        const trades: LeaderboardTrade[] = [];
        for (const trade of data) {
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
            side: trade.side?.toUpperCase() === "SELL" ? "SELL" : "BUY",
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
   */
  private addTrades(trades: LeaderboardTrade[]): void {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;

    for (const trade of trades) {
      const existing = this.trades.get(trade.tokenId) || [];
      existing.push(trade);
      this.trades.set(trade.tokenId, existing);
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
   */
  getBias(tokenId: string): TokenBias {
    const now = Date.now();
    const windowStart = now - this.config.biasWindowSeconds * 1000;
    const staleThreshold = now - this.config.biasStaleSeconds * 1000;

    const tokenTrades = this.trades.get(tokenId) || [];
    const recentTrades = tokenTrades.filter((t) => t.timestamp >= windowStart);

    // Calculate net USD
    let netUsd = 0;
    let lastActivityTime = 0;

    for (const trade of recentTrades) {
      if (trade.side === "BUY") {
        netUsd += trade.sizeUsd;
      } else {
        netUsd -= trade.sizeUsd;
      }
      if (trade.timestamp > lastActivityTime) {
        lastActivityTime = trade.timestamp;
      }
    }

    const tradeCount = recentTrades.length;
    const isStale = lastActivityTime > 0 && lastActivityTime < staleThreshold;

    // Determine direction
    let direction: BiasDirection = "NONE";
    if (!isStale && tradeCount >= this.config.biasMinTrades) {
      if (netUsd >= this.config.biasMinNetUsd) {
        direction = "LONG";
      } else if (netUsd <= -this.config.biasMinNetUsd) {
        direction = "SHORT";
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
      if (bias.direction !== "NONE") {
        biases.push(bias);
      }
    }

    return biases;
  }

  /**
   * Check if bias allows entry for a token
   */
  canEnter(tokenId: string): { allowed: boolean; reason?: string } {
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

  // Hedge
  hedges: HedgeLeg[];
  totalHedgeRatio: number;

  // Reference
  referencePriceCents: number;

  // History
  transitions: StateTransition[];
  lastUpdateTime: number;
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
    const currentPriceCents = params.orderbook.midPriceCents;
    const deviation = Math.abs(currentPriceCents - params.referencePriceCents);
    if (deviation >= this.config.entryBandCents) {
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

    // Max positions per market/token
    const tokenPositions = currentPositions.filter(
      (p) => p.tokenId === tokenId,
    );
    if (tokenPositions.length >= this.config.maxOpenPositionsPerMarket) {
      return {
        passed: false,
        reason: `Max positions per market (${this.config.maxOpenPositionsPerMarket})`,
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
}

interface TokenMarketData {
  tokenId: string;
  marketId?: string;
  orderbook: OrderbookState;
  activity: MarketActivity;
  referencePriceCents: number;
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

    // First pass: determine which positions need action (sync - fast)
    type PendingAction = {
      position: ManagedPosition;
      action: "EXIT" | "HEDGE";
      reason?: ExitReason;
      priceCents: number;
      biasDirection: BiasDirection;
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
        pendingActions.push({ position, action: "EXIT", reason: update.reason, priceCents, biasDirection: bias.direction });
      } else if (update.action === "HEDGE") {
        pendingActions.push({ position, action: "HEDGE", priceCents, biasDirection: bias.direction });
      } else {
        // Check decision engine for other exit conditions
        const exitCheck = this.decisionEngine.evaluateExit({
          position,
          currentPriceCents: priceCents,
          bias: bias.direction,
          evAllowed: this.evTracker.isTradingAllowed(),
        });
        if (exitCheck.shouldExit) {
          pendingActions.push({ position, action: "EXIT", reason: exitCheck.reason, priceCents, biasDirection: bias.direction });
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
              const result = await this.executeHedge(action.position, action.biasDirection);
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

            if (this.config.telegramBotToken) {
              await sendTelegram(
                "🔥 Position Liquidated",
                `Sold: $${result.filledUsd?.toFixed(2) || positionToSell.value.toFixed(2)}\n` +
                  `P&L: ${positionToSell.pnlPct >= 0 ? '+' : ''}${positionToSell.pnlPct.toFixed(1)}%`,
              ).catch(() => {});
            }
          } else {
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
   * 4. Enter if bias allows
   * 5. Periodic housekeeping
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
    // 4. ENTER IF BIAS ALLOWS - PARALLEL EXECUTION
    // ─────────────────────────────────────────────────────────────────
    const evAllowed = this.evTracker.isTradingAllowed();
    const activeBiases = this.biasAccumulator.getActiveBiases();
    
    if (evAllowed.allowed && activeBiases.length > 0) {
      // Execute entries in parallel to avoid missing opportunities
      // when multiple whale signals arrive simultaneously
      const entryPromises = activeBiases.slice(0, 3).map(async (bias) => {
        try {
          const marketData = await this.fetchTokenMarketData(bias.tokenId);
          if (marketData) {
            return this.executionEngine.processEntry(bias.tokenId, marketData, usdcBalance);
          }
        } catch (err) {
          console.warn(`⚠️ Entry failed for ${bias.tokenId.slice(0, 8)}...: ${err instanceof Error ? err.message : err}`);
        }
        return null;
      });
      
      await Promise.all(entryPromises);
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
    const positions = this.positionManager.getOpenPositions();
    const trackedWallets = this.biasAccumulator.getTrackedWalletCount();
    
    const winPct = (metrics.winRate * 100).toFixed(0);
    const evSign = metrics.evCents >= 0 ? "+" : "";
    const pnlSign = metrics.totalPnlUsd >= 0 ? "+" : "";
    
    // POL status - show warning if below target
    const polTarget = this.config.polReserveTarget;
    const polWarning = polBalance < polTarget ? " ⚠️" : "";
    
    console.log("");
    console.log(`📊 STATUS | ${new Date().toLocaleTimeString()}`);
    console.log(`   💰 Balance: $${usdcBalance.toFixed(2)} | Bankroll: $${effectiveBankroll.toFixed(2)} | ⛽ POL: ${polBalance.toFixed(1)}${polWarning}`);
    console.log(`   📈 Positions: ${positions.length} | Trades: ${metrics.totalTrades} | 🐋 Following: ${trackedWallets}`);
    console.log(`   🎯 Win: ${winPct}% | EV: ${evSign}${metrics.evCents.toFixed(1)}¢ | P&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`);
    console.log("");
    
    // Telegram update
    if (this.config.telegramBotToken && metrics.totalTrades > 0) {
      await sendTelegram(
        "📊 Status",
        `Balance: $${usdcBalance.toFixed(2)}\nPOL: ${polBalance.toFixed(1)}${polWarning}\nPositions: ${positions.length}\nFollowing: ${trackedWallets} wallets\nWin: ${winPct}%\nP&L: ${pnlSign}$${metrics.totalPnlUsd.toFixed(2)}`
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
// Check if this file is the entry point by examining the call stack
function isDirectlyExecuted(): boolean {
  // If we're in a test environment, don't run
  if (process.env.NODE_ENV === "test") return false;
  
  // Check if process.argv[1] contains our filename
  const scriptPath = process.argv[1] || "";
  return scriptPath.includes("churn-start");
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
