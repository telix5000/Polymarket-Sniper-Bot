/**
 * Polymarket Trading Bot V2 - Simple & Clean
 * 
 * REQUIRED ENV:
 *   PRIVATE_KEY          - Wallet private key
 *   RPC_URL              - Polygon RPC endpoint
 * 
 * PRESET:
 *   STRATEGY_PRESET or PRESET - conservative | balanced | aggressive (default: balanced)
 * 
 * COPY TRADING:
 *   TARGET_ADDRESSES or COPY_ADDRESSES - Comma-separated addresses to copy
 *   (If not set, auto-fetches top traders from Polymarket leaderboard)
 *   LEADERBOARD_LIMIT    - Number of top traders to fetch (default: 20, max: 50)
 *   TRADE_MULTIPLIER or COPY_MULTIPLIER - Size multiplier (default: 1.0)
 *   MIN_TRADE_SIZE_USD or COPY_MIN_USD  - Min trade size (default: 5)
 *   COPY_MAX_USD         - Max trade size (default: 100)
 * 
 * LIVE TRADING:
 *   LIVE_TRADING=I_UNDERSTAND_THE_RISKS  (or ARB_LIVE_TRADING)
 * 
 * OPTIONAL:
 *   INTERVAL_MS or FETCH_INTERVAL - Cycle interval (default: 5000ms)
 *   TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID - Alerts (or TELEGRAM_TOKEN/TELEGRAM_CHAT)
 *   VPN_BYPASS_RPC       - Route RPC outside VPN (default: true)
 * 
 * See README.md for full ENV reference with V1 compatibility aliases.
 */

import { JsonRpcProvider, Wallet, Contract, Interface, ZeroHash } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import axios from "axios";
import { postOrder, type OrderSide, type OrderOutcome } from "../utils/post-order.util";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";

// ============ TYPES ============

type Preset = "conservative" | "balanced" | "aggressive";

interface Position {
  tokenId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  pnlPct: number;
  gainCents: number;
  value: number;
  // V1 tracking fields
  entryTime?: number;      // When position was first seen
  lastPrice?: number;      // Previous price for spike detection
  priceHistory?: number[]; // Recent prices for momentum
}

interface Config {
  autoSell: { 
    enabled: boolean; 
    threshold: number; 
    minHoldSec: number;
    // V1 features
    disputeWindowExitEnabled: boolean;  // Exit positions stuck in dispute window
    disputeWindowExitPrice: number;     // Price for dispute exit (default: 0.999)
    stalePositionHours: number;         // Sell profitable positions held too long (0 = disabled)
    quickWinEnabled: boolean;           // Quick win exit for big fast gains
    quickWinMaxHoldMinutes: number;     // Max hold time for quick win
    quickWinProfitPct: number;          // Profit % threshold for quick win
  };
  stopLoss: { enabled: boolean; maxLossPct: number; minHoldSec: number };
  hedge: { 
    enabled: boolean; 
    triggerPct: number; 
    maxUsd: number; 
    allowExceedMax: boolean; 
    absoluteMaxUsd: number; 
    reservePct: number;
    // V1 detailed hedging features
    minHedgeUsd: number;           // Minimum hedge size (skip smaller)
    maxEntryPrice: number;         // Only hedge positions with entry below this
    forceLiquidationPct: number;   // Force liquidation instead of hedge at this loss
    emergencyLossPct: number;      // Emergency protection threshold
    minHoldSeconds: number;        // Min hold before hedging (avoid bid-ask spread issues)
    // Near-close hedging rules
    nearCloseWindowMinutes: number;    // Minutes before market close to apply stricter rules
    nearCloseLossPct: number;          // Stricter loss threshold near close
    noHedgeWindowMinutes: number;      // Don't hedge in final N minutes
    // Hedge-up feature (buy more when winning near resolution)
    hedgeUpEnabled: boolean;           // Buy more shares when price is high near close
    hedgeUpPriceThreshold: number;     // Min price to trigger hedge-up (e.g., 0.85)
    hedgeUpMaxPrice: number;           // Max price for hedge-up (e.g., 0.95)
    hedgeUpMaxUsd: number;             // Max USD per hedge-up buy
    // Hedge exit
    hedgeExitThreshold: number;        // P&L % to exit hedge pair
  };
  scalp: { 
    enabled: boolean; 
    minProfitPct: number; 
    minGainCents: number; 
    lowPriceThreshold: number; 
    minProfitUsd: number;
    // V1 scalp features  
    suddenSpikeEnabled: boolean;      // Detect sudden price spikes
    suddenSpikeThresholdPct: number;  // Spike threshold %
    suddenSpikeWindowMinutes: number; // Window for spike detection
    resolutionExclusionPrice: number; // Don't scalp near-resolution positions
    // Hold time requirements
    minHoldMinutes: number;           // Min hold before considering scalp
    maxHoldMinutes: number;           // Force exit after this time (if profitable)
  };
  stack: { enabled: boolean; minGainCents: number; maxUsd: number; maxPrice: number };
  endgame: { enabled: boolean; minPrice: number; maxPrice: number; maxUsd: number };
  redeem: { enabled: boolean; intervalMin: number; minPositionUsd: number };
  copy: { 
    enabled: boolean; 
    addresses: string[]; 
    multiplier: number; 
    minUsd: number; 
    maxUsd: number; 
    minBuyPrice: number;
  };
  arbitrage: { enabled: boolean; maxUsd: number; minEdgeBps: number; minBuyPrice: number };
  sellSignal: {
    enabled: boolean;
    minLossPctToAct: number;
    profitThresholdToSkip: number;
    severeLossPct: number;
    cooldownMs: number;
  };
  // Risk management
  risk: {
    maxDrawdownPct: number;        // Max session drawdown before stopping
    maxDailyLossUsd: number;       // Max daily loss before stopping
    maxOpenPositions: number;      // Max concurrent positions
    orderCooldownMs: number;       // Min time between orders
    maxOrdersPerHour: number;      // Rate limit
  };
  maxPositionUsd: number;
  reservePct: number;
}

interface TradeSignal {
  address: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: number;
  usdSize: number;
  timestamp: number;
  txHash: string; // For deduping
}

// ============ PRESETS ============

/**
 * PRESETS - Match V1 presets exactly
 * Values sourced from src/config/presets.ts STRATEGY_PRESETS
 */
const PRESETS: Record<Preset, Config> = {
  conservative: {
    autoSell: { 
      enabled: true, threshold: 0.999, minHoldSec: 60,
      disputeWindowExitEnabled: true, disputeWindowExitPrice: 0.999,
      stalePositionHours: 24, quickWinEnabled: false, quickWinMaxHoldMinutes: 60, quickWinProfitPct: 90,
    },
    stopLoss: { enabled: true, maxLossPct: 20, minHoldSec: 120 },
    hedge: { 
      enabled: true, triggerPct: 20, maxUsd: 10, allowExceedMax: false, absoluteMaxUsd: 25, reservePct: 25,
      minHedgeUsd: 1, maxEntryPrice: 0.75, forceLiquidationPct: 50, emergencyLossPct: 30, minHoldSeconds: 120,
      nearCloseWindowMinutes: 30, nearCloseLossPct: 10, noHedgeWindowMinutes: 5,
      hedgeUpEnabled: false, hedgeUpPriceThreshold: 0.85, hedgeUpMaxPrice: 0.95, hedgeUpMaxUsd: 10,
      hedgeExitThreshold: 15,
    },
    scalp: { 
      enabled: true, minProfitPct: 8, minGainCents: 8, lowPriceThreshold: 0, minProfitUsd: 2.0,
      suddenSpikeEnabled: true, suddenSpikeThresholdPct: 15, suddenSpikeWindowMinutes: 5, resolutionExclusionPrice: 0.90,
      minHoldMinutes: 45, maxHoldMinutes: 120,
    },
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.90 },
    endgame: { enabled: true, minPrice: 0.985, maxPrice: 0.995, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0 },
    copy: { enabled: false, addresses: [], multiplier: 0.15, minUsd: 50, maxUsd: 50, minBuyPrice: 0.50 },
    arbitrage: { enabled: true, maxUsd: 15, minEdgeBps: 300, minBuyPrice: 0.05 },
    sellSignal: { enabled: true, minLossPctToAct: 15, profitThresholdToSkip: 20, severeLossPct: 40, cooldownMs: 60000 },
    risk: { maxDrawdownPct: 15, maxDailyLossUsd: 50, maxOpenPositions: 10, orderCooldownMs: 2000, maxOrdersPerHour: 100 },
    maxPositionUsd: 15,
    reservePct: 25,
  },
  balanced: {
    autoSell: { 
      enabled: true, threshold: 0.999, minHoldSec: 60,
      disputeWindowExitEnabled: true, disputeWindowExitPrice: 0.999,
      stalePositionHours: 24, quickWinEnabled: false, quickWinMaxHoldMinutes: 60, quickWinProfitPct: 90,
    },
    stopLoss: { enabled: true, maxLossPct: 25, minHoldSec: 60 },
    hedge: { 
      enabled: true, triggerPct: 20, maxUsd: 15, allowExceedMax: false, absoluteMaxUsd: 50, reservePct: 20,
      minHedgeUsd: 1, maxEntryPrice: 0.80, forceLiquidationPct: 50, emergencyLossPct: 30, minHoldSeconds: 60,
      nearCloseWindowMinutes: 30, nearCloseLossPct: 15, noHedgeWindowMinutes: 5,
      hedgeUpEnabled: true, hedgeUpPriceThreshold: 0.85, hedgeUpMaxPrice: 0.95, hedgeUpMaxUsd: 15,
      hedgeExitThreshold: 10,
    },
    scalp: { 
      enabled: true, minProfitPct: 5, minGainCents: 5, lowPriceThreshold: 0, minProfitUsd: 1.0,
      suddenSpikeEnabled: true, suddenSpikeThresholdPct: 12, suddenSpikeWindowMinutes: 5, resolutionExclusionPrice: 0.90,
      minHoldMinutes: 30, maxHoldMinutes: 90,
    },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.985, maxPrice: 0.995, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0 },
    copy: { enabled: false, addresses: [], multiplier: 0.15, minUsd: 1, maxUsd: 100, minBuyPrice: 0.50 },
    arbitrage: { enabled: true, maxUsd: 25, minEdgeBps: 200, minBuyPrice: 0.05 },
    sellSignal: { enabled: true, minLossPctToAct: 15, profitThresholdToSkip: 20, severeLossPct: 40, cooldownMs: 60000 },
    risk: { maxDrawdownPct: 20, maxDailyLossUsd: 100, maxOpenPositions: 20, orderCooldownMs: 1000, maxOrdersPerHour: 200 },
    maxPositionUsd: 25,
    reservePct: 20,
  },
  aggressive: {
    autoSell: { 
      enabled: true, threshold: 0.999, minHoldSec: 30,
      disputeWindowExitEnabled: true, disputeWindowExitPrice: 0.999,
      stalePositionHours: 12, quickWinEnabled: true, quickWinMaxHoldMinutes: 30, quickWinProfitPct: 50,
    },
    stopLoss: { enabled: true, maxLossPct: 35, minHoldSec: 30 },
    hedge: { 
      enabled: true, triggerPct: 20, maxUsd: 50, allowExceedMax: true, absoluteMaxUsd: 100, reservePct: 15,
      minHedgeUsd: 1, maxEntryPrice: 0.85, forceLiquidationPct: 50, emergencyLossPct: 25, minHoldSeconds: 30,
      nearCloseWindowMinutes: 15, nearCloseLossPct: 20, noHedgeWindowMinutes: 3,
      hedgeUpEnabled: true, hedgeUpPriceThreshold: 0.80, hedgeUpMaxPrice: 0.95, hedgeUpMaxUsd: 50,
      hedgeExitThreshold: 5,
    },
    scalp: { 
      enabled: true, minProfitPct: 4, minGainCents: 3, lowPriceThreshold: 0, minProfitUsd: 0.5,
      suddenSpikeEnabled: true, suddenSpikeThresholdPct: 10, suddenSpikeWindowMinutes: 3, resolutionExclusionPrice: 0.95,
      minHoldMinutes: 15, maxHoldMinutes: 60,
    },
    stack: { enabled: true, minGainCents: 15, maxUsd: 100, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.94, maxUsd: 100 },
    redeem: { enabled: true, intervalMin: 10, minPositionUsd: 0 },
    copy: { enabled: false, addresses: [], multiplier: 0.15, minUsd: 5, maxUsd: 200, minBuyPrice: 0.50 },
    arbitrage: { enabled: true, maxUsd: 100, minEdgeBps: 200, minBuyPrice: 0.05 },
    sellSignal: { enabled: true, minLossPctToAct: 10, profitThresholdToSkip: 25, severeLossPct: 35, cooldownMs: 30000 },
    risk: { maxDrawdownPct: 30, maxDailyLossUsd: 200, maxOpenPositions: 30, orderCooldownMs: 500, maxOrdersPerHour: 500 },
    maxPositionUsd: 100,
    reservePct: 15,
  },
};

// ============ CONSTANTS ============

const API = "https://data-api.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const INDEX_SETS: number[] = [1, 2];
const PROXY_ABI = ["function proxy(address dest, bytes calldata data) external returns (bytes memory)"];
const CTF_ABI = ["function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"];

// ============ STATE ============

const state = {
  positions: [] as Position[],
  lastFetch: 0,
  lastRedeem: 0,
  lastBalanceCheck: 0,
  lastOrderTime: 0,
  balance: 0,
  sessionStartBalance: 0,
  dailyStartBalance: 0,
  dailyStartTime: 0,
  ordersThisHour: 0,
  hourStartTime: 0,
  stacked: new Set<string>(),
  hedged: new Set<string>(),
  sold: new Set<string>(),
  copied: new Set<string>(),
  sellSignalCooldown: new Map<string, number>(),
  positionEntryTime: new Map<string, number>(),
  positionPriceHistory: new Map<string, { price: number; time: number }[]>(), // For momentum tracking
  positionMomentum: new Map<string, number>(), // tokenId -> momentum score (-1 to +1)
  telegram: undefined as { token: string; chatId: string } | undefined,
  proxyAddress: undefined as string | undefined,
  copyLastCheck: new Map<string, number>(),
  clobClient: undefined as (ClobClient & { wallet: Wallet }) | undefined,
  wallet: undefined as Wallet | undefined,
  provider: undefined as JsonRpcProvider | undefined,
  liveTrading: false,
  authOk: false,
  riskHalted: false,
  vpnActive: false, // Track VPN status
};

// ============ P&L LEDGER ============

/**
 * Simple in-memory P&L ledger
 * Tracks all trades and calculates running totals
 * Sends periodic summaries via Telegram
 */
interface TradeRecord {
  timestamp: number;
  side: "BUY" | "SELL";
  outcome: string;
  strategy: string;
  sizeUsd: number;
  price: number;
  success: boolean;
}

const ledger = {
  trades: [] as TradeRecord[],
  totalBuys: 0,
  totalSells: 0,
  buyCount: 0,
  sellCount: 0,
  lastSummary: 0,
  summaryIntervalMs: 300_000, // 5 minutes
};

/** Record a trade in the ledger */
function recordTrade(side: "BUY" | "SELL", outcome: string, strategy: string, sizeUsd: number, price: number, success: boolean) {
  ledger.trades.push({
    timestamp: Date.now(),
    side,
    outcome,
    strategy,
    sizeUsd,
    price,
    success,
  });
  
  if (success) {
    if (side === "BUY") {
      ledger.totalBuys += sizeUsd;
      ledger.buyCount++;
    } else {
      ledger.totalSells += sizeUsd;
      ledger.sellCount++;
    }
  }
}

/** Get session P&L summary */
function getLedgerSummary(): string {
  const netFlow = ledger.totalSells - ledger.totalBuys;
  const balanceChange = state.balance - state.sessionStartBalance;
  const totalTrades = ledger.buyCount + ledger.sellCount;
  
  return [
    `📊 *Session Summary*`,
    `Trades: ${totalTrades} (${ledger.buyCount} buys, ${ledger.sellCount} sells)`,
    `Bought: ${$(ledger.totalBuys)}`,
    `Sold: ${$(ledger.totalSells)}`,
    `Net Flow: ${$(netFlow)}`,
    `Balance: ${$(state.balance)} (${balanceChange >= 0 ? "+" : ""}${$(balanceChange)})`,
  ].join("\n");
}

/** Send periodic summary if enough time has passed */
async function maybeSendSummary() {
  if (Date.now() - ledger.lastSummary < ledger.summaryIntervalMs) return;
  if (ledger.buyCount + ledger.sellCount === 0) return; // No trades yet
  
  ledger.lastSummary = Date.now();
  const summary = getLedgerSummary();
  log(summary.replace(/\*/g, "")); // Log without markdown
  
  if (state.telegram) {
    await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
      chat_id: state.telegram.chatId,
      text: summary,
      parse_mode: "Markdown",
    }).catch(() => {});
  }
}

// ============ RISK MANAGEMENT ============

/**
 * Check if we can place an order based on risk limits
 * Returns { allowed: boolean, reason?: string }
 */
function checkRiskLimits(cfg: Config): { allowed: boolean; reason?: string } {
  if (state.riskHalted) {
    return { allowed: false, reason: "Risk halted - limits exceeded" };
  }
  
  // Check session drawdown
  if (state.sessionStartBalance > 0) {
    const drawdownPct = ((state.sessionStartBalance - state.balance) / state.sessionStartBalance) * 100;
    if (drawdownPct >= cfg.risk.maxDrawdownPct) {
      state.riskHalted = true;
      return { allowed: false, reason: `Max drawdown ${drawdownPct.toFixed(1)}% >= ${cfg.risk.maxDrawdownPct}%` };
    }
  }
  
  // Check daily loss
  const now = Date.now();
  if (state.dailyStartTime === 0 || now - state.dailyStartTime > 24 * 60 * 60 * 1000) {
    // Reset daily tracking
    state.dailyStartBalance = state.balance;
    state.dailyStartTime = now;
  }
  const dailyLoss = state.dailyStartBalance - state.balance;
  if (dailyLoss >= cfg.risk.maxDailyLossUsd) {
    state.riskHalted = true;
    return { allowed: false, reason: `Daily loss ${$(dailyLoss)} >= ${$(cfg.risk.maxDailyLossUsd)}` };
  }
  
  // Check order rate limit
  if (state.hourStartTime === 0 || now - state.hourStartTime > 60 * 60 * 1000) {
    state.ordersThisHour = 0;
    state.hourStartTime = now;
  }
  if (state.ordersThisHour >= cfg.risk.maxOrdersPerHour) {
    return { allowed: false, reason: `Rate limit: ${state.ordersThisHour} orders this hour` };
  }
  
  // Check order cooldown
  if (now - state.lastOrderTime < cfg.risk.orderCooldownMs) {
    return { allowed: false, reason: `Cooldown: ${cfg.risk.orderCooldownMs - (now - state.lastOrderTime)}ms remaining` };
  }
  
  // Check max open positions
  if (state.positions.length >= cfg.risk.maxOpenPositions) {
    return { allowed: false, reason: `Max positions: ${state.positions.length} >= ${cfg.risk.maxOpenPositions}` };
  }
  
  return { allowed: true };
}

/** Record that an order was placed (for rate limiting) */
function recordOrderPlaced() {
  state.lastOrderTime = Date.now();
  state.ordersThisHour++;
}

/** Get position hold time in seconds */
function getPositionHoldTime(tokenId: string): number {
  const entryTime = state.positionEntryTime.get(tokenId);
  if (!entryTime) return 0;
  return Math.floor((Date.now() - entryTime) / 1000);
}

/** Track position entry time when first seen */
function trackPositionEntry(tokenId: string) {
  if (!state.positionEntryTime.has(tokenId)) {
    state.positionEntryTime.set(tokenId, Date.now());
  }
}

/** Track price history with timestamps for momentum */
function trackPriceHistory(tokenId: string, price: number) {
  const now = Date.now();
  let history = state.positionPriceHistory.get(tokenId) || [];
  history.push({ price, time: now });
  // Keep last 20 data points (about 2 minutes at 5s intervals)
  if (history.length > 20) history = history.slice(-20);
  state.positionPriceHistory.set(tokenId, history);
  
  // Calculate momentum score
  updateMomentum(tokenId, history);
}

/** Calculate momentum score (-1 to +1) based on price history */
function updateMomentum(tokenId: string, history: { price: number; time: number }[]) {
  if (history.length < 3) {
    state.positionMomentum.set(tokenId, 0);
    return;
  }
  
  // Calculate price changes
  let upMoves = 0;
  let downMoves = 0;
  let totalChange = 0;
  
  for (let i = 1; i < history.length; i++) {
    const change = history[i].price - history[i - 1].price;
    totalChange += change;
    if (change > 0) upMoves++;
    else if (change < 0) downMoves++;
  }
  
  // Momentum = direction consistency + magnitude
  const consistency = (upMoves - downMoves) / (history.length - 1);
  const magnitude = totalChange / history[0].price; // Normalize by starting price
  
  // Combine: 70% consistency, 30% magnitude (clamped to -1 to 1)
  const momentum = Math.max(-1, Math.min(1, consistency * 0.7 + magnitude * 10 * 0.3));
  state.positionMomentum.set(tokenId, momentum);
}

/** Get momentum score for a position (-1 = falling, 0 = flat, +1 = rising) */
function getMomentum(tokenId: string): number {
  return state.positionMomentum.get(tokenId) || 0;
}

/** Check if momentum is fading (was positive, now declining) */
function isMomentumFading(tokenId: string): boolean {
  const history = state.positionPriceHistory.get(tokenId);
  if (!history || history.length < 5) return false;
  
  // Compare recent momentum to older momentum
  const recentPrices = history.slice(-3).map(h => h.price);
  const olderPrices = history.slice(-6, -3).map(h => h.price);
  
  if (olderPrices.length < 3) return false;
  
  const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
  const olderAvg = olderPrices.reduce((a, b) => a + b, 0) / olderPrices.length;
  
  // Momentum is fading if we were rising but now flat or falling
  return olderAvg < recentAvg && recentPrices[2] <= recentPrices[1];
}

/** Detect sudden price spike within time window */
function detectPriceSpike(tokenId: string, currentPrice: number, thresholdPct: number, windowMinutes?: number): boolean {
  const history = state.positionPriceHistory.get(tokenId);
  if (!history || history.length < 2) return false;
  
  const now = Date.now();
  const windowMs = (windowMinutes || 5) * 60 * 1000;
  
  // Find oldest price within window
  let oldestInWindow = history[0];
  for (const h of history) {
    if (now - h.time <= windowMs) {
      oldestInWindow = h;
      break;
    }
  }
  
  if (oldestInWindow.price <= 0) return false;
  
  const changePct = ((currentPrice - oldestInWindow.price) / oldestInWindow.price) * 100;
  return changePct >= thresholdPct;
}

/** Dynamic reserves based on drawdown (V1 feature) */
function getDynamicReservePct(cfg: Config): number {
  if (state.sessionStartBalance <= 0) return cfg.reservePct;
  
  const drawdownPct = ((state.sessionStartBalance - state.balance) / state.sessionStartBalance) * 100;
  
  // Increase reserves as drawdown increases
  if (drawdownPct >= 20) return Math.min(50, cfg.reservePct + 25); // +25% reserves at 20% drawdown
  if (drawdownPct >= 10) return Math.min(40, cfg.reservePct + 15); // +15% reserves at 10% drawdown
  if (drawdownPct >= 5) return Math.min(35, cfg.reservePct + 5);   // +5% reserves at 5% drawdown
  
  return cfg.reservePct;
}

/** Get total position value for a token (for max position check) */
function getTotalPositionValue(tokenId: string): number {
  return state.positions
    .filter(p => p.tokenId === tokenId || p.conditionId === state.positions.find(pos => pos.tokenId === tokenId)?.conditionId)
    .reduce((sum, p) => sum + p.value, 0);
}

/** Pre-execution order checks (V1 feature) */
async function preOrderCheck(tokenId: string, side: "BUY" | "SELL", sizeUsd: number, cfg: Config): Promise<{ ok: boolean; reason?: string }> {
  // Check global max position size for BUY orders
  if (side === "BUY") {
    const currentValue = getTotalPositionValue(tokenId);
    if (currentValue + sizeUsd > cfg.maxPositionUsd * 2) { // Allow up to 2x for hedges
      return { ok: false, reason: `Would exceed max position: ${$(currentValue + sizeUsd)} > ${$(cfg.maxPositionUsd * 2)}` };
    }
  }
  
  // Check minimum order size
  if (sizeUsd < 1) {
    return { ok: false, reason: `Order too small: ${$(sizeUsd)} < $1.00` };
  }
  
  // For SELL, verify we have the position
  if (side === "SELL") {
    const position = state.positions.find(p => p.tokenId === tokenId);
    if (!position) {
      return { ok: false, reason: "No position to sell" };
    }
    if (sizeUsd > position.value * 1.1) { // Allow 10% buffer for price changes
      return { ok: false, reason: `Sell size ${$(sizeUsd)} exceeds position value ${$(position.value)}` };
    }
  }
  
  return { ok: true };
}

// ============ LOGGING ============

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ============ ALERTS (Rich Telegram - V1 feature) ============

/**
 * Send clean alerts for Telegram
 * Format: ACTION | RESULT | DETAILS
 */
async function alert(action: string, details: string, success = true) {
  const icon = success ? "✅" : "❌";
  const line = `${action} ${icon} | ${details}`;
  log(`📢 ${line}`);
  if (state.telegram) {
    await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
      chat_id: state.telegram.chatId, 
      text: line,
      parse_mode: "Markdown",
    }).catch((e) => log(`⚠️ Telegram error: ${e.message}`));
  }
}

/**
 * Rich trade alert with full context (V1 feature)
 */
async function alertTrade(side: "BUY" | "SELL", strategy: string, outcome: string, sizeUsd: number, price?: number, success = true, errorMsg?: string) {
  const icon = success ? "✅" : "❌";
  const priceStr = price ? ` @ ${(price * 100).toFixed(1)}¢` : "";
  const balanceStr = state.balance > 0 ? ` | Bal: ${$(state.balance)}` : "";
  const pnlStr = state.sessionStartBalance > 0 ? ` | P&L: ${$(state.balance - state.sessionStartBalance)}` : "";
  
  let msg: string;
  if (success) {
    msg = `${side} ${icon} | *${strategy}*\n${outcome} ${$(sizeUsd)}${priceStr}${balanceStr}${pnlStr}`;
  } else {
    msg = `${side} ${icon} | *${strategy}*\n${outcome} ${$(sizeUsd)} | ${errorMsg || "Failed"}`;
  }
  
  log(`📢 ${msg.replace(/\n/g, " | ").replace(/\*/g, "")}`);
  
  if (state.telegram) {
    await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
      chat_id: state.telegram.chatId, 
      text: msg,
      parse_mode: "Markdown",
    }).catch((e) => log(`⚠️ Telegram error: ${e.message}`));
  }
}

/** Send startup/shutdown alerts with rich context */
async function alertStatus(msg: string) {
  log(`📢 ${msg}`);
  if (state.telegram) {
    await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
      chat_id: state.telegram.chatId, 
      text: `🤖 ${msg}`,
      parse_mode: "Markdown",
    }).catch((e) => log(`⚠️ Telegram error: ${e.message}`));
  }
}

/** Send position summary (V1 feature) */
async function alertPositionSummary() {
  if (!state.telegram || state.positions.length === 0) return;
  
  const totalValue = state.positions.reduce((sum, p) => sum + p.value, 0);
  const totalPnl = state.positions.reduce((sum, p) => sum + (p.value * p.pnlPct / 100), 0);
  const winning = state.positions.filter(p => p.pnlPct > 0).length;
  const losing = state.positions.filter(p => p.pnlPct < 0).length;
  
  const msg = [
    `📊 *Position Summary*`,
    `Positions: ${state.positions.length} (${winning}↑ ${losing}↓)`,
    `Total Value: ${$(totalValue)}`,
    `Unrealized P&L: ${$(totalPnl)}`,
    `Balance: ${$(state.balance)}`,
    `Session P&L: ${$(state.balance - state.sessionStartBalance)}`,
  ].join("\n");
  
  await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
    chat_id: state.telegram.chatId, 
    text: msg,
    parse_mode: "Markdown",
  }).catch((e) => log(`⚠️ Telegram error: ${e.message}`));
}

// ============ FORMATTING ============

/** Format USD amount as $1.23 */
function $(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Format price as $0.XX (dollar format, not cents) */
function $price(price: number): string {
  return `$${price.toFixed(2)}`;
}

/** Format percentage with sign */
function pct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

// ============ API ============

const LEADERBOARD_API = "https://data-api.polymarket.com/v1/leaderboard";

async function fetchLeaderboard(limit: number): Promise<string[]> {
  try {
    const url = `${LEADERBOARD_API}?category=OVERALL&timePeriod=MONTH&orderBy=PNL&limit=${Math.min(limit, 50)}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    const addresses = (data || [])
      .map((e: any) => e?.proxyWallet)
      .filter((a: string) => a && /^0x[a-fA-F0-9]{40}$/.test(a))
      .map((a: string) => a.toLowerCase());
    const unique = [...new Set(addresses)] as string[];
    if (unique.length > 0) {
      log(`🏆 Fetched ${unique.length} top traders from leaderboard`);
    }
    return unique;
  } catch (e) {
    log(`⚠️ Leaderboard fetch failed: ${e}`);
    return [];
  }
}

async function fetchPositions(wallet: string): Promise<Position[]> {
  if (Date.now() - state.lastFetch < 30000 && state.positions.length) return state.positions;

  try {
    const { data } = await axios.get(`${API}/positions?user=${wallet}`);
    state.positions = (data || [])
      .filter((p: any) => Number(p.size) > 0 && !p.redeemable)
      .map((p: any) => {
        const size = Number(p.size), avgPrice = Number(p.avgPrice), curPrice = Number(p.curPrice);
        const cost = size * avgPrice, value = size * curPrice;
        return {
          tokenId: p.asset, conditionId: p.conditionId, outcome: p.outcome || "YES",
          size, avgPrice, curPrice, value,
          pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
          gainCents: (curPrice - avgPrice) * 100,
        };
      });
    state.lastFetch = Date.now();
    log(`📊 ${state.positions.length} positions`);
  } catch (e) { log(`❌ API: ${e}`); }
  return state.positions;
}

async function fetchRedeemable(wallet: string): Promise<string[]> {
  try {
    const { data } = await axios.get(`${API}/positions?user=${wallet}&redeemable=true`);
    return [...new Set((data || []).map((p: any) => p.conditionId))] as string[];
  } catch { return []; }
}

async function fetchProxy(wallet: string): Promise<string | undefined> {
  try {
    const { data } = await axios.get(`${API}/profile?address=${wallet}`);
    return data?.proxyAddress?.toLowerCase();
  } catch { return undefined; }
}

async function fetchActivity(address: string): Promise<TradeSignal[]> {
  try {
    const { data } = await axios.get(`${API}/activity?user=${address}`);
    return (data || [])
      .filter((a: any) => a.type === "TRADE") // Only actual trades, not deposits etc
      .map((a: any) => ({
        address, 
        conditionId: a.conditionId, 
        tokenId: a.asset,
        outcome: a.outcomeIndex === 0 ? "YES" : "NO",
        side: a.side?.toUpperCase() === "BUY" ? "BUY" as const : "SELL" as const,
        price: Number(a.price) || 0, 
        usdSize: Number(a.usdcSize) || Number(a.size) * Number(a.price) || 0,
        timestamp: Number(a.timestamp) || 0,
        txHash: a.transactionHash || `${a.asset}-${a.timestamp}`, // Use txHash for deduping
      }));
  } catch { return []; }
}

async function countBuys(wallet: string, tokenId: string): Promise<number> {
  try {
    const { data } = await axios.get(`${API}/trades?user=${wallet}&asset=${tokenId}&limit=20`);
    return (data || []).filter((t: any) => t.side?.toUpperCase() === "BUY").length;
  } catch { return 0; }
}

function invalidate() { state.lastFetch = 0; }

// ============ BALANCE & RESERVES ============

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

async function fetchBalance(): Promise<number> {
  // Cache balance for 30s
  if (Date.now() - state.lastBalanceCheck < 30000 && state.balance > 0) return state.balance;
  
  if (!state.provider || !state.wallet) return 0;
  
  try {
    const usdc = new Contract(USDC_ADDRESS, USDC_ABI, state.provider);
    const bal = await usdc.balanceOf(state.wallet.address);
    state.balance = Number(bal) / 1e6; // USDC has 6 decimals
    state.lastBalanceCheck = Date.now();
    return state.balance;
  } catch (e) {
    log(`⚠️ Balance check failed: ${e}`);
    return state.balance || 0;
  }
}

/**
 * Get available balance after dynamic reserves
 * Reserves increase as drawdown increases (V1 feature)
 */
function getAvailableBalance(cfg: Config): number {
  const dynamicReservePct = getDynamicReservePct(cfg);
  const reserved = state.balance * (dynamicReservePct / 100);
  return Math.max(0, state.balance - reserved);
}

/**
 * Check if we can spend an amount (respects reserves)
 * Hedging and protective actions can dip into reserves (allowReserve=true)
 */
function canSpend(amount: number, cfg: Config, allowReserve = false): boolean {
  if (allowReserve) {
    // Hedging can use full balance
    return state.balance >= amount;
  }
  // Normal trades must respect dynamic reserve
  return getAvailableBalance(cfg) >= amount;
}

// ============ ORDER EXECUTION ============

const logLevel = process.env.LOG_LEVEL || "info";
const simpleLogger = {
  info: log,
  warn: log,
  error: log,
  debug: logLevel === "debug" ? log : () => {},
};

/**
 * Execute a SELL order
 * Alert format: "SELL ✅ | {reason} | {outcome} {amount} @ {price}"
 */
async function executeSell(tokenId: string, conditionId: string, outcome: string, sizeUsd: number, reason: string, cfg: Config, curPrice?: number): Promise<boolean> {
  const priceStr = curPrice ? ` @ ${$price(curPrice)}` : "";
  
  // Risk check (SELL orders are always allowed for protective exits, but still rate limited)
  const riskCheck = checkRiskLimits(cfg);
  if (!riskCheck.allowed && !reason.includes("StopLoss") && !reason.includes("AutoSell") && !reason.includes("ForceLiq")) {
    log(`⚠️ SELL blocked | ${riskCheck.reason}`);
    return false;
  }
  
  // Pre-execution checks (V1 feature)
  const preCheck = await preOrderCheck(tokenId, "SELL", sizeUsd, cfg);
  if (!preCheck.ok) {
    log(`⚠️ SELL pre-check failed | ${preCheck.reason}`);
    return false;
  }
  
  if (!state.liveTrading) {
    log(`🔸 SELL [SIM] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, true);
    recordOrderPlaced();
    return true;
  }
  
  if (!state.clobClient || !state.wallet) {
    log(`❌ SELL | ${reason} | No CLOB client`);
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
    return false;
  }

  log(`💰 SELL | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
  
  try {
    const result = await postOrder({
      client: state.clobClient,
      wallet: state.wallet,
      tokenId,
      outcome: outcome as OrderOutcome,
      side: "SELL" as OrderSide,
      sizeUsd,
      sellSlippagePct: 5,
      logger: simpleLogger as any,
    });
    
    if (result.status === "submitted") {
      await alertTrade("SELL", reason, outcome, sizeUsd, curPrice, true);
      recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, true);
      recordOrderPlaced();
      invalidate();
      return true;
    }
    await alertTrade("SELL", reason, outcome, sizeUsd, curPrice, false, result.reason);
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
    return false;
  } catch (e: any) {
    await alertTrade("SELL", reason, outcome, sizeUsd, curPrice, false, e.message?.slice(0, 30));
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
    return false;
  }
}

/**
 * Execute a BUY order
 * Alert format: "BUY ✅ | {reason} | {outcome} {amount} @ {price}"
 */
async function executeBuy(tokenId: string, conditionId: string, outcome: string, sizeUsd: number, reason: string, cfg: Config, allowReserve = false, price?: number): Promise<boolean> {
  const priceStr = price ? ` @ ${$price(price)}` : "";
  
  // Risk check (Hedge orders bypass some checks)
  const isHedge = reason.includes("Hedge");
  const riskCheck = checkRiskLimits(cfg);
  if (!riskCheck.allowed && !isHedge) {
    log(`⚠️ BUY blocked | ${riskCheck.reason}`);
    return false;
  }
  
  // Pre-execution checks (V1 feature)
  const preCheck = await preOrderCheck(tokenId, "BUY", sizeUsd, cfg);
  if (!preCheck.ok && !isHedge) {
    log(`⚠️ BUY pre-check failed | ${preCheck.reason}`);
    return false;
  }
  
  // Check reserves before buying (hedging can dip into reserves)
  if (!canSpend(sizeUsd, cfg, allowReserve)) {
    const avail = allowReserve ? state.balance : getAvailableBalance(cfg);
    log(`⚠️ BUY | ${reason} | Insufficient (${$(sizeUsd)} > ${$(avail)} avail)`);
    return false;
  }

  if (!state.liveTrading) {
    log(`🔸 BUY [SIM] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, true);
    recordOrderPlaced();
    return true;
  }
  
  if (!state.clobClient || !state.wallet) {
    log(`❌ BUY | ${reason} | No CLOB client`);
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
    return false;
  }

  log(`🛒 BUY | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
  
  try {
    const result = await postOrder({
      client: state.clobClient,
      wallet: state.wallet,
      tokenId,
      outcome: outcome as OrderOutcome,
      side: "BUY" as OrderSide,
      sizeUsd,
      buySlippagePct: 3,
      logger: simpleLogger as any,
    });
    
    if (result.status === "submitted") {
      await alertTrade("BUY", reason, outcome, sizeUsd, price, true);
      recordTrade("BUY", outcome, reason, sizeUsd, price || 0, true);
      recordOrderPlaced();
      invalidate();
      return true;
    }
    await alertTrade("BUY", reason, outcome, sizeUsd, price, false, result.reason);
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
    return false;
  } catch (e: any) {
    await alertTrade("BUY", reason, outcome, sizeUsd, price, false, e.message?.slice(0, 30));
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
    return false;
  }
}

// ============ COPY TRADING ============

/**
 * Copy BUY trades from tracked traders
 * 
 * RULES (from V1):
 * - Only copy BUY signals (SELL signals handled by sellSignalProtection)
 * - Skip if price < MIN_BUY_PRICE (default 50¢) - avoids loser positions
 * - Respect position limits (COPY_MAX_USD)
 * - Apply multiplier and clamp to min/max USD
 * - Only process trades within aggregation window (5 min default)
 * - Use txHash for reliable deduping
 */
async function copyTrades(cfg: Config) {
  if (!cfg.copy.enabled || !cfg.copy.addresses.length) return;

  // Aggregation window - only look at trades from last 5 minutes
  const now = Math.floor(Date.now() / 1000);
  const cutoffTime = now - 300; // 5 minutes in seconds

  for (const addr of cfg.copy.addresses) {
    const activities = await fetchActivity(addr);
    
    for (const signal of activities) {
      // Skip old trades (before cutoff or before last check)
      const lastCheck = state.copyLastCheck.get(addr) || 0;
      if (signal.timestamp < cutoffTime) continue;
      if (signal.timestamp <= lastCheck) continue;
      
      // Use txHash for deduping (more reliable than timestamp)
      if (state.copied.has(signal.txHash)) continue;
      if (signal.side !== "BUY") continue; // Only copy buys (sells handled by sellSignalProtection)
      
      // MIN_BUY_PRICE check - don't buy positions below threshold (default $0.50)
      // This prevents copying into likely loser positions
      if (signal.price < cfg.copy.minBuyPrice) {
        log(`🚫 Copy skip | ${$price(signal.price)} < ${$price(cfg.copy.minBuyPrice)} min`);
        state.copied.add(signal.txHash);
        continue;
      }
      
      let copyUsd = signal.usdSize * cfg.copy.multiplier;
      copyUsd = Math.max(cfg.copy.minUsd, Math.min(cfg.copy.maxUsd, copyUsd));
      
      // Don't exceed max position size
      const existing = state.positions.find(p => p.tokenId === signal.tokenId);
      if (existing && existing.value >= cfg.copy.maxUsd) {
        log(`🚫 Copy skip | Already at max (${$(existing.value)} >= ${$(cfg.copy.maxUsd)})`);
        state.copied.add(signal.txHash);
        continue;
      }
      
      log(`👀 Copy | ${addr.slice(0,8)}... | ${signal.outcome} ${$(copyUsd)} @ ${$price(signal.price)}`);
      // Copy trades respect reserves (normal trade)
      await executeBuy(signal.tokenId, signal.conditionId, signal.outcome, copyUsd, "Copy", cfg, false, signal.price);
      state.copied.add(signal.txHash);
    }
    state.copyLastCheck.set(addr, now);
  }
}

// ============ SELL SIGNAL MONITOR ============

/**
 * Process SELL signals from tracked traders (V1 SellSignalMonitorService equivalent)
 * 
 * LOGIC (from V1 sell-signal-monitor.service.ts):
 * 1. When a tracked trader SELLS a position we also hold
 * 2. Check if our position is LOSING (pnlPct < 0)
 * 3. Only act if loss exceeds threshold (minLossPctToAct, default 15%)
 * 4. Do NOT act if position is profitable (>profitThresholdToSkip% profit)
 * 5. Trigger hedge for moderate losses (15-40%), stop-loss for severe losses (>40%)
 * 6. Cooldown prevents repeated actions on the same position
 */
async function processSellSignals(cfg: Config) {
  if (!cfg.sellSignal.enabled || !cfg.copy.enabled || !cfg.copy.addresses.length) return;
  
  const now = Date.now();
  
  for (const addr of cfg.copy.addresses) {
    const activities = await fetchActivity(addr);
    
    for (const signal of activities) {
      // Only process SELL signals
      if (signal.side !== "SELL") continue;
      
      // Skip if already processed
      if (state.copied.has(signal.txHash)) continue;
      
      // Mark as processed to avoid reprocessing
      state.copied.add(signal.txHash);
      
      // Check if we hold this position
      const ourPosition = state.positions.find(p => p.tokenId === signal.tokenId);
      if (!ourPosition) continue;
      
      // Check cooldown
      const lastAction = state.sellSignalCooldown.get(signal.tokenId) || 0;
      if (now - lastAction < cfg.sellSignal.cooldownMs) {
        log(`⏳ Sell signal cooldown | ${signal.tokenId.slice(0,8)}...`);
        continue;
      }
      
      // Skip if we're profitable ("knee deep in positive")
      if (ourPosition.pnlPct >= cfg.sellSignal.profitThresholdToSkip) {
        log(`✅ Sell signal skip | We're ${pct(ourPosition.pnlPct)} (profitable)`);
        continue;
      }
      
      // Skip if loss is below threshold
      if (ourPosition.pnlPct > -cfg.sellSignal.minLossPctToAct) {
        log(`📊 Sell signal alert | ${signal.tokenId.slice(0,8)}... | We're ${pct(ourPosition.pnlPct)} (small loss)`);
        await alert("⚠️ SELL SIGNAL", `Trader sold | We're ${pct(ourPosition.pnlPct)} | Watching`, true);
        continue;
      }
      
      // Severe loss -> stop-loss (sell immediately)
      if (ourPosition.pnlPct <= -cfg.sellSignal.severeLossPct) {
        log(`🚨 Sell signal STOP-LOSS | ${pct(ourPosition.pnlPct)}`);
        if (await executeSell(ourPosition.tokenId, ourPosition.conditionId, ourPosition.outcome, ourPosition.value, `SellSignal StopLoss (${pct(ourPosition.pnlPct)})`, cfg, ourPosition.curPrice)) {
          state.sold.add(ourPosition.tokenId);
          state.sellSignalCooldown.set(signal.tokenId, now);
        }
        continue;
      }
      
      // Moderate loss -> hedge
      if (!state.hedged.has(ourPosition.tokenId)) {
        const opp = ourPosition.outcome === "YES" ? "NO" : "YES";
        log(`🛡️ Sell signal HEDGE | ${pct(ourPosition.pnlPct)}`);
        const hedgeAmt = cfg.hedge.allowExceedMax ? cfg.hedge.absoluteMaxUsd : cfg.hedge.maxUsd;
        if (await executeBuy(ourPosition.tokenId, ourPosition.conditionId, opp, hedgeAmt, `SellSignal Hedge (${pct(ourPosition.pnlPct)})`, cfg, true, ourPosition.curPrice)) {
          state.hedged.add(ourPosition.tokenId);
          state.sellSignalCooldown.set(signal.tokenId, now);
        }
      }
    }
  }
}

// ============ REDEEM ============

async function redeem(walletAddr: string, cfg: Config) {
  if (!cfg.redeem.enabled || !state.wallet) return;
  if (Date.now() - state.lastRedeem < cfg.redeem.intervalMin * 60 * 1000) return;
  
  state.lastRedeem = Date.now();
  const target = state.proxyAddress || walletAddr;
  const conditions = await fetchRedeemable(target);
  if (!conditions.length) return;
  
  log(`🎁 ${conditions.length} to redeem`);
  const iface = new Interface(CTF_ABI);
  
  for (const cid of conditions) {
    try {
      const data = iface.encodeFunctionData("redeemPositions", [USDC_ADDRESS, ZeroHash, cid, INDEX_SETS]);
      let tx;
      if (state.proxyAddress && state.proxyAddress !== walletAddr) {
        tx = await new Contract(state.proxyAddress, PROXY_ABI, state.wallet).proxy(CTF_ADDRESS, data);
      } else {
        tx = await new Contract(CTF_ADDRESS, CTF_ABI, state.wallet).redeemPositions(USDC_ADDRESS, ZeroHash, cid, INDEX_SETS);
      }
      log(`✅ Redeem: ${tx.hash.slice(0,10)}...`);
      await tx.wait();
    } catch (e: any) { log(`❌ Redeem: ${e.message?.slice(0,40)}`); }
  }
}

// ============ ARBITRAGE ============

async function arbitrage(cfg: Config) {
  if (!cfg.arbitrage.enabled) return;
  
  const conditionIds = [...new Set(state.positions.map(p => p.conditionId))];
  
  for (const cid of conditionIds) {
    try {
      const { data } = await axios.get(`https://clob.polymarket.com/markets/${cid}`);
      if (!data?.tokens?.length) continue;
      
      const yes = data.tokens.find((t: any) => t.outcome === "Yes");
      const no = data.tokens.find((t: any) => t.outcome === "No");
      if (!yes || !no) continue;
      
      const yesPrice = Number(yes.price) || 0;
      const noPrice = Number(no.price) || 0;
      const total = yesPrice + noPrice;
      
      // Check minBuyPrice - skip if either side is below threshold (likely loser)
      if (yesPrice < cfg.arbitrage.minBuyPrice || noPrice < cfg.arbitrage.minBuyPrice) {
        continue;
      }
      
      if (total < 0.98 && total > 0.5) {
        const profitPct = (1 - total) * 100;
        log(`💎 Arb | YES ${$price(yesPrice)} + NO ${$price(noPrice)} = ${profitPct.toFixed(1)}% profit`);
        const arbUsd = cfg.arbitrage.maxUsd / 2;
        // Arbitrage respects reserves (normal trade)
        await executeBuy(yes.token_id, cid, "YES", arbUsd, "Arb", cfg, false, yesPrice);
        await executeBuy(no.token_id, cid, "NO", arbUsd, "Arb", cfg, false, noPrice);
      }
    } catch { /* skip */ }
  }
}

// ============ MAIN CYCLE ============

/**
 * STRATEGY PRIORITY ORDER:
 * 1. AutoSell (near $1) - guaranteed profit, always take it
 * 2. Hedge (losing) - try to RECOVER before giving up
 * 3. Stop-Loss - ONLY if hedging disabled (alternative to hedge, not both)
 * 4. Scalp (in profit) - take profits
 * 5. Stack (winning) - add to winners
 * 6. Endgame (high confidence) - ride to finish
 * 
 * Each position gets ONE action per cycle.
 * Hedge runs BEFORE stop-loss because hedge is recovery, stop-loss is surrender.
 */
async function cycle(walletAddr: string, cfg: Config) {
  // Track positions acted on THIS cycle (reset each cycle)
  const cycleActed = new Set<string>();
  
  // Refresh balance periodically
  await fetchBalance();
  
  // Copy BUY trades from tracked traders
  await copyTrades(cfg);
  
  // Process SELL signals from tracked traders (protective actions)
  await processSellSignals(cfg);
  
  const positions = await fetchPositions(state.proxyAddress || walletAddr);
  if (!positions.length) {
    await redeem(walletAddr, cfg);
    return;
  }
  
  // Process each position ONCE based on priority
  // PRIORITY ORDER (matches V1 orchestrator):
  // 1. AutoSell - guaranteed profit near $1
  // 2. Hedge - try to RECOVER losing positions BEFORE giving up
  // 3. Stop-Loss - only if NOT hedged and loss exceeds threshold
  // 4. Scalp - take profits on winners
  // 5. Stack - double down on winners
  // 6. Endgame - ride high-confidence to finish
  
  for (const p of positions) {
    // Skip if already acted on (sold permanently)
    if (state.sold.has(p.tokenId)) continue;
    
    // Track position entry time and price history
    trackPositionEntry(p.tokenId);
    trackPriceHistory(p.tokenId, p.curPrice);
    
    const holdTime = getPositionHoldTime(p.tokenId);
    
    // 1. AUTO-SELL: Near $1 - guaranteed profit (highest priority)
    if (cfg.autoSell.enabled && p.curPrice >= cfg.autoSell.threshold && holdTime >= cfg.autoSell.minHoldSec) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "AutoSell", cfg, p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 1b. DISPUTE WINDOW EXIT: Exit positions at 99.9¢ to avoid dispute wait
    // Positions near resolution can get stuck in 2-hour dispute windows
    if (cfg.autoSell.disputeWindowExitEnabled && p.curPrice >= cfg.autoSell.disputeWindowExitPrice && p.curPrice < 1.0) {
      log(`⚡ Dispute window exit | ${p.outcome} @ ${$price(p.curPrice)}`);
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `DisputeExit (${$price(p.curPrice)})`, cfg, p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 1c. QUICK WIN: Big profit in short time
    if (cfg.autoSell.quickWinEnabled && holdTime < cfg.autoSell.quickWinMaxHoldMinutes * 60 && p.pnlPct >= cfg.autoSell.quickWinProfitPct) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `QuickWin (${pct(p.pnlPct)})`, cfg, p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 1d. STALE POSITION: Profitable but held too long
    if (cfg.autoSell.stalePositionHours > 0 && p.pnlPct > 0 && holdTime >= cfg.autoSell.stalePositionHours * 3600) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `Stale (${Math.floor(holdTime / 3600)}h)`, cfg, p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 2. HEDGE-UP: Buy MORE shares when winning and price is high (near resolution)
    // This doubles down on winners approaching $1
    if (cfg.hedge.hedgeUpEnabled && p.pnlPct > 0 && p.curPrice >= cfg.hedge.hedgeUpPriceThreshold && p.curPrice <= cfg.hedge.hedgeUpMaxPrice) {
      if (!state.stacked.has(p.tokenId)) { // Don't hedge-up if already stacked
        if (await executeBuy(p.tokenId, p.conditionId, p.outcome, cfg.hedge.hedgeUpMaxUsd, `HedgeUp (${$price(p.curPrice)})`, cfg, false, p.curPrice)) {
          state.stacked.add(p.tokenId); // Mark as stacked to prevent repeat
          cycleActed.add(p.tokenId);
        }
        continue;
      }
    }
    
    // 3. HEDGE: Losing - try to RECOVER first (before giving up with stop-loss)
    // Only hedge if: losing >= triggerPct AND not already hedged AND held long enough
    // Also check: entry price below maxEntryPrice (only hedge risky positions)
    // Also check: NOT in no-hedge window (too close to market close)
    const holdMinutesForHedge = holdTime / 60;
    const inNoHedgeWindow = holdMinutesForHedge >= (24 * 60 - cfg.hedge.noHedgeWindowMinutes); // Assuming 24h markets
    
    if (cfg.hedge.enabled && !state.hedged.has(p.tokenId) && p.pnlPct <= -cfg.hedge.triggerPct && holdTime >= cfg.hedge.minHoldSeconds && !inNoHedgeWindow) {
      // Check if entry price qualifies for hedging
      if (p.avgPrice > cfg.hedge.maxEntryPrice) {
        log(`⚠️ Skip hedge | Entry ${$price(p.avgPrice)} > max ${$price(cfg.hedge.maxEntryPrice)}`);
        continue;
      }
      
      // Force liquidation for extreme losses instead of hedge
      if (p.pnlPct <= -cfg.hedge.forceLiquidationPct) {
        log(`🚨 Force liquidation | ${pct(p.pnlPct)} exceeds ${cfg.hedge.forceLiquidationPct}%`);
        if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `ForceLiq (${pct(p.pnlPct)})`, cfg, p.curPrice)) {
          state.sold.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
        continue;
      }
      
      const opp = p.outcome === "YES" ? "NO" : "YES";
      // Emergency mode: use absolute max for severe losses
      const isEmergency = p.pnlPct <= -cfg.hedge.emergencyLossPct;
      const hedgeAmt = isEmergency || cfg.hedge.allowExceedMax ? cfg.hedge.absoluteMaxUsd : cfg.hedge.maxUsd;
      const reason = isEmergency ? `EmergencyHedge (${pct(p.pnlPct)})` : `Hedge (${pct(p.pnlPct)})`;
      
      if (await executeBuy(p.tokenId, p.conditionId, opp, hedgeAmt, reason, cfg, true, p.curPrice)) {
        state.hedged.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 4. STOP-LOSS: Only applies when hedging is DISABLED
    // 
    // WHY: If hedging is enabled, stop-loss is REDUNDANT:
    //   - Hedge buys the opposite side → you now hold BOTH YES and NO
    //   - One side WILL win when market resolves → you get paid
    //   - No need to "cut losses" - the hedge guarantees recovery
    //
    // Stop-loss only makes sense as an ALTERNATIVE to hedging:
    //   - User disables hedging (HEDGING_ENABLED=false)
    //   - User wants to cut losses without buying opposite side
    //   - Pure exit strategy vs. hedge & wait strategy
    //
    if (cfg.stopLoss.enabled && !cfg.hedge.enabled && p.pnlPct <= -cfg.stopLoss.maxLossPct && holdTime >= cfg.stopLoss.minHoldSec) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `StopLoss (${pct(p.pnlPct)})`, cfg, p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 5. SCALP: In profit - take profits
    // Skip if: low price threshold set AND entry below threshold (speculative positions)
    // Skip if: near resolution AND entry was speculative (let $1 winners ride)
    const skipLowPrice = cfg.scalp.lowPriceThreshold > 0 && p.avgPrice < cfg.scalp.lowPriceThreshold;
    const skipNearResolution = p.avgPrice < 0.60 && p.curPrice >= cfg.scalp.resolutionExclusionPrice;
    
    // Check hold time for scalping
    const holdMinutes = holdTime / 60;
    const meetsMinHold = holdMinutes >= cfg.scalp.minHoldMinutes;
    const exceedsMaxHold = holdMinutes >= cfg.scalp.maxHoldMinutes;
    
    // Check for sudden spike (with time window)
    const hasSuddenSpike = cfg.scalp.suddenSpikeEnabled && detectPriceSpike(p.tokenId, p.curPrice, cfg.scalp.suddenSpikeThresholdPct, cfg.scalp.suddenSpikeWindowMinutes);
    
    // Check momentum - only scalp when momentum is fading (V1 feature)
    const momentum = getMomentum(p.tokenId);
    const momentumFading = isMomentumFading(p.tokenId);
    const shouldScalpMomentum = momentum < 0.3 || momentumFading; // Low/fading momentum = good time to exit
    
    // Scalp conditions: 
    // 1. Profit thresholds met AND min hold AND (momentum fading OR not strongly positive)
    // 2. Sudden spike (take profit immediately)
    // 3. Max hold exceeded (if profitable)
    const scalpCondition = 
      (p.pnlPct >= cfg.scalp.minProfitPct && p.gainCents >= cfg.scalp.minGainCents && meetsMinHold && shouldScalpMomentum) || 
      hasSuddenSpike || 
      (exceedsMaxHold && p.pnlPct > 0);
    
    if (cfg.scalp.enabled && !skipLowPrice && !skipNearResolution && scalpCondition) {
      const profitUsd = p.value * (p.pnlPct / 100);
      if (profitUsd >= cfg.scalp.minProfitUsd || hasSuddenSpike || exceedsMaxHold) {
        let reason: string;
        if (hasSuddenSpike) reason = `Spike (${pct(p.pnlPct)})`;
        else if (exceedsMaxHold) reason = `MaxHold (${pct(p.pnlPct)})`;
        else if (momentumFading) reason = `ScalpFade (${pct(p.pnlPct)})`;
        else reason = `Scalp (${pct(p.pnlPct)})`;
        
        if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, reason, cfg, p.curPrice)) {
          state.sold.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
        continue;
      }
    }
    
    // 6. STACK: Winning - add to winners (once per position)
    // Also check global max position limit
    const currentPositionValue = getTotalPositionValue(p.tokenId);
    if (cfg.stack.enabled && !state.stacked.has(p.tokenId) && p.gainCents >= cfg.stack.minGainCents && p.curPrice <= cfg.stack.maxPrice && currentPositionValue < cfg.maxPositionUsd) {
      const buys = await countBuys(walletAddr, p.tokenId);
      if (buys >= 2) {
        state.stacked.add(p.tokenId);
        continue;
      }
      // Limit stack size to not exceed max position
      const maxStackSize = Math.min(cfg.stack.maxUsd, cfg.maxPositionUsd - currentPositionValue);
      if (maxStackSize >= 5) {
        if (await executeBuy(p.tokenId, p.conditionId, p.outcome, maxStackSize, `Stack (${pct(p.pnlPct)})`, cfg, false, p.curPrice)) {
          state.stacked.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
      }
      continue;
    }
    
    // 7. ENDGAME: High confidence - ride to finish
    if (cfg.endgame.enabled && p.curPrice >= cfg.endgame.minPrice && p.curPrice <= cfg.endgame.maxPrice) {
      if (p.value < cfg.endgame.maxUsd * 2) {
        const addAmt = Math.min(cfg.endgame.maxUsd, cfg.endgame.maxUsd * 2 - p.value);
        if (addAmt >= 5) {
          await executeBuy(p.tokenId, p.conditionId, p.outcome, addAmt, "Endgame", cfg, false, p.curPrice);
          cycleActed.add(p.tokenId);
        }
      }
    }
  }
  
  // Arbitrage runs independently (different position pairs)
  await arbitrage(cfg);
  
  // Redeem resolved positions
  await redeem(walletAddr, cfg);
  
  // Send periodic P&L summary (every 5 minutes)
  await maybeSendSummary();
}

// ============ CONFIG ============

export function loadConfig() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  // Support both V1 (STRATEGY_PRESET) and V2 (PRESET) naming
  const preset = (process.env.STRATEGY_PRESET || process.env.PRESET || "balanced") as Preset;
  if (!PRESETS[preset]) throw new Error(`Invalid PRESET: ${preset}`);

  const cfg: Config = JSON.parse(JSON.stringify(PRESETS[preset]));
  const env = (k: string) => process.env[k];
  const envBool = (k: string) => {
    const val = env(k);
    if (!val) return undefined;
    return val === "true" || val === "1" || val === "yes";
  };
  const envNum = (k: string) => env(k) ? Number(env(k)) : undefined;
  
  // ========== GLOBAL POSITION SIZE ==========
  // V1: MAX_POSITION_USD | V2: MAX_POSITION_USD
  const maxPos = envNum("MAX_POSITION_USD") || envNum("ARB_MAX_POSITION_USD");
  if (maxPos !== undefined) {
    cfg.maxPositionUsd = maxPos;
    // Also update all strategy max sizes to respect global limit
    cfg.hedge.maxUsd = Math.min(cfg.hedge.maxUsd, maxPos);
    cfg.stack.maxUsd = Math.min(cfg.stack.maxUsd, maxPos);
    cfg.endgame.maxUsd = Math.min(cfg.endgame.maxUsd, maxPos);
    cfg.arbitrage.maxUsd = Math.min(cfg.arbitrage.maxUsd, maxPos);
  }
  
  // ========== AUTO-SELL ==========
  // V1: AUTO_SELL_ENABLED, AUTO_SELL_THRESHOLD, AUTO_SELL_MIN_HOLD_SEC
  if (envBool("AUTO_SELL_ENABLED") !== undefined) cfg.autoSell.enabled = envBool("AUTO_SELL_ENABLED")!;
  if (envNum("AUTO_SELL_THRESHOLD") !== undefined) cfg.autoSell.threshold = envNum("AUTO_SELL_THRESHOLD")!;
  if (envNum("AUTO_SELL_MIN_HOLD_SEC") !== undefined) cfg.autoSell.minHoldSec = envNum("AUTO_SELL_MIN_HOLD_SEC")!;
  
  // ========== STOP-LOSS ==========
  // V1: STOP_LOSS_ENABLED, STOP_LOSS_PCT, STOP_LOSS_MIN_HOLD_SECONDS | Also: HEDGING_TRIGGER_LOSS_PCT (alias)
  if (envBool("STOP_LOSS_ENABLED") !== undefined) cfg.stopLoss.enabled = envBool("STOP_LOSS_ENABLED")!;
  if (envNum("STOP_LOSS_PCT") !== undefined) cfg.stopLoss.maxLossPct = envNum("STOP_LOSS_PCT")!;
  if (envNum("STOP_LOSS_MIN_HOLD_SECONDS") !== undefined) cfg.stopLoss.minHoldSec = envNum("STOP_LOSS_MIN_HOLD_SECONDS")!;
  
  // ========== HEDGING ==========
  // V1: HEDGING_ENABLED, HEDGING_TRIGGER_LOSS_PCT, HEDGING_MAX_HEDGE_USD, HEDGING_ALLOW_EXCEED_MAX, HEDGING_ABSOLUTE_MAX_USD
  // V2: HEDGE_ENABLED, HEDGE_TRIGGER_PCT, HEDGE_MAX_USD
  if (envBool("HEDGING_ENABLED") !== undefined) cfg.hedge.enabled = envBool("HEDGING_ENABLED")!;
  if (envBool("HEDGE_ENABLED") !== undefined) cfg.hedge.enabled = envBool("HEDGE_ENABLED")!;
  if (envNum("HEDGING_TRIGGER_LOSS_PCT") !== undefined) cfg.hedge.triggerPct = envNum("HEDGING_TRIGGER_LOSS_PCT")!;
  if (envNum("HEDGE_TRIGGER_PCT") !== undefined) cfg.hedge.triggerPct = envNum("HEDGE_TRIGGER_PCT")!;
  if (envNum("HEDGING_MAX_HEDGE_USD") !== undefined) cfg.hedge.maxUsd = envNum("HEDGING_MAX_HEDGE_USD")!;
  if (envNum("HEDGE_MAX_USD") !== undefined) cfg.hedge.maxUsd = envNum("HEDGE_MAX_USD")!;
  if (envBool("HEDGING_ALLOW_EXCEED_MAX") !== undefined) cfg.hedge.allowExceedMax = envBool("HEDGING_ALLOW_EXCEED_MAX")!;
  if (envNum("HEDGING_ABSOLUTE_MAX_USD") !== undefined) cfg.hedge.absoluteMaxUsd = envNum("HEDGING_ABSOLUTE_MAX_USD")!;
  // HEDGING_RESERVE_PCT: % of balance to keep reserved (not spent on normal trades)
  // Hedge actions can dip into reserves, but normal trades cannot
  if (envNum("HEDGING_RESERVE_PCT") !== undefined) {
    cfg.hedge.reservePct = envNum("HEDGING_RESERVE_PCT")!;
    cfg.reservePct = envNum("HEDGING_RESERVE_PCT")!;
  }
  if (envNum("RESERVE_PCT") !== undefined) cfg.reservePct = envNum("RESERVE_PCT")!;
  
  // ========== SCALPING ==========
  // V1: SCALP_TAKE_PROFIT_ENABLED, SCALP_MIN_PROFIT_PCT, SCALP_LOW_PRICE_THRESHOLD, SCALP_MIN_PROFIT_USD
  // V2: SCALP_ENABLED, SCALP_MIN_PROFIT_PCT, SCALP_MIN_GAIN_CENTS
  if (envBool("SCALP_TAKE_PROFIT_ENABLED") !== undefined) cfg.scalp.enabled = envBool("SCALP_TAKE_PROFIT_ENABLED")!;
  if (envBool("SCALP_ENABLED") !== undefined) cfg.scalp.enabled = envBool("SCALP_ENABLED")!;
  if (envNum("SCALP_MIN_PROFIT_PCT") !== undefined) cfg.scalp.minProfitPct = envNum("SCALP_MIN_PROFIT_PCT")!;
  if (envNum("SCALP_TARGET_PROFIT_PCT") !== undefined) cfg.scalp.minProfitPct = envNum("SCALP_TARGET_PROFIT_PCT")!;
  if (envNum("SCALP_MIN_GAIN_CENTS") !== undefined) cfg.scalp.minGainCents = envNum("SCALP_MIN_GAIN_CENTS")!;
  if (envNum("SCALP_LOW_PRICE_THRESHOLD") !== undefined) cfg.scalp.lowPriceThreshold = envNum("SCALP_LOW_PRICE_THRESHOLD")!;
  if (envNum("SCALP_MIN_PROFIT_USD") !== undefined) cfg.scalp.minProfitUsd = envNum("SCALP_MIN_PROFIT_USD")!;
  
  // ========== POSITION STACKING ==========
  // V1: POSITION_STACKING_ENABLED, POSITION_STACKING_MIN_GAIN_CENTS, POSITION_STACKING_MAX_CURRENT_PRICE
  // V2: STACK_ENABLED, STACK_MIN_GAIN_CENTS, STACK_MAX_USD, STACK_MAX_PRICE
  if (envBool("POSITION_STACKING_ENABLED") !== undefined) cfg.stack.enabled = envBool("POSITION_STACKING_ENABLED")!;
  if (envBool("STACK_ENABLED") !== undefined) cfg.stack.enabled = envBool("STACK_ENABLED")!;
  if (envNum("POSITION_STACKING_MIN_GAIN_CENTS") !== undefined) cfg.stack.minGainCents = envNum("POSITION_STACKING_MIN_GAIN_CENTS")!;
  if (envNum("STACK_MIN_GAIN_CENTS") !== undefined) cfg.stack.minGainCents = envNum("STACK_MIN_GAIN_CENTS")!;
  if (envNum("STACK_MAX_USD") !== undefined) cfg.stack.maxUsd = envNum("STACK_MAX_USD")!;
  if (envNum("POSITION_STACKING_MAX_CURRENT_PRICE") !== undefined) cfg.stack.maxPrice = envNum("POSITION_STACKING_MAX_CURRENT_PRICE")!;
  if (envNum("STACK_MAX_PRICE") !== undefined) cfg.stack.maxPrice = envNum("STACK_MAX_PRICE")!;
  
  // ========== ENDGAME ==========
  if (envBool("ENDGAME_ENABLED") !== undefined) cfg.endgame.enabled = envBool("ENDGAME_ENABLED")!;
  if (envNum("ENDGAME_MIN_PRICE") !== undefined) cfg.endgame.minPrice = envNum("ENDGAME_MIN_PRICE")!;
  if (envNum("ENDGAME_MAX_PRICE") !== undefined) cfg.endgame.maxPrice = envNum("ENDGAME_MAX_PRICE")!;
  if (envNum("ENDGAME_MAX_USD") !== undefined) cfg.endgame.maxUsd = envNum("ENDGAME_MAX_USD")!;
  
  // ========== AUTO-REDEEM ==========
  // V1: AUTO_REDEEM_ENABLED, AUTO_REDEEM_MIN_POSITION_USD, AUTO_REDEEM_CHECK_INTERVAL_MS
  // V2: REDEEM_ENABLED, REDEEM_INTERVAL_MIN
  if (envBool("AUTO_REDEEM_ENABLED") !== undefined) cfg.redeem.enabled = envBool("AUTO_REDEEM_ENABLED")!;
  if (envBool("REDEEM_ENABLED") !== undefined) cfg.redeem.enabled = envBool("REDEEM_ENABLED")!;
  if (envNum("REDEEM_INTERVAL_MIN") !== undefined) cfg.redeem.intervalMin = envNum("REDEEM_INTERVAL_MIN")!;
  if (envNum("AUTO_REDEEM_CHECK_INTERVAL_MS") !== undefined) cfg.redeem.intervalMin = Math.round(envNum("AUTO_REDEEM_CHECK_INTERVAL_MS")! / 60000);
  if (envNum("AUTO_REDEEM_MIN_POSITION_USD") !== undefined) cfg.redeem.minPositionUsd = envNum("AUTO_REDEEM_MIN_POSITION_USD")!;
  
  // ========== COPY TRADING ==========
  // V1: TARGET_ADDRESSES, TRADE_MULTIPLIER, MIN_TRADE_SIZE_USD, MIN_BUY_PRICE
  // V2: COPY_ADDRESSES, COPY_MULTIPLIER, COPY_MIN_USD, COPY_MAX_USD, COPY_MIN_BUY_PRICE
  // Also: MONITOR_ADDRESSES
  const copyAddrs = env("COPY_ADDRESSES") || env("TARGET_ADDRESSES") || env("MONITOR_ADDRESSES");
  if (copyAddrs) {
    cfg.copy.enabled = true;
    cfg.copy.addresses = copyAddrs.split(",").map(a => a.trim().toLowerCase()).filter(Boolean);
  }
  if (envNum("COPY_MULTIPLIER") !== undefined) cfg.copy.multiplier = envNum("COPY_MULTIPLIER")!;
  if (envNum("TRADE_MULTIPLIER") !== undefined) cfg.copy.multiplier = envNum("TRADE_MULTIPLIER")!;
  if (envNum("COPY_MIN_USD") !== undefined) cfg.copy.minUsd = envNum("COPY_MIN_USD")!;
  if (envNum("MIN_TRADE_SIZE_USD") !== undefined) cfg.copy.minUsd = envNum("MIN_TRADE_SIZE_USD")!;
  if (envNum("COPY_MAX_USD") !== undefined) cfg.copy.maxUsd = envNum("COPY_MAX_USD")!;
  if (envNum("COPY_MIN_BUY_PRICE") !== undefined) cfg.copy.minBuyPrice = envNum("COPY_MIN_BUY_PRICE")!;
  if (envNum("MIN_BUY_PRICE") !== undefined) cfg.copy.minBuyPrice = envNum("MIN_BUY_PRICE")!;
  
  // ========== SELL SIGNAL MONITOR ==========
  // When tracked trader sells, check our position and take protective action
  // V1: SELL_SIGNAL_MIN_LOSS_PCT_TO_ACT, SELL_SIGNAL_PROFIT_THRESHOLD_TO_SKIP, SELL_SIGNAL_SEVERE_LOSS_PCT
  // V2: SELL_SIGNAL_ENABLED, SELL_SIGNAL_MIN_LOSS_PCT, SELL_SIGNAL_PROFIT_SKIP_PCT, SELL_SIGNAL_SEVERE_PCT
  if (envBool("SELL_SIGNAL_ENABLED") !== undefined) cfg.sellSignal.enabled = envBool("SELL_SIGNAL_ENABLED")!;
  if (envNum("SELL_SIGNAL_MIN_LOSS_PCT") !== undefined) cfg.sellSignal.minLossPctToAct = envNum("SELL_SIGNAL_MIN_LOSS_PCT")!;
  if (envNum("SELL_SIGNAL_MIN_LOSS_PCT_TO_ACT") !== undefined) cfg.sellSignal.minLossPctToAct = envNum("SELL_SIGNAL_MIN_LOSS_PCT_TO_ACT")!;
  if (envNum("SELL_SIGNAL_PROFIT_SKIP_PCT") !== undefined) cfg.sellSignal.profitThresholdToSkip = envNum("SELL_SIGNAL_PROFIT_SKIP_PCT")!;
  if (envNum("SELL_SIGNAL_PROFIT_THRESHOLD_TO_SKIP") !== undefined) cfg.sellSignal.profitThresholdToSkip = envNum("SELL_SIGNAL_PROFIT_THRESHOLD_TO_SKIP")!;
  if (envNum("SELL_SIGNAL_SEVERE_PCT") !== undefined) cfg.sellSignal.severeLossPct = envNum("SELL_SIGNAL_SEVERE_PCT")!;
  if (envNum("SELL_SIGNAL_SEVERE_LOSS_PCT") !== undefined) cfg.sellSignal.severeLossPct = envNum("SELL_SIGNAL_SEVERE_LOSS_PCT")!;
  if (envNum("SELL_SIGNAL_COOLDOWN_MS") !== undefined) cfg.sellSignal.cooldownMs = envNum("SELL_SIGNAL_COOLDOWN_MS")!;
  
  // ========== ARBITRAGE ==========
  // V1: ARB_ENABLED, ARB_DRY_RUN, ARB_MIN_EDGE_BPS, ARB_MIN_BUY_PRICE
  if (envBool("ARB_ENABLED") !== undefined) cfg.arbitrage.enabled = envBool("ARB_ENABLED")!;
  if (envNum("ARB_MAX_USD") !== undefined) cfg.arbitrage.maxUsd = envNum("ARB_MAX_USD")!;
  if (envNum("ARB_MIN_EDGE_BPS") !== undefined) cfg.arbitrage.minEdgeBps = envNum("ARB_MIN_EDGE_BPS")!;
  if (envNum("ARB_MIN_BUY_PRICE") !== undefined) cfg.arbitrage.minBuyPrice = envNum("ARB_MIN_BUY_PRICE")!;

  // ========== LIVE TRADING ==========
  // V1: ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
  // V2: LIVE_TRADING=I_UNDERSTAND_THE_RISKS or LIVE_TRADING=true
  const liveVal = env("LIVE_TRADING") || env("ARB_LIVE_TRADING");
  const isLive = liveVal === "I_UNDERSTAND_THE_RISKS" || liveVal === "true" || liveVal === "1";

  // ========== LEADERBOARD ==========
  // V1: LEADERBOARD_LIMIT
  const leaderboardLimit = envNum("LEADERBOARD_LIMIT") || 20;

  return {
    privateKey, rpcUrl, preset, config: cfg,
    intervalMs: envNum("INTERVAL_MS") || (envNum("FETCH_INTERVAL") ? envNum("FETCH_INTERVAL")! * 1000 : 5000),
    liveTrading: isLive,
    leaderboardLimit,
    telegram: (env("TELEGRAM_TOKEN") || env("TELEGRAM_BOT_TOKEN")) && (env("TELEGRAM_CHAT") || env("TELEGRAM_CHAT_ID"))
      ? { token: (env("TELEGRAM_TOKEN") || env("TELEGRAM_BOT_TOKEN"))!, chatId: (env("TELEGRAM_CHAT") || env("TELEGRAM_CHAT_ID"))! } : undefined,
  };
}

// ============ STARTUP ============

export async function startV2() {
  log("=== Polymarket Bot V2 ===");
  
  // Create logger compatible with V1 utilities
  const logger = {
    info: (msg: string) => log(msg),
    warn: (msg: string) => log(`⚠️ ${msg}`),
    error: (msg: string) => log(`❌ ${msg}`),
    debug: () => {},
  };
  
  // ============ VPN SETUP (from V1 main.ts lines 48-59) ============
  // VPN is required for trading from geoblocked regions
  const vpnEnabled = process.env.VPN_ENABLED !== "false"; // Default: true
  
  if (vpnEnabled) {
    try {
      const { capturePreVpnRouting, setupRpcVpnBypass } = await import("../utils/vpn-rpc-bypass.util");
      const { startOpenvpn } = await import("../utils/openvpn.util");
      const { startWireguard } = await import("../utils/wireguard.util");
      
      // Capture default gateway BEFORE VPN starts (needed for RPC bypass)
      log("🔒 Setting up VPN...");
      const preVpnRouting = await capturePreVpnRouting();
      
      // Start VPN (OpenVPN takes priority over WireGuard)
      const openvpnStarted = await startOpenvpn(logger as any);
      if (openvpnStarted) {
        state.vpnActive = true;
        log("✅ OpenVPN connected");
      } else {
        const wgStarted = await startWireguard(logger as any);
        if (wgStarted) {
          state.vpnActive = true;
          log("✅ WireGuard connected");
        }
      }
      
      // Setup RPC VPN bypass AFTER VPN starts
      // By default, RPC traffic bypasses VPN for better speed
      if (process.env.VPN_BYPASS_RPC !== "false") {
        await setupRpcVpnBypass(logger as any, preVpnRouting.gateway, preVpnRouting.iface);
        log("✅ RPC VPN bypass configured");
      }
      
      if (!state.vpnActive) {
        log("⚠️ VPN failed to start - you may be geoblocked!");
        await alertStatus("⚠️ VPN failed to start - trading may fail due to geoblocking");
      }
    } catch (e: any) {
      log(`⚠️ VPN setup error: ${e.message}`);
      log("⚠️ Proceeding without VPN - you may be geoblocked!");
    }
  } else {
    log("ℹ️ VPN disabled via VPN_ENABLED=false");
  }
  
  const settings = loadConfig();
  
  // If no copy addresses specified, fetch from leaderboard automatically
  if (!settings.config.copy.addresses.length) {
    const leaderboardAddrs = await fetchLeaderboard(settings.leaderboardLimit);
    if (leaderboardAddrs.length > 0) {
      settings.config.copy.enabled = true;
      settings.config.copy.addresses = leaderboardAddrs;
    }
  }
  
  // ============ AUTHENTICATION (same as V1 main.ts lines 86-98) ============
  log("🔐 Authenticating with Polymarket...");
  
  const auth = createPolymarketAuthFromEnv(logger as any);
  const authResult = await auth.authenticate();
  
  if (!authResult.success) {
    log(`❌ Authentication failed: ${authResult.error}`);
    throw new Error(`Cannot proceed without valid credentials: ${authResult.error}`);
  }
  
  log("✅ Authentication successful");
  
  // Get authenticated CLOB client (same as V1 main.ts line 98)
  const clobClient = await auth.getClobClient();
  const addr = auth.getAddress().toLowerCase();
  
  state.wallet = clobClient.wallet;
  state.provider = clobClient.wallet.provider as JsonRpcProvider;
  state.clobClient = clobClient;
  state.authOk = true;
  state.proxyAddress = await fetchProxy(addr);
  state.telegram = settings.telegram;
  state.liveTrading = settings.liveTrading;

  // ============ PREFLIGHT CHECKS (from V1 main.ts lines 107-118) ============
  try {
    const { ensureTradingReady } = await import("../polymarket/preflight");
    log("🔍 Running preflight checks...");
    const tradingReady = await ensureTradingReady({
      client: clobClient,
      logger: logger as any,
      privateKey: settings.privateKey,
      configuredPublicKey: state.proxyAddress,
      rpcUrl: settings.rpcUrl,
      detectOnly: false,
      clobCredsComplete: true,
      clobDeriveEnabled: true,
      collateralTokenDecimals: 6,
    });
    
    if (tradingReady.detectOnly) {
      log("⚠️ Running in detect-only mode - orders will be simulated");
      state.liveTrading = false;
    }
  } catch (e) {
    log("⚠️ Preflight checks not available - proceeding without validation");
  }

  // Fetch initial balance
  await fetchBalance();

  log(`Preset: ${settings.preset}`);
  log(`Wallet: ${addr.slice(0, 10)}...`);
  log(`Balance: ${$(state.balance)} (${settings.config.reservePct}% reserved)`);
  log(`Trading: ${state.liveTrading ? "🟢 LIVE" : "🔸 SIMULATED"}`);
  if (state.proxyAddress) log(`Proxy: ${state.proxyAddress.slice(0, 10)}...`);
  if (settings.config.copy.enabled) log(`👀 Copying ${settings.config.copy.addresses.length} trader(s)`);
  
  await alertStatus(`Bot Started | ${settings.preset} | ${state.liveTrading ? "LIVE" : "SIM"} | ${$(state.balance)}`);

  // ============ MAIN LOOP WITH IN-FLIGHT GUARD ============
  let cycleRunning = false;
  
  const runCycle = async () => {
    if (cycleRunning) {
      log("⏳ Skipping cycle - previous still running");
      return;
    }
    cycleRunning = true;
    try {
      await cycle(addr, settings.config);
    } catch (e) {
      log(`❌ Cycle error: ${e}`);
    } finally {
      cycleRunning = false;
    }
  };

  await runCycle();
  setInterval(runCycle, settings.intervalMs);

  process.on("SIGINT", async () => {
    await alertStatus("Bot Stopped | Shutdown");
    process.exit(0);
  });
}

if (require.main === module) startV2();
