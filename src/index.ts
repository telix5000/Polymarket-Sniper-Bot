/**
 * Polymarket Trading Bot - Simple & Clean
 *
 * ENV:
 *   PRIVATE_KEY    - Required
 *   RPC_URL        - Required
 *   PRESET         - conservative | balanced | aggressive (default: balanced)
 *   TELEGRAM_TOKEN - Optional
 *   TELEGRAM_CHAT  - Optional
 *   INTERVAL_MS    - Optional (default: 5000)
 */

import { JsonRpcProvider, Wallet } from "ethers";
import axios from "axios";

// === TYPES ===

type Preset = "conservative" | "balanced" | "aggressive";
type Side = "BUY" | "SELL";

interface Position {
  tokenId: string;
  conditionId: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  pnlPct: number;
  pnlUsd: number;
  gainCents: number;
  value: number;
}

interface PresetConfig {
  stack: {
    enabled: boolean;
    minGainCents: number;
    maxUsd: number;
    maxPrice: number;
  };
  hedge: { enabled: boolean; triggerPct: number; maxUsd: number };
  stopLoss: { enabled: boolean; maxLossPct: number };
  scalp: { enabled: boolean; minProfitPct: number; minGainCents: number };
  autoSell: { enabled: boolean; threshold: number };
}

// === PRESETS ===

const PRESETS: Record<Preset, PresetConfig> = {
  conservative: {
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.9 },
    hedge: { enabled: true, triggerPct: 15, maxUsd: 15 },
    stopLoss: { enabled: true, maxLossPct: 20 },
    scalp: { enabled: true, minProfitPct: 15, minGainCents: 8 },
    autoSell: { enabled: true, threshold: 0.98 },
  },
  balanced: {
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    hedge: { enabled: true, triggerPct: 20, maxUsd: 25 },
    stopLoss: { enabled: true, maxLossPct: 25 },
    scalp: { enabled: true, minProfitPct: 10, minGainCents: 5 },
    autoSell: { enabled: true, threshold: 0.99 },
  },
  aggressive: {
    stack: { enabled: true, minGainCents: 15, maxUsd: 50, maxPrice: 0.97 },
    hedge: { enabled: true, triggerPct: 25, maxUsd: 50 },
    stopLoss: { enabled: true, maxLossPct: 35 },
    scalp: { enabled: true, minProfitPct: 5, minGainCents: 3 },
    autoSell: { enabled: true, threshold: 0.995 },
  },
};

// === CONFIG ===

function loadConfig() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;

  if (!privateKey) throw new Error("Missing PRIVATE_KEY");
  if (!rpcUrl) throw new Error("Missing RPC_URL");

  const preset = (process.env.PRESET ?? "balanced") as Preset;
  if (!PRESETS[preset]) throw new Error(`Invalid PRESET: ${preset}`);

  return {
    privateKey,
    rpcUrl,
    preset,
    config: PRESETS[preset],
    intervalMs: parseInt(process.env.INTERVAL_MS ?? "5000"),
    telegram:
      process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT
        ? {
            token: process.env.TELEGRAM_TOKEN,
            chatId: process.env.TELEGRAM_CHAT,
          }
        : undefined,
  };
}

// === ALERTS ===

const alertState = {
  telegram: undefined as { token: string; chatId: string } | undefined,
};

function initAlerts(telegram?: { token: string; chatId: string }) {
  alertState.telegram = telegram;
}

async function alert(title: string, message: string) {
  console.log(`[${title}] ${message}`);

  if (alertState.telegram) {
    const { token, chatId } = alertState.telegram;
    await axios
      .post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: `*${title}*\n${message}`,
        parse_mode: "Markdown",
      })
      .catch(() => {});
  }
}

// === API CLIENT ===

const API_BASE = "https://data-api.polymarket.com";

let positionsCache: Position[] = [];
let lastFetch = 0;
const CACHE_TTL = 30000;

async function getPositions(
  wallet: string,
  force = false,
): Promise<Position[]> {
  if (!force && Date.now() - lastFetch < CACHE_TTL && positionsCache.length) {
    return positionsCache;
  }

  try {
    const { data } = await axios.get(`${API_BASE}/positions?user=${wallet}`);

    positionsCache = (data || [])
      .filter((p: any) => {
        const size = Number(p.size) || 0;
        return size > 0 && !p.redeemable;
      })
      .map((p: any) => {
        const size = Number(p.size) || 0;
        const avgPrice = Number(p.avgPrice) || 0;
        const curPrice = Number(p.curPrice) || 0;
        const value = size * curPrice;
        const cost = size * avgPrice;
        const pnlUsd = value - cost;
        const pnlPct = cost > 0 ? (pnlUsd / cost) * 100 : 0;

        return {
          tokenId: p.asset,
          conditionId: p.conditionId,
          outcome: p.outcome || "YES",
          size,
          avgPrice,
          curPrice,
          pnlPct,
          pnlUsd,
          gainCents: (curPrice - avgPrice) * 100,
          value,
        };
      });

    lastFetch = Date.now();
    console.log(`[API] ${positionsCache.length} active positions`);
    return positionsCache;
  } catch (err) {
    console.error(`[API] Error: ${err}`);
    return positionsCache;
  }
}

async function getBuyCount(wallet: string, tokenId: string): Promise<number> {
  try {
    const { data } = await axios.get(
      `${API_BASE}/trades?user=${wallet}&asset=${tokenId}&limit=50`,
    );
    return (data || []).filter((t: any) => t.side?.toUpperCase() === "BUY")
      .length;
  } catch {
    return 0;
  }
}

function invalidateCache() {
  lastFetch = 0;
}

// === ORDER EXECUTION ===

async function placeOrder(
  wallet: Wallet,
  tokenId: string,
  conditionId: string,
  outcome: string,
  side: Side,
  sizeUsd: number,
): Promise<boolean> {
  // ⚠️ PLACEHOLDER - Real implementation needs @polymarket/clob-client integration
  // This file is NOT the main entrypoint - use src/v2/index.ts instead
  console.log(
    `[Order] ⚠️ SIMULATION ONLY: ${side} ${outcome} $${sizeUsd.toFixed(2)} on ${tokenId.slice(0, 8)}...`,
  );
  console.log(
    `[Order] ⚠️ This entrypoint is NOT connected to real trading. Use USE_V2=true to run V2.`,
  );

  // DO NOT execute real orders - this is a simulation placeholder
  // Return false to indicate no order was placed
  await alert(
    "Simulation",
    `Would ${side} ${outcome} $${sizeUsd.toFixed(2)} (NOT EXECUTED)`,
  );

  return false;
}

// === STRATEGIES ===

const stacked = new Set<string>();
const hedged = new Set<string>();

async function runAutoSell(
  wallet: Wallet,
  positions: Position[],
  config: PresetConfig,
) {
  if (!config.autoSell.enabled) return;

  for (const p of positions.filter(
    (p) => p.curPrice >= config.autoSell.threshold,
  )) {
    console.log(
      `[AutoSell] ${p.tokenId.slice(0, 8)}... @ ${(p.curPrice * 100).toFixed(0)}¢`,
    );
    await placeOrder(
      wallet,
      p.tokenId,
      p.conditionId,
      p.outcome,
      "SELL",
      p.value,
    );
  }
}

async function runStopLoss(
  wallet: Wallet,
  positions: Position[],
  config: PresetConfig,
) {
  if (!config.stopLoss.enabled) return;

  for (const p of positions.filter(
    (p) => p.pnlPct <= -config.stopLoss.maxLossPct,
  )) {
    console.log(
      `[StopLoss] ${p.tokenId.slice(0, 8)}... ${p.pnlPct.toFixed(1)}%`,
    );
    await placeOrder(
      wallet,
      p.tokenId,
      p.conditionId,
      p.outcome,
      "SELL",
      p.value,
    );
  }
}

async function runHedge(
  wallet: Wallet,
  walletAddr: string,
  positions: Position[],
  config: PresetConfig,
) {
  if (!config.hedge.enabled) return;

  const targets = positions.filter(
    (p) =>
      p.pnlPct < 0 &&
      Math.abs(p.pnlPct) >= config.hedge.triggerPct &&
      Math.abs(p.pnlPct) < config.stopLoss.maxLossPct &&
      !hedged.has(p.tokenId),
  );

  for (const p of targets) {
    const opp = p.outcome.toUpperCase() === "YES" ? "NO" : "YES";
    console.log(
      `[Hedge] ${p.tokenId.slice(0, 8)}... ${p.pnlPct.toFixed(1)}% → ${opp}`,
    );
    await placeOrder(
      wallet,
      p.tokenId,
      p.conditionId,
      opp,
      "BUY",
      Math.min(config.hedge.maxUsd, p.value),
    );
    hedged.add(p.tokenId);
  }
}

async function runScalp(
  wallet: Wallet,
  positions: Position[],
  config: PresetConfig,
) {
  if (!config.scalp.enabled) return;

  const targets = positions.filter(
    (p) =>
      p.pnlPct >= config.scalp.minProfitPct &&
      p.gainCents >= config.scalp.minGainCents,
  );

  for (const p of targets) {
    console.log(`[Scalp] ${p.tokenId.slice(0, 8)}... +${p.pnlPct.toFixed(1)}%`);
    await placeOrder(
      wallet,
      p.tokenId,
      p.conditionId,
      p.outcome,
      "SELL",
      p.value,
    );
  }
}

async function runStack(
  wallet: Wallet,
  walletAddr: string,
  positions: Position[],
  config: PresetConfig,
) {
  if (!config.stack.enabled) return;

  const targets = positions.filter(
    (p) =>
      p.gainCents >= config.stack.minGainCents &&
      p.curPrice < config.stack.maxPrice &&
      !stacked.has(p.tokenId),
  );

  for (const p of targets) {
    const buyCount = await getBuyCount(walletAddr, p.tokenId);
    if (buyCount >= 2) {
      stacked.add(p.tokenId);
      continue;
    }

    console.log(
      `[Stack] ${p.tokenId.slice(0, 8)}... +${p.gainCents.toFixed(0)}¢`,
    );
    await placeOrder(
      wallet,
      p.tokenId,
      p.conditionId,
      p.outcome,
      "BUY",
      config.stack.maxUsd,
    );
    stacked.add(p.tokenId);
  }
}

// === MAIN ===

async function cycle(wallet: Wallet, walletAddr: string, config: PresetConfig) {
  const positions = await getPositions(walletAddr);
  if (!positions.length) return;

  // Priority order (as documented):
  // 1. AutoSell (near $1) - guaranteed profit
  // 2. Hedge (moderate loss) - try to recover
  // 3. StopLoss (severe loss AND hedge disabled) - exit
  // 4. Scalp (in profit) - take profits
  // 5. Stack (winning) - add to winners
  await runAutoSell(wallet, positions, config);
  await runHedge(wallet, walletAddr, positions, config);
  // Stop-loss is only useful if hedging is disabled
  if (!config.hedge.enabled) {
    await runStopLoss(wallet, positions, config);
  }
  await runScalp(wallet, positions, config);
  await runStack(wallet, walletAddr, positions, config);
}

async function main() {
  console.log("=== Polymarket Trading Bot ===");

  const cfg = loadConfig();
  console.log(`Preset: ${cfg.preset}`);

  const provider = new JsonRpcProvider(cfg.rpcUrl);
  const wallet = new Wallet(cfg.privateKey, provider);
  const walletAddr = wallet.address.toLowerCase();

  console.log(`Wallet: ${walletAddr}`);

  initAlerts(cfg.telegram);
  await alert(
    "Bot Started",
    `Preset: ${cfg.preset}\nWallet: ${walletAddr.slice(0, 10)}...`,
  );

  // Run immediately then on interval with in-flight guard
  let cycleRunning = false;
  let skippedLogged = false;

  const runCycle = async () => {
    if (cycleRunning) {
      if (!skippedLogged) {
        console.log("[Cycle] Skipping - previous cycle still running");
        skippedLogged = true;
      }
      return;
    }
    cycleRunning = true;
    skippedLogged = false;
    try {
      await cycle(wallet, walletAddr, cfg.config);
    } catch (err) {
      console.error(`[Error] ${err}`);
    } finally {
      cycleRunning = false;
    }
  };

  await runCycle();
  setInterval(runCycle, cfg.intervalMs);

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    alert("Bot Stopped", "Graceful shutdown").then(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
