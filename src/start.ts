/**
 * Polymarket Trading Bot V2
 * Clean, simple implementation with no V1 dependencies
 *
 * REQUIRED ENV:
 *   PRIVATE_KEY          - Wallet private key (0x...)
 *   RPC_URL              - Polygon RPC endpoint
 *
 * OPTIONAL:
 *   STRATEGY_PRESET      - conservative | balanced | aggressive (default: balanced)
 *   LIVE_TRADING         - Set to "I_UNDERSTAND_THE_RISKS" to enable real trades
 *   TARGET_ADDRESSES     - Comma-separated addresses to copy (or fetches from leaderboard)
 *   MAX_POSITION_USD     - Max USD per position (overrides preset)
 *   TELEGRAM_BOT_TOKEN   - Telegram bot token for alerts
 *   TELEGRAM_CHAT_ID     - Telegram chat ID for alerts
 *   INTERVAL_MS          - Cycle interval in ms (default: 5000)
 */

import "dotenv/config";
import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";
import axios from "axios";

import {
  createClobClient,
  isLiveTradingEnabled,
  postOrder,
  getPositions,
  invalidatePositionCache,
  getUsdcBalance,
  getPolBalance,
  initTelegramFromEnv,
  sendTelegram,
  loadPreset,
  getMaxPositionUsd,
  getTargetAddresses,
  POLYMARKET_API,
  TIMING,
  ORDER_SETTINGS,
  type Position,
  type PresetConfig,
  type PostOrderResult,
} from "./lib";

// ============ TYPES ============

interface BotState {
  client: ClobClient | undefined;
  wallet: Wallet | undefined;
  address: string;
  config: PresetConfig;
  presetName: string;
  maxPositionUsd: number;
  liveTrading: boolean;
  targetAddresses: string[];
  // Tracking
  cycleCount: number;
  startTime: number;
  startBalance: number;
  tradesExecuted: number;
  // Stacking memory (only stack once per token)
  stackedTokens: Set<string>;
  // Hedged memory (only hedge once per token)
  hedgedTokens: Set<string>;
}

// ============ STATE ============

const state: BotState = {
  client: undefined,
  wallet: undefined,
  address: "",
  config: {} as PresetConfig,
  presetName: "balanced",
  maxPositionUsd: 25,
  liveTrading: false,
  targetAddresses: [],
  cycleCount: 0,
  startTime: Date.now(),
  startBalance: 0,
  tradesExecuted: 0,
  stackedTokens: new Set(),
  hedgedTokens: new Set(),
};

// ============ UTILITIES ============

function log(msg: string): void {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`[${timestamp}] ${msg}`);
}

function $(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ============ TRADE EXECUTION ============

async function executeBuy(
  tokenId: string,
  outcome: "YES" | "NO",
  sizeUsd: number,
  reason: string,
): Promise<boolean> {
  if (!state.client) {
    log(`❌ BUY | ${reason} | No client`);
    return false;
  }

  if (!state.liveTrading) {
    log(`🔸 [SIM] BUY | ${reason} | ${outcome} ${$(sizeUsd)}`);
    await sendTelegram("Simulated BUY", `${reason}\n${outcome} ${$(sizeUsd)}`);
    return true;
  }

  try {
    const result = await postOrder({
      client: state.client,
      tokenId,
      outcome,
      side: "BUY",
      sizeUsd,
    });

    if (result.success) {
      log(`✅ BUY | ${reason} | ${outcome} ${$(sizeUsd)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢`);
      await sendTelegram("BUY Executed", `${reason}\n${outcome} ${$(result.filledUsd ?? sizeUsd)}`);
      state.tradesExecuted++;
      invalidatePositionCache();
      return true;
    } else {
      log(`❌ BUY | ${reason} | ${result.reason}`);
      return false;
    }
  } catch (err) {
    log(`❌ BUY | ${reason} | Error: ${err}`);
    return false;
  }
}

async function executeSell(
  tokenId: string,
  outcome: "YES" | "NO",
  sizeUsd: number,
  reason: string,
): Promise<boolean> {
  if (!state.client) {
    log(`❌ SELL | ${reason} | No client`);
    return false;
  }

  if (!state.liveTrading) {
    log(`🔸 [SIM] SELL | ${reason} | ${outcome} ${$(sizeUsd)}`);
    await sendTelegram("Simulated SELL", `${reason}\n${outcome} ${$(sizeUsd)}`);
    return true;
  }

  try {
    const result = await postOrder({
      client: state.client,
      tokenId,
      outcome,
      side: "SELL",
      sizeUsd,
    });

    if (result.success) {
      log(`✅ SELL | ${reason} | ${outcome} ${$(sizeUsd)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢`);
      await sendTelegram("SELL Executed", `${reason}\n${outcome} ${$(result.filledUsd ?? sizeUsd)}`);
      state.tradesExecuted++;
      invalidatePositionCache();
      return true;
    } else {
      log(`❌ SELL | ${reason} | ${result.reason}`);
      return false;
    }
  } catch (err) {
    log(`❌ SELL | ${reason} | Error: ${err}`);
    return false;
  }
}

// ============ STRATEGIES ============

/**
 * Auto-sell positions near $1 (guaranteed profit)
 */
async function runAutoSell(positions: Position[]): Promise<void> {
  const cfg = state.config.autoSell;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (p.curPrice >= cfg.threshold) {
      await executeSell(p.tokenId, p.outcome as "YES" | "NO", p.value, "AutoSell (near $1)");
    }
  }
}

/**
 * Hedge losing positions (buy opposite side)
 */
async function runHedge(positions: Position[]): Promise<void> {
  const cfg = state.config.hedge;
  if (!cfg.enabled) return;

  for (const p of positions) {
    // Skip if already hedged
    if (state.hedgedTokens.has(p.tokenId)) continue;

    // Check if position is losing enough to hedge
    if (p.pnlPct < 0 && Math.abs(p.pnlPct) >= cfg.triggerPct) {
      const oppositeOutcome = p.outcome === "YES" ? "NO" : "YES";
      const hedgeSize = Math.min(cfg.maxUsd, p.value * 0.5);

      const success = await executeBuy(
        p.tokenId,
        oppositeOutcome,
        hedgeSize,
        `Hedge (${p.pnlPct.toFixed(1)}% loss)`,
      );

      if (success) {
        state.hedgedTokens.add(p.tokenId);
      }
    }
  }
}

/**
 * Stop-loss for severe losses (only if hedge disabled)
 */
async function runStopLoss(positions: Position[]): Promise<void> {
  const cfg = state.config.stopLoss;
  if (!cfg.enabled) return;

  // Skip if hedging is enabled (hedge takes priority)
  if (state.config.hedge.enabled) return;

  for (const p of positions) {
    if (p.pnlPct < 0 && Math.abs(p.pnlPct) >= cfg.maxLossPct) {
      await executeSell(p.tokenId, p.outcome as "YES" | "NO", p.value, `StopLoss (${p.pnlPct.toFixed(1)}%)`);
    }
  }
}

/**
 * Scalp - take profits on winners
 */
async function runScalp(positions: Position[]): Promise<void> {
  const cfg = state.config.scalp;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (
      p.pnlPct >= cfg.minProfitPct &&
      p.gainCents >= cfg.minGainCents &&
      p.pnlUsd >= cfg.minProfitUsd
    ) {
      await executeSell(p.tokenId, p.outcome as "YES" | "NO", p.value, `Scalp (+${p.pnlPct.toFixed(1)}%)`);
    }
  }
}

/**
 * Stack - buy more of winning positions (once per token)
 */
async function runStack(positions: Position[]): Promise<void> {
  const cfg = state.config.stack;
  if (!cfg.enabled) return;

  for (const p of positions) {
    // Skip if already stacked
    if (state.stackedTokens.has(p.tokenId)) continue;

    if (
      p.gainCents >= cfg.minGainCents &&
      p.curPrice <= cfg.maxPrice &&
      p.curPrice > ORDER_SETTINGS.GLOBAL_MIN_BUY_PRICE
    ) {
      const stackSize = Math.min(cfg.maxUsd, state.maxPositionUsd);

      const success = await executeBuy(
        p.tokenId,
        p.outcome as "YES" | "NO",
        stackSize,
        `Stack (+${p.gainCents.toFixed(0)}¢)`,
      );

      if (success) {
        state.stackedTokens.add(p.tokenId);
      }
    }
  }
}

/**
 * Endgame - buy high-probability positions near resolution
 */
async function runEndgame(positions: Position[]): Promise<void> {
  const cfg = state.config.endgame;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (
      p.curPrice >= cfg.minPrice &&
      p.curPrice <= cfg.maxPrice &&
      p.pnlPct > 0 // Only on winning positions
    ) {
      const endgameSize = Math.min(cfg.maxUsd, state.maxPositionUsd);

      await executeBuy(
        p.tokenId,
        p.outcome as "YES" | "NO",
        endgameSize,
        `Endgame (${(p.curPrice * 100).toFixed(0)}¢)`,
      );
    }
  }
}

// ============ COPY TRADING ============

interface TradeActivity {
  tokenId: string;
  conditionId: string;
  outcome: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  price: number;
  trader: string;
  timestamp: number;
}

const seenTrades = new Set<string>();

async function fetchRecentTrades(addresses: string[]): Promise<TradeActivity[]> {
  const trades: TradeActivity[] = [];

  for (const addr of addresses.slice(0, 10)) {
    try {
      const url = `${POLYMARKET_API.DATA_API}/trades?user=${addr}&limit=5`;
      const { data } = await axios.get(url, { timeout: 5000 });

      if (!Array.isArray(data)) continue;

      for (const t of data) {
        const tradeKey = `${t.id || t.timestamp}-${addr}`;
        if (seenTrades.has(tradeKey)) continue;

        const timestamp = new Date(t.timestamp || t.createdAt).getTime();
        const ageMs = Date.now() - timestamp;

        // Only recent trades (last 60 seconds)
        if (ageMs > 60000) continue;

        seenTrades.add(tradeKey);
        trades.push({
          tokenId: t.asset || t.tokenId,
          conditionId: t.conditionId,
          outcome: t.outcome || "YES",
          side: t.side?.toUpperCase() === "SELL" ? "SELL" : "BUY",
          sizeUsd: Number(t.size) * Number(t.price) || 0,
          price: Number(t.price) || 0,
          trader: addr,
          timestamp,
        });
      }
    } catch {
      // Continue on error
    }
  }

  return trades;
}

async function runCopyTrading(): Promise<void> {
  if (state.targetAddresses.length === 0) return;

  const trades = await fetchRecentTrades(state.targetAddresses);
  const cfg = state.config.copy;

  for (const trade of trades) {
    // Only copy BUY trades
    if (trade.side !== "BUY") continue;

    // Filter by price
    if (trade.price < cfg.minBuyPrice) continue;

    // Calculate copy size
    const copySize = Math.min(
      Math.max(trade.sizeUsd * cfg.multiplier, cfg.minUsd),
      cfg.maxUsd,
      state.maxPositionUsd,
    );

    if (copySize < cfg.minUsd) continue;

    await executeBuy(
      trade.tokenId,
      trade.outcome as "YES" | "NO",
      copySize,
      `Copy (${trade.trader.slice(0, 8)}...)`,
    );
  }
}

// ============ MAIN CYCLE ============

async function runCycle(): Promise<void> {
  state.cycleCount++;

  // Get positions
  const positions = await getPositions(state.address);

  if (positions.length === 0 && state.cycleCount === 1) {
    log("📊 No active positions found");
  }

  // Run strategies in priority order:
  // 1. Copy trades (new opportunities)
  await runCopyTrading();

  // 2. Auto-sell near $1 (lock in profits)
  await runAutoSell(positions);

  // 3. Hedge losing positions (protect capital)
  await runHedge(positions);

  // 4. Stop-loss (only if hedge disabled)
  await runStopLoss(positions);

  // 5. Scalp profits
  await runScalp(positions);

  // 6. Stack winners
  await runStack(positions);

  // 7. Endgame buys
  await runEndgame(positions);
}

// ============ SUMMARY ============

async function printSummary(): Promise<void> {
  const positions = await getPositions(state.address, true);
  const balance = state.wallet ? await getUsdcBalance(state.wallet) : 0;

  const totalValue = positions.reduce((sum, p) => sum + p.value, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.pnlUsd, 0);
  const equity = balance + totalValue;
  const sessionPnl = equity - state.startBalance;

  const summary = [
    `💰 Balance: ${$(balance)}`,
    `📊 Positions: ${positions.length} (${$(totalValue)})`,
    `📈 Session P&L: ${sessionPnl >= 0 ? "+" : ""}${$(sessionPnl)}`,
    `🔄 Trades: ${state.tradesExecuted}`,
  ].join("\n");

  log(`\n=== Summary ===\n${summary}\n===============`);
  await sendTelegram("📊 Summary", summary);
}

// ============ STARTUP ============

async function main(): Promise<void> {
  console.log("\n=== Polymarket Trading Bot V2 ===\n");

  // Load configuration
  const { name: presetName, config: presetConfig } = loadPreset();
  state.presetName = presetName;
  state.config = presetConfig;
  state.maxPositionUsd = getMaxPositionUsd(presetConfig);
  state.liveTrading = isLiveTradingEnabled();

  log(`📋 Preset: ${presetName}`);
  log(`💵 Max Position: ${$(state.maxPositionUsd)}`);
  log(`🔴 Live Trading: ${state.liveTrading ? "ENABLED" : "DISABLED (simulation)"}`);

  // Initialize Telegram
  initTelegramFromEnv();

  // Authenticate
  log("🔐 Authenticating...");
  const authResult = await createClobClient({
    privateKey: process.env.PRIVATE_KEY ?? "",
    rpcUrl: process.env.RPC_URL ?? "",
  });

  if (!authResult.success || !authResult.client || !authResult.wallet) {
    console.error(`❌ Authentication failed: ${authResult.error}`);
    process.exit(1);
  }

  state.client = authResult.client;
  state.wallet = authResult.wallet;
  state.address = authResult.address ?? "";

  log(`✅ Authenticated: ${state.address.slice(0, 10)}...`);

  // Get balances
  const usdcBalance = await getUsdcBalance(state.wallet);
  const polBalance = await getPolBalance(state.wallet);

  log(`💵 USDC: ${$(usdcBalance)}`);
  log(`⛽ POL: ${polBalance.toFixed(4)}`);

  state.startBalance = usdcBalance;

  // Get target addresses for copy trading
  state.targetAddresses = await getTargetAddresses();
  log(`👥 Copy targets: ${state.targetAddresses.length} addresses`);

  // Send startup notification
  await sendTelegram(
    "🚀 Bot Started",
    [
      `Preset: ${presetName}`,
      `Wallet: ${state.address.slice(0, 10)}...`,
      `Balance: ${$(usdcBalance)}`,
      `Live: ${state.liveTrading ? "YES" : "NO"}`,
    ].join("\n"),
  );

  // Main loop
  const intervalMs = parseInt(process.env.INTERVAL_MS ?? String(TIMING.DEFAULT_CYCLE_MS), 10);
  log(`\n🔄 Starting main loop (${intervalMs}ms interval)...\n`);

  let lastSummary = Date.now();

  const runLoop = async () => {
    try {
      await runCycle();

      // Periodic summary
      if (Date.now() - lastSummary > TIMING.TELEGRAM_SUMMARY_INTERVAL_MS) {
        await printSummary();
        lastSummary = Date.now();
      }
    } catch (err) {
      console.error(`[Cycle Error] ${err}`);
    }
  };

  // Run immediately then on interval
  await runLoop();
  setInterval(runLoop, intervalMs);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    log("\n🛑 Shutting down...");
    await printSummary();
    await sendTelegram("🛑 Bot Stopped", "Graceful shutdown");
    process.exit(0);
  });
}

// Start
main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
