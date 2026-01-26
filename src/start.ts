/**
 * Polymarket Trading Bot V2
 * Clean, self-contained implementation
 *
 * REQUIRED:
 *   PRIVATE_KEY - Wallet private key (0x...)
 *   RPC_URL     - Polygon RPC endpoint
 *
 * OPTIONAL:
 *   STRATEGY_PRESET      - conservative | balanced | aggressive
 *   LIVE_TRADING         - "I_UNDERSTAND_THE_RISKS" to enable
 *   TARGET_ADDRESSES     - Comma-separated addresses to copy
 *   MAX_POSITION_USD     - Max USD per position
 *   TELEGRAM_BOT_TOKEN   - Telegram alerts
 *   TELEGRAM_CHAT_ID     - Telegram chat
 *   INTERVAL_MS          - Cycle interval (default: 5000)
 *   SCAVENGER_ENABLED    - Enable/disable scavenger mode (default: true)
 */

import "dotenv/config";
import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";

import {
  // Types
  type Position,
  type PresetConfig,
  type Logger,
  type PolReserveConfig,
  type ScavengerConfig,
  type ScavengerState,
  // Auth
  createClobClient,
  isLiveTradingEnabled,
  getAuthDiagnostics,
  // Config
  loadPreset,
  getMaxPositionUsd,
  TIMING,
  ORDER,
  // Data
  getPositions,
  invalidatePositions,
  getUsdcBalance,
  getPolBalance,
  getUsdcAllowance,
  // Trading
  postOrder,
  // Copy trading
  getTargetAddresses,
  fetchRecentTrades,
  // Notifications
  initTelegram,
  sendTelegram,
  // Redemption
  redeemAll,
  // VPN
  capturePreVpnRouting,
  startWireguard,
  startOpenvpn,
  setupRpcBypass,
  setupPolymarketReadBypass,
  checkVpnForTrading,
  // POL Reserve
  loadPolReserveConfig,
  runPolReserve,
  // Scavenger (unified module)
  TradingMode,
  loadScavengerConfig,
  createScavengerState,
  resetScavengerState,
  analyzeMarketConditions,
  recordVolumeSample,
  recordTargetActivity,
  recordOrderBookSnapshot,
  checkTargetActivity,
  fetchRecentVolume,
  fetchOrderBookDepth,
  runScavengerCycle,
  getScavengerSummary,
  isScavengerMode,
  formatModeState,
} from "./lib";

// ============ STATE ============

interface State {
  client?: ClobClient;
  wallet?: Wallet;
  address: string;
  config: PresetConfig;
  polReserveConfig: PolReserveConfig;
  scavengerConfig: ScavengerConfig;
  presetName: string;
  maxPositionUsd: number;
  liveTrading: boolean;
  targets: string[];
  // Tracking
  cycleCount: number;
  startTime: number;
  startBalance: number;
  tradesExecuted: number;
  // Memory
  stackedTokens: Set<string>;
  hedgedTokens: Set<string>;
  // Timing
  lastRedeem: number;
  lastSummary: number;
  lastPolReserveCheck: number;
  lastDetectionCheck: number;
  // Scavenger (unified state)
  scavengerState: ScavengerState;
}

const state: State = {
  address: "",
  config: {} as PresetConfig,
  polReserveConfig: {} as PolReserveConfig,
  scavengerConfig: {} as ScavengerConfig,
  presetName: "balanced",
  maxPositionUsd: 25,
  liveTrading: false,
  targets: [],
  cycleCount: 0,
  startTime: Date.now(),
  startBalance: 0,
  tradesExecuted: 0,
  stackedTokens: new Set(),
  hedgedTokens: new Set(),
  lastRedeem: 0,
  lastSummary: 0,
  lastPolReserveCheck: 0,
  lastDetectionCheck: 0,
  scavengerState: createScavengerState(),
};

// ============ LOGGER ============

const logger: Logger = {
  info: (msg) => console.log(`[${time()}] ${msg}`),
  warn: (msg) => console.log(`[${time()}] ⚠️ ${msg}`),
  error: (msg) => console.log(`[${time()}] ❌ ${msg}`),
};

function time(): string {
  return new Date().toISOString().substring(11, 19);
}

function $(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ============ TRADING ============

async function buy(
  tokenId: string,
  outcome: "YES" | "NO",
  sizeUsd: number,
  reason: string,
  marketId?: string,
  shares?: number,
): Promise<boolean> {
  if (!state.client) return false;

  // Apply absolute cap (overrides all strategies)
  const absoluteMaxUsd = parseFloat(process.env.ABSOLUTE_MAX_POSITION_USD ?? "50");
  const cappedSize = Math.min(sizeUsd, state.maxPositionUsd, absoluteMaxUsd);
  
  if (cappedSize < sizeUsd) {
    logger.warn(`⚠️  Position size capped: requested $${sizeUsd.toFixed(2)} → capped to $${cappedSize.toFixed(2)}`);
  }

  const size = cappedSize;

  if (!state.liveTrading) {
    logger.info(`🔸 [SIM] BUY ${outcome} ${$(size)} | ${reason}`);
    await sendTelegram("[SIM] BUY", `${reason}\n${outcome} ${$(size)}`);
    return true;
  }

  const result = await postOrder({
    client: state.client,
    tokenId,
    outcome,
    side: "BUY",
    sizeUsd: size,
    marketId,
    shares,
    logger,
  });

  if (result.success) {
    logger.info(
      `✅ BUY ${outcome} ${$(result.filledUsd ?? size)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢ | ${reason}`,
    );
    await sendTelegram(
      "BUY",
      `${reason}\n${outcome} ${$(result.filledUsd ?? size)}`,
    );
    state.tradesExecuted++;
    invalidatePositions();
    return true;
  }

  if (result.reason !== "SIMULATED") {
    logger.warn(`BUY failed: ${result.reason} | ${reason}`);
  }
  return false;
}

async function sell(
  tokenId: string,
  outcome: "YES" | "NO",
  sizeUsd: number,
  reason: string,
  shares?: number,
): Promise<boolean> {
  if (!state.client) return false;

  if (!state.liveTrading) {
    logger.info(`🔸 [SIM] SELL ${outcome} ${$(sizeUsd)} | ${reason}`);
    await sendTelegram("[SIM] SELL", `${reason}\n${outcome} ${$(sizeUsd)}`);
    return true;
  }

  const result = await postOrder({
    client: state.client,
    tokenId,
    outcome,
    side: "SELL",
    sizeUsd,
    shares,
    skipDuplicateCheck: true,
    logger,
  });

  if (result.success) {
    logger.info(
      `✅ SELL ${outcome} ${$(result.filledUsd ?? sizeUsd)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢ | ${reason}`,
    );
    await sendTelegram(
      "SELL",
      `${reason}\n${outcome} ${$(result.filledUsd ?? sizeUsd)}`,
    );
    state.tradesExecuted++;
    invalidatePositions();
    return true;
  }

  if (result.reason !== "SIMULATED") {
    logger.warn(`SELL failed: ${result.reason} | ${reason}`);
  }
  return false;
}

// ============ STRATEGIES ============

async function runAutoSell(positions: Position[]): Promise<void> {
  const cfg = state.config.autoSell;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (p.curPrice >= cfg.threshold) {
      await sell(
        p.tokenId,
        p.outcome as "YES" | "NO",
        p.value,
        `AutoSell (${(p.curPrice * 100).toFixed(0)}¢)`,
        p.size,
      );
    }
  }
}

async function runHedge(positions: Position[]): Promise<void> {
  const cfg = state.config.hedge;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (state.hedgedTokens.has(p.tokenId)) continue;
    if (p.pnlPct >= 0 || Math.abs(p.pnlPct) < cfg.triggerPct) continue;

    const opposite = p.outcome === "YES" ? "NO" : "YES";
    const maxHedge = cfg.allowExceedMax ? cfg.absoluteMaxUsd : cfg.maxUsd;
    const hedgeSize = Math.min(maxHedge, p.value * 0.5);

    const success = await buy(
      p.tokenId,
      opposite,
      hedgeSize,
      `Hedge (${p.pnlPct.toFixed(1)}%)`,
      p.marketId,
    );

    if (success) state.hedgedTokens.add(p.tokenId);
  }
}

async function runStopLoss(positions: Position[]): Promise<void> {
  const cfg = state.config.stopLoss;
  if (!cfg.enabled || state.config.hedge.enabled) return;

  for (const p of positions) {
    if (p.pnlPct < 0 && Math.abs(p.pnlPct) >= cfg.maxLossPct) {
      await sell(
        p.tokenId,
        p.outcome as "YES" | "NO",
        p.value,
        `StopLoss (${p.pnlPct.toFixed(1)}%)`,
        p.size,
      );
    }
  }
}

async function runScalp(positions: Position[]): Promise<void> {
  const cfg = state.config.scalp;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (
      p.pnlPct >= cfg.minProfitPct &&
      p.gainCents >= cfg.minGainCents &&
      p.pnlUsd >= cfg.minProfitUsd
    ) {
      await sell(
        p.tokenId,
        p.outcome as "YES" | "NO",
        p.value,
        `Scalp (+${p.pnlPct.toFixed(1)}%)`,
        p.size,
      );
    }
  }
}

async function runStack(positions: Position[]): Promise<void> {
  const cfg = state.config.stack;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (state.stackedTokens.has(p.tokenId)) continue;
    if (p.gainCents < cfg.minGainCents || p.curPrice > cfg.maxPrice) continue;
    if (p.curPrice < ORDER.GLOBAL_MIN_BUY_PRICE) continue;

    const success = await buy(
      p.tokenId,
      p.outcome as "YES" | "NO",
      cfg.maxUsd,
      `Stack (+${p.gainCents.toFixed(0)}¢)`,
      p.marketId,
    );

    if (success) state.stackedTokens.add(p.tokenId);
  }
}

async function runEndgame(positions: Position[]): Promise<void> {
  const cfg = state.config.endgame;
  if (!cfg.enabled) return;

  for (const p of positions) {
    if (p.curPrice < cfg.minPrice || p.curPrice > cfg.maxPrice) continue;
    if (p.pnlPct <= 0) continue;

    await buy(
      p.tokenId,
      p.outcome as "YES" | "NO",
      cfg.maxUsd,
      `Endgame (${(p.curPrice * 100).toFixed(0)}¢)`,
      p.marketId,
    );
  }
}

async function runCopyTrading(): Promise<void> {
  if (state.targets.length === 0) return;

  const trades = await fetchRecentTrades(state.targets);
  const cfg = state.config.copy;

  // Debug: Log trade processing info at debug level
  let filtered = { sell: 0, lowPrice: 0, tooSmall: 0 };
  let processed = 0;

  for (const t of trades) {
    if (t.side !== "BUY") {
      filtered.sell++;
      continue;
    }
    if (t.price < cfg.minBuyPrice) {
      filtered.lowPrice++;
      continue;
    }

    const size = Math.min(
      Math.max(t.sizeUsd * cfg.multiplier, cfg.minUsd),
      cfg.maxUsd,
      state.maxPositionUsd,
    );

    if (size < cfg.minUsd) {
      filtered.tooSmall++;
      continue;
    }

    processed++;
    await buy(
      t.tokenId,
      t.outcome as "YES" | "NO",
      size,
      `Copy (${t.trader.slice(0, 8)}...)`,
      t.marketId,
    );
  }

  // Log copy trading activity for debugging
  if (trades.length > 0) {
    const totalFiltered = filtered.sell + filtered.lowPrice + filtered.tooSmall;
    if (totalFiltered === trades.length) {
      logger.info(`Copy: ${trades.length} trades filtered (${filtered.sell} sell, ${filtered.lowPrice} low price, ${filtered.tooSmall} too small)`);
    } else if (processed > 0) {
      logger.info(`Copy: ${processed}/${trades.length} trades processed (${totalFiltered} filtered)`);
    }
  }
}

async function runRedeem(): Promise<void> {
  const cfg = state.config.redeem;
  if (!cfg.enabled || !state.wallet) return;

  const now = Date.now();
  if (now - state.lastRedeem < cfg.intervalMin * 60 * 1000) return;

  state.lastRedeem = now;
  
  // Log redemption check start
  logger.info(`💰 [REDEEM] Checking positions for redemption...`);
  
  const count = await redeemAll(
    state.wallet,
    state.address,
    cfg.minPositionUsd,
    logger,
  );

  if (count > 0) {
    logger.info(`✅ [REDEEM] Redeemed ${count} positions`);
    await sendTelegram("Redeem", `Redeemed ${count} positions`);
    invalidatePositions();
  } else {
    logger?.debug?.(`[REDEEM] No positions ready for redemption`);
  }
}

async function runPolReserveCheck(): Promise<void> {
  const cfg = state.polReserveConfig;
  if (!cfg.enabled || !state.wallet || !state.liveTrading) return;

  const now = Date.now();
  if (now - state.lastPolReserveCheck < cfg.checkIntervalMin * 60 * 1000)
    return;

  state.lastPolReserveCheck = now;

  // Get current balances
  const currentPol = await getPolBalance(state.wallet, state.address);
  const availableUsdc = await getUsdcBalance(state.wallet, state.address);

  // Run POL reserve check and rebalance if needed
  const result = await runPolReserve(
    state.wallet,
    state.address,
    currentPol,
    availableUsdc,
    cfg,
    logger,
  );

  if (result?.success) {
    await sendTelegram(
      "💱 POL Rebalance",
      `Swapped $${result.usdcSwapped?.toFixed(2)} USDC → ${result.polReceived?.toFixed(2)} POL`,
    );
  } else if (result?.error) {
    await sendTelegram("❌ POL Rebalance Failed", result.error);
  }
}

// ============ SCAVENGER MODE ============

/**
 * Check market conditions and potentially switch trading modes
 */
async function runModeDetection(positions: Position[]): Promise<void> {
  const cfg = state.scavengerConfig;
  if (!cfg.enabled) return;

  const now = Date.now();
  const DETECTION_INTERVAL_MS = 30000; // Check every 30 seconds

  if (now - state.lastDetectionCheck < DETECTION_INTERVAL_MS) return;
  state.lastDetectionCheck = now;

  // Gather market data in parallel to minimize blocking
  const tokenIds = positions.map((p) => p.tokenId);

  const [volume, targetActivity, orderBookDepth] = await Promise.all([
    fetchRecentVolume(tokenIds),
    checkTargetActivity(state.targets, cfg.detection.targetActivityWindowMs),
    state.client
      ? fetchOrderBookDepth(state.client, tokenIds)
      : Promise.resolve({ avgBidDepthUsd: 0, avgAskDepthUsd: 0, bestBid: 0, bestAsk: 0 }),
  ]);

  // Record samples
  state.scavengerState = recordVolumeSample(
    state.scavengerState,
    volume,
    cfg.detection.volumeWindowMs,
  );
  state.scavengerState = recordTargetActivity(
    state.scavengerState,
    targetActivity.activeCount,
    targetActivity.totalCount,
    cfg.detection.targetActivityWindowMs,
  );
  state.scavengerState = recordOrderBookSnapshot(
    state.scavengerState,
    {
      bidDepthUsd: orderBookDepth.avgBidDepthUsd,
      askDepthUsd: orderBookDepth.avgAskDepthUsd,
      bestBid: orderBookDepth.bestBid,
      bestAsk: orderBookDepth.bestAsk,
    },
    cfg.detection.stagnantBookThresholdMs,
  );

  // Analyze conditions and handle mode transitions
  const { shouldSwitch, newMode, reasons, newState } = analyzeMarketConditions(
    state.scavengerState,
    cfg,
    logger,
  );
  state.scavengerState = newState;

  // Send notifications on mode switch
  if (shouldSwitch) {
    if (newMode === TradingMode.SCAVENGER) {
      await sendTelegram(
        "🦅 Scavenger Mode Activated",
        `Low liquidity detected\nReasons: ${reasons.join(", ")}`,
      );
    } else {
      state.scavengerState = resetScavengerState(state.scavengerState);
      await sendTelegram(
        "🔄 Normal Mode Restored",
        `Market activity recovered`,
      );
    }
  }
}

/**
 * Run scavenger mode logic (position management in low liquidity)
 */
async function runScavengerMode(positions: Position[]): Promise<void> {
  if (!state.client) return;
  if (!isScavengerMode(state.scavengerState)) return;

  const cfg = state.scavengerConfig;
  const balance = state.wallet ? await getUsdcBalance(state.wallet, state.address) : 0;

  logger.info(`🦅 [SCAVENGER MODE] Active | Positions: ${positions.length} | Balance: $${balance.toFixed(2)} | Deployed: $${state.scavengerState.deployedCapitalUsd.toFixed(2)}`);

  // Run scavenger cycle
  const { results, newState } = await runScavengerCycle(
    state.client,
    positions,
    state.scavengerState,
    cfg,
    balance,
    logger,
  );

  state.scavengerState = newState;

  // Log summary of actions
  const executions = results.filter((r) => r.action !== "NONE" && r.orderResult?.success);
  if (executions.length > 0) {
    logger.info(`🦅 [SCAVENGER SUMMARY] Executed ${executions.length} actions in this cycle`);
  }

  // Update trade count
  state.tradesExecuted += executions.length;

  // Send notifications for significant actions
  for (const result of executions) {
    if (result.action === "EXIT_GREEN" || result.action === "EXIT_RED_RECOVERY") {
      await sendTelegram(
        `🦅 ${result.action === "EXIT_GREEN" ? "Green Exit" : "Recovery Exit"}`,
        `${result.outcome} | $${result.sizeUsd?.toFixed(2)} | ${result.reason}`,
      );
      invalidatePositions();
    }
  }
}

// ============ MAIN CYCLE ============

async function runCycle(): Promise<void> {
  state.cycleCount++;

  const positions = await getPositions(state.address);

  // Run mode detection (checks for mode transitions)
  await runModeDetection(positions);

  // Check current mode and run appropriate strategies
  if (isScavengerMode(state.scavengerState)) {
    // SCAVENGER MODE: Conservative capital preservation
    // Only run essential strategies + scavenger logic
    await runAutoSell(positions); // Still exit at high prices
    await runScavengerMode(positions); // Scavenger-specific logic
    await runRedeem();
    await runPolReserveCheck();

    // NO copy trading, stacking, hedging, or endgame in scavenger mode
    // These could deploy capital in unfavorable conditions
  } else {
    // NORMAL MODE: Full strategy execution
    await runCopyTrading();
    await runAutoSell(positions);
    await runHedge(positions);
    await runStopLoss(positions);
    await runScalp(positions);
    await runStack(positions);
    await runEndgame(positions);
    await runRedeem();
    await runPolReserveCheck();
  }
}

// ============ SUMMARY ============

async function printSummary(): Promise<void> {
  const positions = await getPositions(state.address, true);
  const balance = state.wallet
    ? await getUsdcBalance(state.wallet, state.address)
    : 0;

  const totalValue = positions.reduce((s, p) => s + p.value, 0);
  const totalPnl = positions.reduce((s, p) => s + p.pnlUsd, 0);
  const equity = balance + totalValue;
  const sessionPnl = equity - state.startBalance;

  const summaryLines = [
    `💰 Balance: ${$(balance)}`,
    `📊 Positions: ${positions.length} (${$(totalValue)})`,
    `📈 Unrealized: ${totalPnl >= 0 ? "+" : ""}${$(totalPnl)}`,
    `📊 Session: ${sessionPnl >= 0 ? "+" : ""}${$(sessionPnl)}`,
    `🔄 Trades: ${state.tradesExecuted}`,
    `⚙️ ${formatModeState(state.scavengerState)}`,
  ];

  // Add scavenger summary if in scavenger mode
  if (isScavengerMode(state.scavengerState)) {
    summaryLines.push(getScavengerSummary(state.scavengerState, state.scavengerConfig));
  }

  const summary = summaryLines.join("\n");

  logger.info(`\n=== Summary ===\n${summary}\n===============`);
  await sendTelegram("📊 Summary", summary);
}

// ============ STARTUP ============

async function main(): Promise<void> {
  console.log("\n=== Polymarket Trading Bot V2 ===\n");

  // Load config
  const { name, config } = loadPreset();
  state.presetName = name;
  state.config = config;
  state.polReserveConfig = loadPolReserveConfig(config);
  state.scavengerConfig = loadScavengerConfig();
  state.maxPositionUsd = getMaxPositionUsd(config);
  state.liveTrading = isLiveTradingEnabled();

  logger.info(`Preset: ${name}`);
  logger.info(`Max Position: ${$(state.maxPositionUsd)}`);
  logger.info(`Live Trading: ${state.liveTrading ? "ENABLED" : "DISABLED"}`);
  logger.info(`POL Reserve: ${state.polReserveConfig.enabled ? `ON (target: ${state.polReserveConfig.targetPol} POL)` : "OFF"}`);
  logger.info(`Scavenger Mode: ${state.scavengerConfig.enabled ? "ENABLED" : "DISABLED"}`);

  // Debug: Log exact LIVE_TRADING value to catch typos/whitespace
  if (!state.liveTrading) {
    const rawValue = process.env.LIVE_TRADING ?? process.env.ARB_LIVE_TRADING ?? "";
    if (rawValue && rawValue !== "I_UNDERSTAND_THE_RISKS") {
      logger.warn(`LIVE_TRADING value "${rawValue}" is not valid. Expected exact string: "I_UNDERSTAND_THE_RISKS"`);
    } else if (!rawValue) {
      logger.warn(`LIVE_TRADING not set - running in SIMULATION mode (no real trades will execute)`);
    }
  }

  // Telegram
  initTelegram();

  // VPN Setup - IMPORTANT: Capture pre-VPN routing BEFORE starting VPN
  // This allows us to set up bypass routes for RPC and reads after VPN starts
  const rpcUrl = process.env.RPC_URL ?? "";
  await capturePreVpnRouting(logger);

  // Start VPN (OpenVPN takes priority over WireGuard)
  const ovpn = await startOpenvpn(logger);
  if (!ovpn) await startWireguard(logger);

  // Setup bypass routes AFTER VPN is up (uses pre-VPN gateway)
  // - RPC bypass: blockchain reads go direct for speed
  // - Polymarket read bypass: orderbooks/markets go direct for speed
  // - Auth and orders still route through VPN for geo-blocking
  await setupRpcBypass(rpcUrl, logger);
  await setupPolymarketReadBypass(logger);

  // Check VPN status for live trading
  if (state.liveTrading) {
    checkVpnForTrading(logger);
  }

  // Auth (routes through VPN if active - for geo-blocking)
  logger.info("Authenticating...");
  const auth = await createClobClient(
    process.env.PRIVATE_KEY ?? "",
    rpcUrl,
    logger,
  );

  if (!auth.success || !auth.client || !auth.wallet) {
    logger.error(`Auth failed: ${auth.error}`);
    process.exit(1);
  }

  state.client = auth.client;
  state.wallet = auth.wallet;
  state.address = auth.address ?? "";

  // === AUTH DIAGNOSTICS ===
  const signerAddress = state.wallet.address;
  const effectiveAddress = state.address;
  const diag = getAuthDiagnostics(signerAddress, effectiveAddress);

  logger.info(`\n=== Auth Diagnostics ===`);
  logger.info(
    `Signature Type: ${diag.signatureType} (${diag.signatureTypeLabel})`,
  );
  logger.info(
    `Signer Address: ${signerAddress.slice(0, 10)}...${signerAddress.slice(-4)}`,
  );
  logger.info(
    `Effective Address: ${effectiveAddress.slice(0, 10)}...${effectiveAddress.slice(-4)}`,
  );
  if (diag.proxyAddress) {
    logger.info(
      `Configured Proxy: ${diag.proxyAddress.slice(0, 10)}...${diag.proxyAddress.slice(-4)}`,
    );
  }
  logger.info(
    `Mode: ${diag.isProxyMode ? "Proxy/Safe (signer ≠ funder)" : "EOA (signer = funder)"}`,
  );
  logger.info(`========================\n`);

  // Balances - check the effective address (funder), not just signer
  const usdc = await getUsdcBalance(state.wallet, state.address);
  const pol = await getPolBalance(state.wallet, state.address);
  const allowance = await getUsdcAllowance(state.wallet, state.address);

  logger.info(`USDC Balance: ${$(usdc)}`);
  logger.info(`USDC Allowance: ${$(allowance)}`);
  logger.info(`POL: ${pol.toFixed(4)}`);

  // Warn if allowance might cause issues (only relevant for live trading)
  if (state.liveTrading) {
    if (allowance === 0) {
      logger.warn(
        `⚠️ No USDC allowance set. Orders will fail. Approve CTF Exchange first.`,
      );
    } else if (allowance < usdc && usdc > 0) {
      logger.warn(
        `⚠️ Allowance (${$(allowance)}) < Balance (${$(usdc)}). Large orders may fail.`,
      );
    }
  }

  state.startBalance = usdc;

  // Targets
  state.targets = await getTargetAddresses();
  logger.info(`Copy targets: ${state.targets.length}`);

  // Startup notification
  await sendTelegram(
    "🚀 Bot Started",
    [
      `Preset: ${name}`,
      `Wallet: ${state.address.slice(0, 10)}...`,
      `Balance: ${$(usdc)}`,
      `Allowance: ${$(allowance)}`,
      `Live: ${state.liveTrading ? "YES" : "NO"}`,
    ].join("\n"),
  );

  // Main loop
  const interval = parseInt(
    process.env.INTERVAL_MS ?? String(TIMING.CYCLE_MS),
    10,
  );
  logger.info(`\nStarting (${interval}ms interval)...\n`);

  const loop = async () => {
    try {
      await runCycle();

      // Periodic summary
      const now = Date.now();
      if (now - state.lastSummary > TIMING.SUMMARY_INTERVAL_MS) {
        state.lastSummary = now;
        await printSummary();
      }
    } catch (err) {
      logger.error(`Cycle error: ${err}`);
    }
  };

  await loop();
  setInterval(loop, interval);

  // Shutdown
  process.on("SIGINT", async () => {
    logger.info("\nShutting down...");
    await printSummary();
    await sendTelegram("🛑 Bot Stopped", "Graceful shutdown");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
