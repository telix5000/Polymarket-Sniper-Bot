/**
 * Polymarket Trading Bot V2 - Simple & Clean
 * 
 * REQUIRED ENV:
 *   PRIVATE_KEY          - Wallet private key
 *   RPC_URL              - Polygon RPC endpoint
 * 
 * PRESET:
 *   PRESET               - conservative | balanced | aggressive (default: balanced)
 * 
 * COPY TRADING:
 *   COPY_ADDRESSES       - Comma-separated addresses to copy
 *   COPY_MULTIPLIER      - Size multiplier (default: 1.0)
 *   COPY_MIN_USD         - Min trade size (default: 5)
 *   COPY_MAX_USD         - Max trade size (default: 100)
 * 
 * OPTIONAL:
 *   INTERVAL_MS          - Cycle interval ms (default: 5000)
 *   TELEGRAM_TOKEN/CHAT  - Alerts
 *   VPN_BYPASS_RPC       - Route RPC outside VPN (default: true)
 *   LIVE_TRADING         - Enable real trades (default: false for safety)
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
  autoSell: { enabled: boolean; threshold: number };
  stopLoss: { enabled: boolean; maxLossPct: number };
  hedge: { enabled: boolean; triggerPct: number; maxUsd: number };
  scalp: { enabled: boolean; minProfitPct: number; minGainCents: number };
  stack: { enabled: boolean; minGainCents: number; maxUsd: number; maxPrice: number };
  endgame: { enabled: boolean; minPrice: number; maxPrice: number; maxUsd: number };
  redeem: { enabled: boolean; intervalMin: number };
  copy: { enabled: boolean; addresses: string[]; multiplier: number; minUsd: number; maxUsd: number };
  arbitrage: { enabled: boolean; maxUsd: number };
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
    autoSell: { enabled: true, threshold: 0.98 },
    stopLoss: { enabled: true, maxLossPct: 20 },
    hedge: { enabled: true, triggerPct: 15, maxUsd: 15 },
    scalp: { enabled: true, minProfitPct: 15, minGainCents: 8 },
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.90 },
    endgame: { enabled: true, minPrice: 0.90, maxPrice: 0.98, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15 },
    copy: { enabled: false, addresses: [], multiplier: 1.0, minUsd: 5, maxUsd: 50 },
    arbitrage: { enabled: true, maxUsd: 15 },
  },
  balanced: {
    autoSell: { enabled: true, threshold: 0.99 },
    stopLoss: { enabled: true, maxLossPct: 25 },
    hedge: { enabled: true, triggerPct: 20, maxUsd: 25 },
    scalp: { enabled: true, minProfitPct: 10, minGainCents: 5 },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.99, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15 },
    copy: { enabled: false, addresses: [], multiplier: 1.0, minUsd: 5, maxUsd: 100 },
    arbitrage: { enabled: true, maxUsd: 25 },
  },
  aggressive: {
    autoSell: { enabled: true, threshold: 0.995 },
    stopLoss: { enabled: true, maxLossPct: 35 },
    hedge: { enabled: true, triggerPct: 25, maxUsd: 50 },
    scalp: { enabled: true, minProfitPct: 5, minGainCents: 3 },
    stack: { enabled: true, minGainCents: 15, maxUsd: 50, maxPrice: 0.97 },
    endgame: { enabled: true, minPrice: 0.80, maxPrice: 0.995, maxUsd: 50 },
    redeem: { enabled: true, intervalMin: 10 },
    copy: { enabled: false, addresses: [], multiplier: 1.5, minUsd: 5, maxUsd: 200 },
    arbitrage: { enabled: true, maxUsd: 50 },
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

async function autoSell(positions: Position[], cfg: Config) {
  if (!cfg.autoSell.enabled) return;
  for (const p of positions.filter(p => p.curPrice >= cfg.autoSell.threshold && !state.sold.has(p.tokenId))) {
    if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "AutoSell")) {
      state.sold.add(p.tokenId);
    }
  }
}

async function stopLoss(positions: Position[], cfg: Config) {
  if (!cfg.stopLoss.enabled) return;
  for (const p of positions.filter(p => p.pnlPct <= -cfg.stopLoss.maxLossPct && !state.sold.has(p.tokenId))) {
    if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "StopLoss")) {
      state.sold.add(p.tokenId);
    }
  }
}

async function hedge(walletAddr: string, positions: Position[], cfg: Config) {
  if (!cfg.hedge.enabled) return;
  for (const p of positions.filter(p =>
    p.pnlPct < 0 && Math.abs(p.pnlPct) >= cfg.hedge.triggerPct &&
    Math.abs(p.pnlPct) < cfg.stopLoss.maxLossPct && !state.hedged.has(p.tokenId)
  )) {
    const opp = p.outcome === "YES" ? "NO" : "YES";
    if (await executeBuy(p.tokenId, p.conditionId, opp, Math.min(cfg.hedge.maxUsd, p.value), "Hedge")) {
      state.hedged.add(p.tokenId);
    }
  }
}

async function scalp(positions: Position[], cfg: Config) {
  if (!cfg.scalp.enabled) return;
  for (const p of positions.filter(p => 
    p.pnlPct >= cfg.scalp.minProfitPct && p.gainCents >= cfg.scalp.minGainCents && !state.sold.has(p.tokenId)
  )) {
    if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, "Scalp")) {
      state.sold.add(p.tokenId);
    }
  }
}

async function stack(walletAddr: string, positions: Position[], cfg: Config) {
  if (!cfg.stack.enabled) return;
  for (const p of positions.filter(p =>
    p.gainCents >= cfg.stack.minGainCents && p.curPrice < cfg.stack.maxPrice && !state.stacked.has(p.tokenId)
  )) {
    if (await countBuys(walletAddr, p.tokenId) >= 2) { state.stacked.add(p.tokenId); continue; }
    if (await executeBuy(p.tokenId, p.conditionId, p.outcome, cfg.stack.maxUsd, "Stack")) {
      state.stacked.add(p.tokenId);
    }
  }
}

async function endgame(positions: Position[], cfg: Config) {
  if (!cfg.endgame.enabled) return;
  for (const p of positions.filter(p =>
    p.curPrice >= cfg.endgame.minPrice && p.curPrice <= cfg.endgame.maxPrice && p.value < cfg.endgame.maxUsd * 2
  )) {
    const add = Math.min(cfg.endgame.maxUsd, cfg.endgame.maxUsd * 2 - p.value);
    if (add >= 5) await executeBuy(p.tokenId, p.conditionId, p.outcome, add, "Endgame");
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
    await hedge(walletAddr, positions, cfg);
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

  const preset = (process.env.PRESET || "balanced") as Preset;
  if (!PRESETS[preset]) throw new Error(`Invalid PRESET: ${preset}`);

  const cfg: Config = JSON.parse(JSON.stringify(PRESETS[preset]));
  const env = (k: string) => process.env[k];
  const envBool = (k: string) => env(k) === "true";
  const envNum = (k: string) => env(k) ? Number(env(k)) : undefined;
  
  // Strategy overrides
  if (env("AUTO_SELL_ENABLED")) cfg.autoSell.enabled = envBool("AUTO_SELL_ENABLED");
  if (envNum("AUTO_SELL_THRESHOLD")) cfg.autoSell.threshold = envNum("AUTO_SELL_THRESHOLD")!;
  if (env("STOP_LOSS_ENABLED")) cfg.stopLoss.enabled = envBool("STOP_LOSS_ENABLED");
  if (envNum("STOP_LOSS_PCT")) cfg.stopLoss.maxLossPct = envNum("STOP_LOSS_PCT")!;
  if (env("HEDGE_ENABLED")) cfg.hedge.enabled = envBool("HEDGE_ENABLED");
  if (envNum("HEDGE_TRIGGER_PCT")) cfg.hedge.triggerPct = envNum("HEDGE_TRIGGER_PCT")!;
  if (envNum("HEDGE_MAX_USD")) cfg.hedge.maxUsd = envNum("HEDGE_MAX_USD")!;
  if (env("SCALP_ENABLED")) cfg.scalp.enabled = envBool("SCALP_ENABLED");
  if (envNum("SCALP_MIN_PROFIT_PCT")) cfg.scalp.minProfitPct = envNum("SCALP_MIN_PROFIT_PCT")!;
  if (envNum("SCALP_MIN_GAIN_CENTS")) cfg.scalp.minGainCents = envNum("SCALP_MIN_GAIN_CENTS")!;
  if (env("STACK_ENABLED")) cfg.stack.enabled = envBool("STACK_ENABLED");
  if (envNum("STACK_MIN_GAIN_CENTS")) cfg.stack.minGainCents = envNum("STACK_MIN_GAIN_CENTS")!;
  if (envNum("STACK_MAX_USD")) cfg.stack.maxUsd = envNum("STACK_MAX_USD")!;
  if (envNum("STACK_MAX_PRICE")) cfg.stack.maxPrice = envNum("STACK_MAX_PRICE")!;
  if (env("ENDGAME_ENABLED")) cfg.endgame.enabled = envBool("ENDGAME_ENABLED");
  if (envNum("ENDGAME_MIN_PRICE")) cfg.endgame.minPrice = envNum("ENDGAME_MIN_PRICE")!;
  if (envNum("ENDGAME_MAX_PRICE")) cfg.endgame.maxPrice = envNum("ENDGAME_MAX_PRICE")!;
  if (envNum("ENDGAME_MAX_USD")) cfg.endgame.maxUsd = envNum("ENDGAME_MAX_USD")!;
  if (env("REDEEM_ENABLED")) cfg.redeem.enabled = envBool("REDEEM_ENABLED");
  if (envNum("REDEEM_INTERVAL_MIN")) cfg.redeem.intervalMin = envNum("REDEEM_INTERVAL_MIN")!;
  
  // Copy trading
  if (env("COPY_ADDRESSES")) {
    cfg.copy.enabled = true;
    cfg.copy.addresses = env("COPY_ADDRESSES")!.split(",").map(a => a.trim().toLowerCase());
  }
  if (envNum("COPY_MULTIPLIER")) cfg.copy.multiplier = envNum("COPY_MULTIPLIER")!;
  if (envNum("COPY_MIN_USD")) cfg.copy.minUsd = envNum("COPY_MIN_USD")!;
  if (envNum("COPY_MAX_USD")) cfg.copy.maxUsd = envNum("COPY_MAX_USD")!;
  
  // Arbitrage
  if (env("ARB_ENABLED")) cfg.arbitrage.enabled = envBool("ARB_ENABLED");
  if (envNum("ARB_MAX_USD")) cfg.arbitrage.maxUsd = envNum("ARB_MAX_USD")!;

  return {
    privateKey, rpcUrl, preset, config: cfg,
    intervalMs: envNum("INTERVAL_MS") || 5000,
    liveTrading: envBool("LIVE_TRADING"),
    telegram: env("TELEGRAM_TOKEN") && env("TELEGRAM_CHAT")
      ? { token: env("TELEGRAM_TOKEN")!, chatId: env("TELEGRAM_CHAT")! } : undefined,
  };
}

// ============ STARTUP ============

export async function startV2() {
  log("=== Polymarket Bot V2 ===");
  
  const settings = loadConfig();
  
  // VPN bypass for fast RPC
  
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
