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
}

interface Config {
  autoSell: { enabled: boolean; threshold: number; minHoldSec: number };
  stopLoss: { enabled: boolean; maxLossPct: number; minHoldSec: number };
  hedge: { enabled: boolean; triggerPct: number; maxUsd: number; allowExceedMax: boolean; absoluteMaxUsd: number; reservePct: number };
  scalp: { enabled: boolean; minProfitPct: number; minGainCents: number; lowPriceThreshold: number; minProfitUsd: number };
  stack: { enabled: boolean; minGainCents: number; maxUsd: number; maxPrice: number };
  endgame: { enabled: boolean; minPrice: number; maxPrice: number; maxUsd: number };
  redeem: { enabled: boolean; intervalMin: number; minPositionUsd: number };
  copy: { 
    enabled: boolean; 
    addresses: string[]; 
    multiplier: number; 
    minUsd: number; 
    maxUsd: number; 
    minBuyPrice: number;  // MIN_BUY_PRICE - don't copy BUYs below this (default: 0.50 = 50¢)
  };
  sellSignal: {
    enabled: boolean;
    minLossPctToAct: number;      // Only act if losing >= this % (default: 15)
    profitThresholdToSkip: number; // Skip if profit >= this % (default: 20, "knee deep in positive")
    severeLossPct: number;         // Trigger stop-loss if loss >= this % (default: 40)
    cooldownMs: number;            // Cooldown per position (default: 60000ms)
  };
  arbitrage: { enabled: boolean; maxUsd: number; minEdgeBps: number; minBuyPrice: number };
  maxPositionUsd: number; // Global position size limit
  // Reserve system - keep % of balance for hedging/emergencies
  reservePct: number; // Percentage of balance to reserve (e.g., 20 = keep 20% reserved)
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
}

// ============ PRESETS ============

/**
 * PRESETS - Match V1 presets exactly
 * Values sourced from src/config/presets.ts STRATEGY_PRESETS
 */
const PRESETS: Record<Preset, Config> = {
  conservative: {
    // AUTO_SELL_THRESHOLD: 0.999, AUTO_SELL_MIN_HOLD_SEC: 60
    autoSell: { enabled: true, threshold: 0.999, minHoldSec: 60 },
    // STOP_LOSS_MIN_HOLD_SECONDS: 120 (conservative waits 2 min)
    stopLoss: { enabled: true, maxLossPct: 20, minHoldSec: 120 },
    // HEDGING_TRIGGER_LOSS_PCT: 20, HEDGING_MAX_HEDGE_USD: 10, HEDGING_RESERVE_PCT: 25
    hedge: { enabled: true, triggerPct: 20, maxUsd: 10, allowExceedMax: false, absoluteMaxUsd: 25, reservePct: 25 },
    // SCALP_MIN_PROFIT_PCT: 8.0, SCALP_MIN_PROFIT_USD: 2.0
    scalp: { enabled: true, minProfitPct: 8, minGainCents: 8, lowPriceThreshold: 0, minProfitUsd: 2.0 },
    // POSITION_STACKING_MIN_GAIN_CENTS: 25, MAX_CURRENT_PRICE: 0.90
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.90 },
    // ENDGAME_MIN_PRICE: 0.985, ENDGAME_MAX_PRICE: 0.995
    endgame: { enabled: true, minPrice: 0.985, maxPrice: 0.995, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0 },
    // MIN_TRADE_SIZE_USD: 50, TRADE_MULTIPLIER: 0.15, MIN_BUY_PRICE: 0.50
    copy: { enabled: false, addresses: [], multiplier: 0.15, minUsd: 50, maxUsd: 50, minBuyPrice: 0.50 },
    // Sell signal: V1 defaults from sell-signal-monitor.service.ts
    sellSignal: { enabled: true, minLossPctToAct: 15, profitThresholdToSkip: 20, severeLossPct: 40, cooldownMs: 60000 },
    // ARB_MIN_EDGE_BPS: 300, ARB_MIN_BUY_PRICE: 0.05
    arbitrage: { enabled: true, maxUsd: 15, minEdgeBps: 300, minBuyPrice: 0.05 },
    // MAX_POSITION_USD: 15
    maxPositionUsd: 15,
    // HEDGING_RESERVE_PCT: 25
    reservePct: 25,
  },
  balanced: {
    // AUTO_SELL_THRESHOLD: 0.999, AUTO_SELL_MIN_HOLD_SEC: 60
    autoSell: { enabled: true, threshold: 0.999, minHoldSec: 60 },
    // STOP_LOSS_MIN_HOLD_SECONDS: 60
    stopLoss: { enabled: true, maxLossPct: 25, minHoldSec: 60 },
    // HEDGING_TRIGGER_LOSS_PCT: 20, HEDGING_MAX_HEDGE_USD: 15, HEDGING_RESERVE_PCT: 20
    hedge: { enabled: true, triggerPct: 20, maxUsd: 15, allowExceedMax: false, absoluteMaxUsd: 50, reservePct: 20 },
    // SCALP_MIN_PROFIT_PCT: 5.0, SCALP_MIN_PROFIT_USD: 1.0
    scalp: { enabled: true, minProfitPct: 5, minGainCents: 5, lowPriceThreshold: 0, minProfitUsd: 1.0 },
    // POSITION_STACKING_MIN_GAIN_CENTS: 20, MAX_CURRENT_PRICE: 0.95
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    // ENDGAME_MIN_PRICE: 0.985, ENDGAME_MAX_PRICE: 0.995
    endgame: { enabled: true, minPrice: 0.985, maxPrice: 0.995, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0 },
    // MIN_TRADE_SIZE_USD: 1, TRADE_MULTIPLIER: 0.15, MIN_BUY_PRICE: 0.50
    copy: { enabled: false, addresses: [], multiplier: 0.15, minUsd: 1, maxUsd: 100, minBuyPrice: 0.50 },
    // Sell signal: V1 defaults from sell-signal-monitor.service.ts
    sellSignal: { enabled: true, minLossPctToAct: 15, profitThresholdToSkip: 20, severeLossPct: 40, cooldownMs: 60000 },
    // ARB_MIN_EDGE_BPS: 200, ARB_MIN_BUY_PRICE: 0.05
    arbitrage: { enabled: true, maxUsd: 25, minEdgeBps: 200, minBuyPrice: 0.05 },
    // MAX_POSITION_USD: 25
    maxPositionUsd: 25,
    // HEDGING_RESERVE_PCT: 20
    reservePct: 20,
  },
  aggressive: {
    // AUTO_SELL_THRESHOLD: 0.999, AUTO_SELL_MIN_HOLD_SEC: 30
    autoSell: { enabled: true, threshold: 0.999, minHoldSec: 30 },
    // STOP_LOSS_MIN_HOLD_SECONDS: 30
    stopLoss: { enabled: true, maxLossPct: 35, minHoldSec: 30 },
    // HEDGING_TRIGGER_LOSS_PCT: 20, HEDGING_MAX_HEDGE_USD: 50, HEDGING_RESERVE_PCT: 15
    hedge: { enabled: true, triggerPct: 20, maxUsd: 50, allowExceedMax: true, absoluteMaxUsd: 100, reservePct: 15 },
    // SCALP_MIN_PROFIT_PCT: 4.0, SCALP_MIN_PROFIT_USD: 0.5
    scalp: { enabled: true, minProfitPct: 4, minGainCents: 3, lowPriceThreshold: 0, minProfitUsd: 0.5 },
    // POSITION_STACKING_MIN_GAIN_CENTS: 15, MAX_CURRENT_PRICE: 0.95
    stack: { enabled: true, minGainCents: 15, maxUsd: 100, maxPrice: 0.95 },
    // ENDGAME_MIN_PRICE: 0.85, ENDGAME_MAX_PRICE: 0.94
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.94, maxUsd: 100 },
    redeem: { enabled: true, intervalMin: 10, minPositionUsd: 0 },
    // MIN_TRADE_SIZE_USD: 5, MIN_BUY_PRICE: 0.50 (aggressive keeps 50¢ min)
    copy: { enabled: false, addresses: [], multiplier: 0.15, minUsd: 5, maxUsd: 200, minBuyPrice: 0.50 },
    // Sell signal: V1 defaults from sell-signal-monitor.service.ts
    sellSignal: { enabled: true, minLossPctToAct: 15, profitThresholdToSkip: 20, severeLossPct: 40, cooldownMs: 60000 },
    // ARB_MIN_EDGE_BPS: 200, ARB_MIN_BUY_PRICE: 0.05 (arb can go lower)
    arbitrage: { enabled: true, maxUsd: 100, minEdgeBps: 200, minBuyPrice: 0.05 },
    // MAX_POSITION_USD: 100
    maxPositionUsd: 100,
    // HEDGING_RESERVE_PCT: 15
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
  balance: 0, // USDC balance
  stacked: new Set<string>(),
  hedged: new Set<string>(),
  sold: new Set<string>(),
  copied: new Set<string>(),
  positionAcquiredAt: new Map<string, number>(), // tokenId -> timestamp when acquired
  sellSignalCooldowns: new Map<string, number>(), // tokenId -> cooldown expiry timestamp
  telegram: undefined as { token: string; chatId: string } | undefined,
  proxyAddress: undefined as string | undefined,
  copyLastCheck: new Map<string, number>(),
  clobClient: undefined as (ClobClient & { wallet: Wallet }) | undefined,
  wallet: undefined as Wallet | undefined,
  provider: undefined as JsonRpcProvider | undefined,
  liveTrading: false,
  authOk: false, // Track if CLOB authentication succeeded
};

// ============ LOGGING ============

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ============ ALERTS ============

/**
 * Send clean alerts for Telegram
 * Format: ACTION | RESULT | DETAILS
 * Example: "SELL ✅ | AutoSell | YES $25.00 @ 99¢"
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
    }).catch(() => {});
  }
}

/** Send startup/shutdown alerts */
async function alertStatus(msg: string) {
  log(`📢 ${msg}`);
  if (state.telegram) {
    await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
      chat_id: state.telegram.chatId, 
      text: `🤖 ${msg}`,
      parse_mode: "Markdown",
    }).catch(() => {});
  }
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
    return (data || []).map((a: any) => ({
      address, conditionId: a.conditionId, tokenId: a.asset,
      outcome: a.outcomeIndex === 0 ? "YES" : "NO",
      side: a.side?.toUpperCase() === "BUY" ? "BUY" as const : "SELL" as const,
      price: Number(a.price) || 0, usdSize: Number(a.usdcSize) || 0,
      timestamp: Number(a.timestamp) || 0,
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
 * Get available balance after reserves
 * Reserves are kept for hedging and emergencies
 */
function getAvailableBalance(cfg: Config): number {
  const reserved = state.balance * (cfg.reservePct / 100);
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
  // Normal trades must respect reserve
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
async function executeSell(tokenId: string, conditionId: string, outcome: string, sizeUsd: number, reason: string, curPrice?: number): Promise<boolean> {
  const priceStr = curPrice ? ` @ ${$price(curPrice)}` : "";
  
  if (!state.liveTrading) {
    log(`🔸 SELL [SIM] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
    return true;
  }
  
  if (!state.clobClient || !state.wallet) {
    log(`❌ SELL | ${reason} | No CLOB client`);
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
      await alert("SELL", `${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`, true);
      invalidate();
      return true;
    }
    await alert("SELL", `${reason} | ${outcome} | ${result.reason || "failed"}`, false);
    return false;
  } catch (e: any) {
    await alert("SELL", `${reason} | ${outcome} | ${e.message?.slice(0, 30)}`, false);
    return false;
  }
}

/**
 * Execute a BUY order
 * Alert format: "BUY ✅ | {reason} | {outcome} {amount} @ {price}"
 */
async function executeBuy(tokenId: string, conditionId: string, outcome: string, sizeUsd: number, reason: string, cfg: Config, allowReserve = false, price?: number): Promise<boolean> {
  const priceStr = price ? ` @ ${$price(price)}` : "";
  
  // Check reserves before buying (hedging can dip into reserves)
  if (!canSpend(sizeUsd, cfg, allowReserve)) {
    const avail = allowReserve ? state.balance : getAvailableBalance(cfg);
    log(`⚠️ BUY | ${reason} | Insufficient (${$(sizeUsd)} > ${$(avail)} avail)`);
    return false;
  }

  if (!state.liveTrading) {
    log(`🔸 BUY [SIM] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
    return true;
  }
  
  if (!state.clobClient || !state.wallet) {
    log(`❌ BUY | ${reason} | No CLOB client`);
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
      await alert("BUY", `${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`, true);
      invalidate();
      return true;
    }
    await alert("BUY", `${reason} | ${outcome} | ${result.reason || "failed"}`, false);
    return false;
  } catch (e: any) {
    await alert("BUY", `${reason} | ${outcome} | ${e.message?.slice(0, 30)}`, false);
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
 */
async function copyTrades(cfg: Config) {
  if (!cfg.copy.enabled || !cfg.copy.addresses.length) return;

  for (const addr of cfg.copy.addresses) {
    const activities = await fetchActivity(addr);
    const lastCheck = state.copyLastCheck.get(addr) || 0;
    
    for (const signal of activities) {
      if (signal.timestamp <= lastCheck) continue;
      const key = `${signal.tokenId}-${signal.timestamp}`;
      if (state.copied.has(key)) continue;
      if (signal.side !== "BUY") continue; // Only copy buys (sells handled by sellSignalProtection)
      
      // MIN_BUY_PRICE check - don't buy positions below threshold (default $0.50)
      // This prevents copying into likely loser positions
      if (signal.price < cfg.copy.minBuyPrice) {
        log(`🚫 Copy skip | ${$price(signal.price)} < ${$price(cfg.copy.minBuyPrice)} min`);
        state.copied.add(key);
        continue;
      }
      
      let copyUsd = signal.usdSize * cfg.copy.multiplier;
      copyUsd = Math.max(cfg.copy.minUsd, Math.min(cfg.copy.maxUsd, copyUsd));
      
      const existing = state.positions.find(p => p.tokenId === signal.tokenId);
      if (existing && existing.value > cfg.copy.maxUsd) {
        state.copied.add(key);
        continue;
      }
      
      log(`👀 Copy | ${addr.slice(0,8)}... | ${signal.outcome} ${$(copyUsd)} @ ${$price(signal.price)}`);
      // Copy trades respect reserves (normal trade)
      await executeBuy(signal.tokenId, signal.conditionId, signal.outcome, copyUsd, "Copy", cfg, false, signal.price);
      state.copied.add(key);
    }
    state.copyLastCheck.set(addr, Math.floor(Date.now() / 1000));
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

// ============ SELL SIGNAL PROTECTION ============

/**
 * Sell Signal Monitor (from V1 sell-signal-monitor.service.ts)
 * 
 * When a tracked trader SELLS a position we also hold:
 * 1. ALERT us (log + telegram) - this is the main purpose
 * 2. Check if WE are losing on this position
 * 3. If profitable (>= profitThresholdToSkip) - ignore, we're "knee deep in positive"
 * 4. If small loss (< minLossPctToAct) - just alert, no action
 * 5. If moderate loss (minLossPctToAct to severeLossPct) - HEDGE (buy opposite)
 * 6. If severe loss (>= severeLossPct) - STOP-LOSS (sell immediately)
 * 7. Cooldown prevents repeated actions on same position
 * 
 * This is NOT copying their sell - it's monitoring for warning signs.
 */
async function sellSignalProtection(cfg: Config) {
  if (!cfg.sellSignal.enabled || !cfg.copy.addresses.length) return;
  
  for (const addr of cfg.copy.addresses) {
    const activities = await fetchActivity(addr);
    
    for (const signal of activities) {
      if (signal.side !== "SELL") continue;
      
      // Do we hold this position?
      const ourPos = state.positions.find(p => p.tokenId === signal.tokenId);
      if (!ourPos) continue;
      
      // Check cooldown
      const now = Date.now();
      const cooldownExpiry = state.sellSignalCooldowns.get(ourPos.tokenId);
      if (cooldownExpiry && now < cooldownExpiry) continue;
      
      const pnlPct = ourPos.pnlPct;
      const lossPct = Math.abs(pnlPct);
      
      // If profitable >= threshold, we're "knee deep in positive" - ignore
      if (pnlPct >= cfg.sellSignal.profitThresholdToSkip) {
        log(`📊 SellSignal | Trader sold but we're ${pct(pnlPct)} - holding`);
        continue;
      }
      
      // If not losing enough, just alert (no action)
      if (pnlPct >= 0 || lossPct < cfg.sellSignal.minLossPctToAct) {
        log(`📊 SellSignal | Trader sold, we're ${pct(pnlPct)} - monitoring`);
        continue;
      }
      
      // Set cooldown
      state.sellSignalCooldowns.set(ourPos.tokenId, now + cfg.sellSignal.cooldownMs);
      
      // SEVERE LOSS: Stop-loss (sell immediately)
      if (lossPct >= cfg.sellSignal.severeLossPct) {
        await alert("⚠️ SELL SIGNAL", `Trader sold | We're ${pct(-lossPct)} | STOP-LOSS`, true);
        if (await executeSell(ourPos.tokenId, ourPos.conditionId, ourPos.outcome, ourPos.value, "SellSignal-StopLoss", ourPos.curPrice)) {
          state.sold.add(ourPos.tokenId);
        }
        continue;
      }
      
      // MODERATE LOSS: Hedge (buy opposite side)
      if (!state.hedged.has(ourPos.tokenId)) {
        await alert("⚠️ SELL SIGNAL", `Trader sold | We're ${pct(-lossPct)} | HEDGE`, true);
        const opp = ourPos.outcome === "YES" ? "NO" : "YES";
        const hedgeAmt = ourPos.value * 0.5;
        // Sell signal hedge CAN dip into reserves (protective action)
        if (await executeBuy(ourPos.tokenId, ourPos.conditionId, opp, hedgeAmt, "SellSignal-Hedge", cfg, true, ourPos.curPrice)) {
          state.hedged.add(ourPos.tokenId);
        }
      }
    }
  }
}

// ============ MAIN CYCLE ============

/**
 * CONFLICT RESOLUTION:
 * Each position gets ONE action per cycle. Priority order:
 * 1. AutoSell (near $1) - highest priority, guaranteed profit
 * 2. StopLoss (losing badly) - protect capital
 * 3. Scalp (in profit) - take profits
 * 4. Hedge (losing but recoverable) - protect position
 * 5. Stack (winning) - add to winners
 * 6. Endgame (high confidence) - ride to finish
 * 
 * Once acted, position is skipped by all subsequent strategies in that cycle.
 */
async function cycle(walletAddr: string, cfg: Config) {
  // Track positions acted on THIS cycle (reset each cycle)
  const cycleActed = new Set<string>();
  
  await copyTrades(cfg);
  await sellSignalProtection(cfg);
  
  const positions = await fetchPositions(state.proxyAddress || walletAddr);
  if (!positions.length) {
    await redeem(walletAddr, cfg);
    return;
  }
  
  // Process each position ONCE based on priority
  for (const p of positions) {
    // Skip if already acted on (sold/hedged permanently)
    if (state.sold.has(p.tokenId)) continue;
    
    // 1. AUTO-SELL: Near $1 - guaranteed profit
    if (cfg.autoSell.enabled && p.curPrice >= cfg.autoSell.threshold) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "AutoSell", p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue; // Move to next position
    }
    
    // 2. STOP-LOSS: Losing badly - protect capital
    if (cfg.stopLoss.enabled && p.pnlPct <= -cfg.stopLoss.maxLossPct) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `StopLoss (${pct(p.pnlPct)})`, p.curPrice)) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 3. SCALP: In profit - take profits (skip low price if threshold set)
    const skipLowPrice = cfg.scalp.lowPriceThreshold > 0 && p.avgPrice < cfg.scalp.lowPriceThreshold;
    if (cfg.scalp.enabled && !skipLowPrice && p.pnlPct >= cfg.scalp.minProfitPct && p.gainCents >= cfg.scalp.minGainCents) {
      // Check min USD profit if configured
      const profitUsd = p.value * (p.pnlPct / 100);
      if (profitUsd >= cfg.scalp.minProfitUsd) {
        if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `Scalp (${pct(p.pnlPct)})`, p.curPrice)) {
          state.sold.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
        continue;
      }
    }
    
    // 4. HEDGE: Losing but recoverable - don't hedge if already hedged
    if (cfg.hedge.enabled && !state.hedged.has(p.tokenId) && p.pnlPct <= -cfg.hedge.triggerPct) {
      const opp = p.outcome === "YES" ? "NO" : "YES";
      const hedgeAmt = cfg.hedge.allowExceedMax ? cfg.hedge.absoluteMaxUsd : cfg.hedge.maxUsd;
      if (await executeBuy(p.tokenId, p.conditionId, opp, hedgeAmt, `Hedge (${pct(p.pnlPct)})`, cfg, true, p.curPrice)) {
        state.hedged.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 5. STACK: Winning - add to winners (once per position)
    if (cfg.stack.enabled && !state.stacked.has(p.tokenId) && p.gainCents >= cfg.stack.minGainCents && p.curPrice <= cfg.stack.maxPrice) {
      const buys = await countBuys(walletAddr, p.tokenId);
      if (buys >= 2) {
        state.stacked.add(p.tokenId);
        continue;
      }
      if (await executeBuy(p.tokenId, p.conditionId, p.outcome, cfg.stack.maxUsd, `Stack (${pct(p.pnlPct)})`, cfg, false, p.curPrice)) {
        state.stacked.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }
    
    // 6. ENDGAME: High confidence - ride to finish
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
  
  const settings = loadConfig();
  
  // If no copy addresses specified, fetch from leaderboard automatically
  if (!settings.config.copy.addresses.length) {
    const leaderboardAddrs = await fetchLeaderboard(settings.leaderboardLimit);
    if (leaderboardAddrs.length > 0) {
      settings.config.copy.enabled = true;
      settings.config.copy.addresses = leaderboardAddrs;
    }
  }
  
  // Initialize CLOB client using EXACT same method as V1
  // Uses createPolymarketAuthFromEnv which handles:
  // - PRIVATE_KEY, RPC_URL
  // - Optional: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE (pre-configured)
  // - Optional: POLYMARKET_SIGNATURE_TYPE (0=EOA, 1=Proxy)
  // - Auto derives credentials if not provided
  log("🔐 Authenticating with Polymarket...");
  
  // Create a minimal logger for auth
  const authLogger = {
    info: (msg: string) => log(msg),
    warn: (msg: string) => log(`⚠️ ${msg}`),
    error: (msg: string) => log(`❌ ${msg}`),
    debug: () => {}, // Suppress debug spam
  };
  
  const auth = createPolymarketAuthFromEnv(authLogger as any);
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
  state.authOk = true; // Auth succeeded
  state.proxyAddress = await fetchProxy(addr);
  state.telegram = settings.telegram;
  state.liveTrading = settings.liveTrading;

  // Fetch initial balance
  await fetchBalance();

  log(`Preset: ${settings.preset}`);
  log(`Wallet: ${addr.slice(0, 10)}...`);
  log(`Balance: ${$(state.balance)} (${settings.config.reservePct}% reserved)`);
  log(`Trading: ${state.liveTrading ? "🟢 LIVE" : "🔸 SIMULATED"}`);
  if (state.proxyAddress) log(`Proxy: ${state.proxyAddress.slice(0, 10)}...`);
  if (settings.config.copy.enabled) log(`👀 Copying ${settings.config.copy.addresses.length} trader(s)`);
  
  await alertStatus(`Bot Started | ${settings.preset} | ${state.liveTrading ? "LIVE" : "SIM"} | ${$(state.balance)}`);

  await cycle(addr, settings.config);
  setInterval(() => cycle(addr, settings.config).catch(e => log(`❌ ${e}`)), settings.intervalMs);

  process.on("SIGINT", async () => {
    await alertStatus("Bot Stopped | Shutdown");
    process.exit(0);
  });
}

if (require.main === module) startV2();
