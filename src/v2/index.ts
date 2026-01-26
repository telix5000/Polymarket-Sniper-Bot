/**
 * Polymarket Trading Bot V2 - Simple & Clean
 * 
 * STRATEGIES:
 * 1. AutoSell  - Sell positions near $1
 * 2. StopLoss  - Sell at max loss
 * 3. Hedge     - Buy opposite when losing
 * 4. Scalp     - Take profits
 * 5. Stack     - Double down on winners
 * 6. Endgame   - Buy high-confidence (85-99¢)
 * 7. Redeem    - Claim resolved positions
 * 
 * ENV: PRIVATE_KEY, RPC_URL, PRESET (conservative|balanced|aggressive)
 */

import { JsonRpcProvider, Wallet, Contract, Interface, ZeroHash } from "ethers";
import axios from "axios";

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
  },
  balanced: {
    autoSell: { enabled: true, threshold: 0.99 },
    stopLoss: { enabled: true, maxLossPct: 25 },
    hedge: { enabled: true, triggerPct: 20, maxUsd: 25 },
    scalp: { enabled: true, minProfitPct: 10, minGainCents: 5 },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.99, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15 },
  },
  aggressive: {
    autoSell: { enabled: true, threshold: 0.995 },
    stopLoss: { enabled: true, maxLossPct: 35 },
    hedge: { enabled: true, triggerPct: 25, maxUsd: 50 },
    scalp: { enabled: true, minProfitPct: 5, minGainCents: 3 },
    stack: { enabled: true, minGainCents: 15, maxUsd: 50, maxPrice: 0.97 },
    endgame: { enabled: true, minPrice: 0.80, maxPrice: 0.995, maxUsd: 50 },
    redeem: { enabled: true, intervalMin: 10 },
  },
};

// ============ CONSTANTS ============

const API = "https://data-api.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
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
  telegram: undefined as { token: string; chatId: string } | undefined,
  proxyAddress: undefined as string | undefined,
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

async function countBuys(wallet: string, tokenId: string): Promise<number> {
  try {
    const { data } = await axios.get(`${API}/trades?user=${wallet}&asset=${tokenId}&limit=20`);
    return (data || []).filter((t: any) => t.side?.toUpperCase() === "BUY").length;
  } catch { return 0; }
}

function invalidate() { state.lastFetch = 0; }

// ============ ORDERS ============

async function sell(p: Position, reason: string): Promise<boolean> {
  if (state.sold.has(p.tokenId)) return false;
  log(`💰 ${reason}: SELL ${p.outcome} @ ${(p.curPrice*100).toFixed(0)}¢`);
  await alert(reason, `Sold ${p.outcome} @ ${(p.curPrice*100).toFixed(0)}¢`);
  state.sold.add(p.tokenId);
  invalidate();
  return true;
}

async function buy(p: Position, outcome: string, usd: number, reason: string): Promise<boolean> {
  log(`🛒 ${reason}: BUY ${outcome} $${usd.toFixed(0)}`);
  await alert(reason, `Bought ${outcome} $${usd.toFixed(0)}`);
  invalidate();
  return true;
}

// ============ STRATEGIES ============

async function autoSell(positions: Position[], cfg: Config) {
  if (!cfg.autoSell.enabled) return;
  for (const p of positions.filter(p => p.curPrice >= cfg.autoSell.threshold)) {
    await sell(p, "AutoSell");
  }
}

async function stopLoss(positions: Position[], cfg: Config) {
  if (!cfg.stopLoss.enabled) return;
  for (const p of positions.filter(p => p.pnlPct <= -cfg.stopLoss.maxLossPct)) {
    await sell(p, "StopLoss");
  }
}

async function hedge(wallet: string, positions: Position[], cfg: Config) {
  if (!cfg.hedge.enabled) return;
  for (const p of positions.filter(p =>
    p.pnlPct < 0 && Math.abs(p.pnlPct) >= cfg.hedge.triggerPct &&
    Math.abs(p.pnlPct) < cfg.stopLoss.maxLossPct && !state.hedged.has(p.tokenId)
  )) {
    await buy(p, p.outcome === "YES" ? "NO" : "YES", Math.min(cfg.hedge.maxUsd, p.value), "Hedge");
    state.hedged.add(p.tokenId);
  }
}

async function scalp(positions: Position[], cfg: Config) {
  if (!cfg.scalp.enabled) return;
  for (const p of positions.filter(p => p.pnlPct >= cfg.scalp.minProfitPct && p.gainCents >= cfg.scalp.minGainCents)) {
    await sell(p, "Scalp");
  }
}

async function stack(wallet: string, positions: Position[], cfg: Config) {
  if (!cfg.stack.enabled) return;
  for (const p of positions.filter(p =>
    p.gainCents >= cfg.stack.minGainCents && p.curPrice < cfg.stack.maxPrice && !state.stacked.has(p.tokenId)
  )) {
    if (await countBuys(wallet, p.tokenId) >= 2) { state.stacked.add(p.tokenId); continue; }
    await buy(p, p.outcome, cfg.stack.maxUsd, "Stack");
    state.stacked.add(p.tokenId);
  }
}

async function endgame(positions: Position[], cfg: Config) {
  if (!cfg.endgame.enabled) return;
  for (const p of positions.filter(p =>
    p.curPrice >= cfg.endgame.minPrice && p.curPrice <= cfg.endgame.maxPrice && p.value < cfg.endgame.maxUsd * 2
  )) {
    const add = Math.min(cfg.endgame.maxUsd, cfg.endgame.maxUsd * 2 - p.value);
    if (add >= 5) await buy(p, p.outcome, add, "Endgame");
  }
}

// ============ REDEEM (Simple - from polymarketredeemer) ============

async function redeem(wallet: Wallet, walletAddr: string, cfg: Config) {
  if (!cfg.redeem.enabled) return;
  if (Date.now() - state.lastRedeem < cfg.redeem.intervalMin * 60 * 1000) return;
  
  state.lastRedeem = Date.now();
  const target = state.proxyAddress || walletAddr;
  const conditions = await fetchRedeemable(target);
  
  if (!conditions.length) return;
  log(`🎁 ${conditions.length} positions to redeem`);

  const ctfInterface = new Interface(CTF_ABI);
  
  for (const conditionId of conditions) {
    try {
      const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS, ZeroHash, conditionId, [1, 2]
      ]);

      let tx;
      if (state.proxyAddress && state.proxyAddress !== walletAddr) {
        const proxy = new Contract(state.proxyAddress, PROXY_ABI, wallet);
        tx = await proxy.proxy(CTF_ADDRESS, redeemData);
      } else {
        const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
        tx = await ctf.redeemPositions(USDC_ADDRESS, ZeroHash, conditionId, [1, 2]);
      }

      log(`✅ Redeem tx: ${tx.hash}`);
      await alert("Redeem", `Claimed ${conditionId.slice(0, 10)}...`);
      await tx.wait();
    } catch (e: any) {
      log(`❌ Redeem failed: ${e.message?.slice(0, 50)}`);
    }
  }
}

// ============ MAIN ============

async function cycle(wallet: Wallet, walletAddr: string, cfg: Config) {
  const positions = await fetchPositions(state.proxyAddress || walletAddr);
  if (positions.length) {
    await autoSell(positions, cfg);
    await stopLoss(positions, cfg);
    await hedge(walletAddr, positions, cfg);
    await scalp(positions, cfg);
    await stack(walletAddr, positions, cfg);
    await endgame(positions, cfg);
  }
  await redeem(wallet, walletAddr, cfg);
}

export function loadConfig() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  if (!privateKey) throw new Error("Missing PRIVATE_KEY");
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const preset = (process.env.PRESET || "balanced") as Preset;
  if (!PRESETS[preset]) throw new Error(`Invalid PRESET: ${preset}`);

  return {
    privateKey, rpcUrl, preset,
    config: PRESETS[preset],
    intervalMs: Number(process.env.INTERVAL_MS) || 5000,
    telegram: process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT
      ? { token: process.env.TELEGRAM_TOKEN, chatId: process.env.TELEGRAM_CHAT }
      : undefined,
  };
}

export async function startV2() {
  log("=== Polymarket Bot V2 ===");
  const cfg = loadConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(cfg.privateKey, provider);
  const addr = wallet.address.toLowerCase();

  // Get proxy address
  state.proxyAddress = await fetchProxy(addr);
  state.telegram = cfg.telegram;

  log(`Preset: ${cfg.preset}`);
  log(`Wallet: ${addr.slice(0, 10)}...`);
  if (state.proxyAddress) log(`Proxy: ${state.proxyAddress.slice(0, 10)}...`);
  
  await alert("Bot Started", `Preset: ${cfg.preset}`);

  await cycle(wallet, addr, cfg.config);
  setInterval(() => cycle(wallet, addr, cfg.config).catch(e => log(`❌ ${e}`)), cfg.intervalMs);

  process.on("SIGINT", async () => {
    await alert("Bot Stopped", "Shutdown");
    process.exit(0);
  });
}

if (require.main === module) startV2();
