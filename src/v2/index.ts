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
  stopLoss: { enabled: boolean; maxLossPct: number };
  hedge: { enabled: boolean; triggerPct: number; maxUsd: number; allowExceedMax: boolean; absoluteMaxUsd: number };
  scalp: { enabled: boolean; minProfitPct: number; minGainCents: number; lowPriceThreshold: number };
  stack: { enabled: boolean; minGainCents: number; maxUsd: number; maxPrice: number };
  endgame: { enabled: boolean; minPrice: number; maxPrice: number; maxUsd: number };
  redeem: { enabled: boolean; intervalMin: number; minPositionUsd: number };
  copy: { enabled: boolean; addresses: string[]; multiplier: number; minUsd: number; maxUsd: number };
  arbitrage: { enabled: boolean; maxUsd: number; minEdgeBps: number };
  maxPositionUsd: number; // Global position size limit
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

const PRESETS: Record<Preset, Config> = {
  conservative: {
    autoSell: { enabled: true, threshold: 0.98, minHoldSec: 60 },
    stopLoss: { enabled: true, maxLossPct: 20 },
    hedge: { enabled: true, triggerPct: 15, maxUsd: 15, allowExceedMax: false, absoluteMaxUsd: 25 },
    scalp: { enabled: true, minProfitPct: 15, minGainCents: 8, lowPriceThreshold: 0 },
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.90 },
    endgame: { enabled: true, minPrice: 0.90, maxPrice: 0.98, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0.10 },
    copy: { enabled: false, addresses: [], multiplier: 1.0, minUsd: 5, maxUsd: 50 },
    arbitrage: { enabled: true, maxUsd: 15, minEdgeBps: 50 },
    maxPositionUsd: 15,
  },
  balanced: {
    autoSell: { enabled: true, threshold: 0.99, minHoldSec: 60 },
    stopLoss: { enabled: true, maxLossPct: 25 },
    hedge: { enabled: true, triggerPct: 20, maxUsd: 25, allowExceedMax: false, absoluteMaxUsd: 50 },
    scalp: { enabled: true, minProfitPct: 10, minGainCents: 5, lowPriceThreshold: 0 },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.99, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0.10 },
    copy: { enabled: false, addresses: [], multiplier: 1.0, minUsd: 5, maxUsd: 100 },
    arbitrage: { enabled: true, maxUsd: 25, minEdgeBps: 30 },
    maxPositionUsd: 25,
  },
  aggressive: {
    autoSell: { enabled: true, threshold: 0.995, minHoldSec: 30 },
    stopLoss: { enabled: true, maxLossPct: 35 },
    hedge: { enabled: true, triggerPct: 25, maxUsd: 50, allowExceedMax: true, absoluteMaxUsd: 100 },
    scalp: { enabled: true, minProfitPct: 5, minGainCents: 3, lowPriceThreshold: 0 },
    stack: { enabled: true, minGainCents: 15, maxUsd: 50, maxPrice: 0.97 },
    endgame: { enabled: true, minPrice: 0.80, maxPrice: 0.995, maxUsd: 50 },
    redeem: { enabled: true, intervalMin: 10, minPositionUsd: 0.01 },
    copy: { enabled: false, addresses: [], multiplier: 1.5, minUsd: 5, maxUsd: 200 },
    arbitrage: { enabled: true, maxUsd: 50, minEdgeBps: 20 },
    maxPositionUsd: 50,
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
  stacked: new Set<string>(),
  hedged: new Set<string>(),
  sold: new Set<string>(),
  copied: new Set<string>(),
  telegram: undefined as { token: string; chatId: string } | undefined,
  proxyAddress: undefined as string | undefined,
  copyLastCheck: new Map<string, number>(),
  clobClient: undefined as ClobClient | undefined,
  wallet: undefined as Wallet | undefined,
  liveTrading: false,
};

// ============ LOGGING ============

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ============ ALERTS ============

async function alert(title: string, msg: string) {
  log(`📢 ${title}: ${msg}`);
  if (state.telegram) {
    await axios.post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
      chat_id: state.telegram.chatId, text: `*${title}*\n${msg}`, parse_mode: "Markdown",
    }).catch(() => {});
  }
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

// ============ ORDER EXECUTION ============

const logLevel = process.env.LOG_LEVEL || "info";
const simpleLogger = {
  info: log,
  warn: log,
  error: log,
  debug: logLevel === "debug" ? log : () => {},
};

async function executeSell(tokenId: string, conditionId: string, outcome: string, sizeUsd: number, reason: string): Promise<boolean> {
  if (!state.liveTrading) {
    log(`🔸 ${reason}: SELL ${outcome} $${sizeUsd.toFixed(2)} [SIMULATED]`);
    return true;
  }
  
  if (!state.clobClient || !state.wallet) {
    log(`❌ ${reason}: No CLOB client`);
    return false;
  }

  log(`💰 ${reason}: SELL ${outcome} $${sizeUsd.toFixed(2)}`);
  
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
      await alert(reason, `Sold ${outcome} $${sizeUsd.toFixed(2)}`);
      invalidate();
      return true;
    }
    log(`⚠️ ${reason}: ${result.reason || "failed"}`);
    return false;
  } catch (e: any) {
    log(`❌ ${reason}: ${e.message?.slice(0, 50)}`);
    return false;
  }
}

async function executeBuy(tokenId: string, conditionId: string, outcome: string, sizeUsd: number, reason: string): Promise<boolean> {
  if (!state.liveTrading) {
    log(`🔸 ${reason}: BUY ${outcome} $${sizeUsd.toFixed(2)} [SIMULATED]`);
    return true;
  }
  
  if (!state.clobClient || !state.wallet) {
    log(`❌ ${reason}: No CLOB client`);
    return false;
  }

  log(`🛒 ${reason}: BUY ${outcome} $${sizeUsd.toFixed(2)}`);
  
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
      await alert(reason, `Bought ${outcome} $${sizeUsd.toFixed(2)}`);
      invalidate();
      return true;
    }
    log(`⚠️ ${reason}: ${result.reason || "failed"}`);
    return false;
  } catch (e: any) {
    log(`❌ ${reason}: ${e.message?.slice(0, 50)}`);
    return false;
  }
}

// ============ COPY TRADING ============

async function copyTrades(cfg: Config) {
  if (!cfg.copy.enabled || !cfg.copy.addresses.length) return;

  for (const addr of cfg.copy.addresses) {
    const activities = await fetchActivity(addr);
    const lastCheck = state.copyLastCheck.get(addr) || 0;
    
    for (const signal of activities) {
      if (signal.timestamp <= lastCheck) continue;
      const key = `${signal.tokenId}-${signal.timestamp}`;
      if (state.copied.has(key)) continue;
      if (signal.side !== "BUY") continue; // Only copy buys
      if (signal.price < 0.05) continue; // Skip garbage
      
      let copyUsd = signal.usdSize * cfg.copy.multiplier;
      copyUsd = Math.max(cfg.copy.minUsd, Math.min(cfg.copy.maxUsd, copyUsd));
      
      const existing = state.positions.find(p => p.tokenId === signal.tokenId);
      if (existing && existing.value > cfg.copy.maxUsd) {
        state.copied.add(key);
        continue;
      }
      
      log(`👀 Copy ${addr.slice(0,8)}...: ${signal.outcome} $${copyUsd.toFixed(0)}`);
      await executeBuy(signal.tokenId, signal.conditionId, signal.outcome, copyUsd, "Copy");
      state.copied.add(key);
    }
    state.copyLastCheck.set(addr, Math.floor(Date.now() / 1000));
  }
}

// ============ STRATEGIES ============
// Simple rules: if condition met → execute. No cross-strategy logic.

async function autoSell(positions: Position[], cfg: Config) {
  if (!cfg.autoSell.enabled) return;
  // Sell when price >= threshold (near $1)
  for (const p of positions) {
    if (state.sold.has(p.tokenId)) continue;
    if (p.curPrice >= cfg.autoSell.threshold) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "AutoSell")) {
        state.sold.add(p.tokenId);
      }
    }
  }
}

async function stopLoss(positions: Position[], cfg: Config) {
  if (!cfg.stopLoss.enabled) return;
  // Sell when loss exceeds threshold
  for (const p of positions) {
    if (state.sold.has(p.tokenId)) continue;
    if (p.pnlPct <= -cfg.stopLoss.maxLossPct) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "StopLoss")) {
        state.sold.add(p.tokenId);
      }
    }
  }
}

async function hedge(positions: Position[], cfg: Config) {
  if (!cfg.hedge.enabled) return;
  // Buy opposite side when down by trigger %
  for (const p of positions) {
    if (state.hedged.has(p.tokenId)) continue;
    if (p.pnlPct <= -cfg.hedge.triggerPct) {
      const opp = p.outcome === "YES" ? "NO" : "YES";
      // Use absoluteMaxUsd if allowExceedMax, otherwise use maxUsd
      const hedgeAmt = cfg.hedge.allowExceedMax ? cfg.hedge.absoluteMaxUsd : cfg.hedge.maxUsd;
      if (await executeBuy(p.tokenId, p.conditionId, opp, hedgeAmt, "Hedge")) {
        state.hedged.add(p.tokenId);
      }
    }
  }
}

async function scalp(positions: Position[], cfg: Config) {
  if (!cfg.scalp.enabled) return;
  // Take profit when up by minProfitPct AND minGainCents
  for (const p of positions) {
    if (state.sold.has(p.tokenId)) continue;
    // Skip low price positions if threshold is set (0 = disabled)
    if (cfg.scalp.lowPriceThreshold > 0 && p.avgPrice < cfg.scalp.lowPriceThreshold) continue;
    if (p.pnlPct >= cfg.scalp.minProfitPct && p.gainCents >= cfg.scalp.minGainCents) {
      if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "Scalp")) {
        state.sold.add(p.tokenId);
      }
    }
  }
}

async function stack(walletAddr: string, positions: Position[], cfg: Config) {
  if (!cfg.stack.enabled) return;
  // Buy more when position is winning (once per position)
  for (const p of positions) {
    if (state.stacked.has(p.tokenId)) continue;
    if (p.gainCents >= cfg.stack.minGainCents && p.curPrice <= cfg.stack.maxPrice) {
      // Check if already stacked (2+ buys means we already added)
      const buys = await countBuys(walletAddr, p.tokenId);
      if (buys >= 2) {
        state.stacked.add(p.tokenId);
        continue;
      }
      if (await executeBuy(p.tokenId, p.conditionId, p.outcome, cfg.stack.maxUsd, "Stack")) {
        state.stacked.add(p.tokenId);
      }
    }
  }
}

async function endgame(positions: Position[], cfg: Config) {
  if (!cfg.endgame.enabled) return;
  // Buy more of high-confidence positions (price between min and max)
  for (const p of positions) {
    if (p.curPrice >= cfg.endgame.minPrice && p.curPrice <= cfg.endgame.maxPrice) {
      // Only add if position is below 2x max size
      if (p.value < cfg.endgame.maxUsd * 2) {
        const addAmt = Math.min(cfg.endgame.maxUsd, cfg.endgame.maxUsd * 2 - p.value);
        if (addAmt >= 5) {
          await executeBuy(p.tokenId, p.conditionId, p.outcome, addAmt, "Endgame");
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
      
      if (total < 0.98 && total > 0.5) {
        const profit = (1 - total) * 100;
        log(`💎 Arb: YES=${(yesPrice*100).toFixed(0)}¢ + NO=${(noPrice*100).toFixed(0)}¢ = ${profit.toFixed(1)}% profit`);
        const arbUsd = cfg.arbitrage.maxUsd / 2;
        await executeBuy(yes.token_id, cid, "YES", arbUsd, "Arb");
        await executeBuy(no.token_id, cid, "NO", arbUsd, "Arb");
      }
    } catch { /* skip */ }
  }
}

// ============ SELL SIGNAL PROTECTION ============

async function sellSignalProtection(cfg: Config) {
  if (!cfg.copy.enabled || !cfg.copy.addresses.length) return;
  
  for (const addr of cfg.copy.addresses) {
    const activities = await fetchActivity(addr);
    
    for (const signal of activities) {
      if (signal.side !== "SELL") continue;
      
      const ourPos = state.positions.find(p => p.tokenId === signal.tokenId);
      if (!ourPos) continue;
      if (ourPos.pnlPct > 20) continue;
      
      if (ourPos.pnlPct < -15 && !state.sold.has(ourPos.tokenId)) {
        log(`⚠️ Tracked trader sold - we are down ${ourPos.pnlPct.toFixed(1)}%`);
        
        if (ourPos.pnlPct < -40) {
          await executeSell(ourPos.tokenId, ourPos.conditionId, ourPos.outcome, ourPos.value, "SellSignal");
          state.sold.add(ourPos.tokenId);
        } else if (!state.hedged.has(ourPos.tokenId)) {
          const opp = ourPos.outcome === "YES" ? "NO" : "YES";
          await executeBuy(ourPos.tokenId, ourPos.conditionId, opp, ourPos.value * 0.5, "SellSignal-Hedge");
          state.hedged.add(ourPos.tokenId);
        }
      }
    }
  }
}

// ============ MAIN CYCLE ============

async function cycle(walletAddr: string, cfg: Config) {
  await copyTrades(cfg);
  await sellSignalProtection(cfg);
  
  const positions = await fetchPositions(state.proxyAddress || walletAddr);
  if (positions.length) {
    await autoSell(positions, cfg);
    await stopLoss(positions, cfg);
    await hedge(positions, cfg);
    await scalp(positions, cfg);
    await stack(walletAddr, positions, cfg);
    await endgame(positions, cfg);
    await arbitrage(cfg);
  }
  
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
  // V1: STOP_LOSS_ENABLED, STOP_LOSS_PCT | Also: HEDGING_TRIGGER_LOSS_PCT (alias)
  if (envBool("STOP_LOSS_ENABLED") !== undefined) cfg.stopLoss.enabled = envBool("STOP_LOSS_ENABLED")!;
  if (envNum("STOP_LOSS_PCT") !== undefined) cfg.stopLoss.maxLossPct = envNum("STOP_LOSS_PCT")!;
  
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
  
  // ========== SCALPING ==========
  // V1: SCALP_TAKE_PROFIT_ENABLED, SCALP_MIN_PROFIT_PCT, SCALP_LOW_PRICE_THRESHOLD
  // V2: SCALP_ENABLED, SCALP_MIN_PROFIT_PCT, SCALP_MIN_GAIN_CENTS
  if (envBool("SCALP_TAKE_PROFIT_ENABLED") !== undefined) cfg.scalp.enabled = envBool("SCALP_TAKE_PROFIT_ENABLED")!;
  if (envBool("SCALP_ENABLED") !== undefined) cfg.scalp.enabled = envBool("SCALP_ENABLED")!;
  if (envNum("SCALP_MIN_PROFIT_PCT") !== undefined) cfg.scalp.minProfitPct = envNum("SCALP_MIN_PROFIT_PCT")!;
  if (envNum("SCALP_TARGET_PROFIT_PCT") !== undefined) cfg.scalp.minProfitPct = envNum("SCALP_TARGET_PROFIT_PCT")!;
  if (envNum("SCALP_MIN_GAIN_CENTS") !== undefined) cfg.scalp.minGainCents = envNum("SCALP_MIN_GAIN_CENTS")!;
  if (envNum("SCALP_LOW_PRICE_THRESHOLD") !== undefined) cfg.scalp.lowPriceThreshold = envNum("SCALP_LOW_PRICE_THRESHOLD")!;
  
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
  // V1: TARGET_ADDRESSES, TRADE_MULTIPLIER, MIN_TRADE_SIZE_USD
  // V2: COPY_ADDRESSES, COPY_MULTIPLIER, COPY_MIN_USD, COPY_MAX_USD
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
  
  // ========== ARBITRAGE ==========
  // V1: ARB_ENABLED, ARB_DRY_RUN, ARB_MIN_EDGE_BPS
  if (envBool("ARB_ENABLED") !== undefined) cfg.arbitrage.enabled = envBool("ARB_ENABLED")!;
  if (envNum("ARB_MAX_USD") !== undefined) cfg.arbitrage.maxUsd = envNum("ARB_MAX_USD")!;
  if (envNum("ARB_MIN_EDGE_BPS") !== undefined) cfg.arbitrage.minEdgeBps = envNum("ARB_MIN_EDGE_BPS")!;

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
  
  const provider = new JsonRpcProvider(settings.rpcUrl);
  const wallet = new Wallet(settings.privateKey, provider);
  const addr = wallet.address.toLowerCase();

  // Initialize CLOB client for trading
  const clobClient = new ClobClient("https://clob.polymarket.com", 137, wallet as any);
  
  state.wallet = wallet;
  state.clobClient = clobClient;
  state.proxyAddress = await fetchProxy(addr);
  state.telegram = settings.telegram;
  state.liveTrading = settings.liveTrading;

  log(`Preset: ${settings.preset}`);
  log(`Wallet: ${addr.slice(0, 10)}...`);
  log(`Trading: ${state.liveTrading ? "🟢 LIVE" : "🔸 SIMULATED"}`);
  if (state.proxyAddress) log(`Proxy: ${state.proxyAddress.slice(0, 10)}...`);
  if (settings.config.copy.enabled) log(`👀 Copying ${settings.config.copy.addresses.length} trader(s)`);
  
  await alert("Bot Started", `${settings.preset} | ${state.liveTrading ? "LIVE" : "SIM"}`);

  await cycle(addr, settings.config);
  setInterval(() => cycle(addr, settings.config).catch(e => log(`❌ ${e}`)), settings.intervalMs);

  process.on("SIGINT", async () => {
    await alert("Bot Stopped", "Shutdown");
    process.exit(0);
  });
}

if (require.main === module) startV2();
