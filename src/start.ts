/**
 * ⚡ APEX v3.0 - Aggressive Polymarket Execution
 * 
 * Next-generation trading bot with:
 * - Dynamic position scaling (percentage-based)
 * - Account tier detection (Entry → Elite)
 * - APEX Hunter (active market scanner)
 * - APEX Oracle (daily performance review)
 * - One-line configuration (APEX_MODE=AGGRESSIVE)
 *
 * REQUIRED:
 *   PRIVATE_KEY - Wallet private key (0x...)
 *   RPC_URL     - Polygon RPC endpoint
 *
 * OPTIONAL:
 *   APEX_MODE            - CONSERVATIVE | BALANCED | AGGRESSIVE (default: BALANCED)
 *   LIVE_TRADING         - "I_UNDERSTAND_THE_RISKS" to enable
 *   TARGET_ADDRESSES     - Comma-separated addresses to copy
 *   TELEGRAM_BOT_TOKEN   - Telegram alerts
 *   TELEGRAM_CHAT_ID     - Telegram chat
 *   INTERVAL_MS          - Cycle interval (default: 5000)
 */

import "dotenv/config";
import type { ClobClient } from "@polymarket/clob-client";
import type { Wallet } from "ethers";

import {
  // Types
  type Position,
  type Logger,
  // Auth
  createClobClient,
  isLiveTradingEnabled,
  getAuthDiagnostics,
  // Config
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
} from "./lib";

// APEX v3.0 Core Modules
import {
  getApexMode,
  type ModeConfig,
} from "./core/modes";

import {
  getAccountTier,
  calculatePositionSize,
  type StrategyType,
  StrategyType as Strategy,
  type TierInfo,
} from "./core/scaling";

import {
  createOracleState,
  recordTrade,
  analyzePerformance,
  calculateAllocations,
  type OracleState,
  type StrategyPerformance,
} from "./core/oracle";

import {
  calculateIntelligentReserves,
  type ReserveBreakdown,
} from "./core/reserves";

// APEX v3.0 Strategy Modules
import {
  detectMomentum,
  detectMispricing,
  detectNewMarket,
  detectSpreadCompression,
  type HunterOpportunity,
  type MarketSnapshot,
} from "./strategies/hunter";

// APEX v3.0 Monitoring
import { ErrorReporter } from "./monitoring/error-reporter";

// ============================================
// STATE - APEX v3.0
// ============================================

interface State {
  client?: ClobClient;
  wallet?: Wallet;
  address: string;
  liveTrading: boolean;
  targets: string[];
  
  // APEX v3.0 Configuration
  mode: string;              // "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE"
  modeConfig: ModeConfig;
  tier: TierInfo;
  
  // Tracking
  cycleCount: number;
  startTime: number;
  startBalance: number;
  currentBalance: number;
  tradesExecuted: number;
  
  // APEX v3.0 Performance Tracking
  oracleState: OracleState;
  strategyAllocations: Map<StrategyType, number>;
  
  // APEX Hunter Stats
  hunterStats: {
    scans: number;
    opportunitiesFound: number;
    trades: number;
  };
  
  actedPositions: Set<string>; // Track which markets we've already acted on
  
  // Timing
  lastRedeem: number;
  lastSummary: number;
  lastOracleReview: number;
  weekStartTime: number;
  weekStartBalance: number;
  
  // Balance tracking (CRITICAL for v3.0)
  lastKnownBalance: number;
  lastBalanceCheck: number;
  tradingHalted: boolean;
  haltReason: string;
  lowBalanceWarned: boolean;
  hourlySpendingLimitReached: boolean;
}

const state: State = {
  address: "",
  liveTrading: false,
  targets: [],
  mode: "BALANCED",
  modeConfig: getApexMode(),
  tier: getAccountTier(0),
  cycleCount: 0,
  startTime: Date.now(),
  startBalance: 0,
  currentBalance: 0,
  tradesExecuted: 0,
  oracleState: createOracleState(),
  strategyAllocations: new Map(),
  hunterStats: {
    scans: 0,
    opportunitiesFound: 0,
    trades: 0,
  },
  actedPositions: new Set(),
  lastRedeem: 0,
  lastSummary: 0,
  lastOracleReview: 0,
  weekStartTime: Date.now(),
  weekStartBalance: 0,
  lastKnownBalance: 0,
  lastBalanceCheck: 0,
  tradingHalted: false,
  haltReason: "",
  lowBalanceWarned: false,
  hourlySpendingLimitReached: false,
};

// ============================================
// LOGGER
// ============================================

const logger: Logger = {
  info: (msg) => console.log(`[${time()}] ${msg}`),
  warn: (msg) => console.log(`[${time()}] ⚠️  ${msg}`),
  error: (msg) => console.log(`[${time()}] ❌ ${msg}`),
  debug: (msg) => {
    if (process.env.DEBUG) console.log(`[${time()}] 🔍 ${msg}`);
  },
};

function time(): string {
  return new Date().toISOString().substring(11, 19);
}

function $(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ============================================
// APEX v3.0 - BANNER
// ============================================

function displayAPEXBanner(): void {
  console.log(`
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                              ┃
┃      ⚡  █████╗ ██████╗ ███████╗██╗  ██╗  ⚡               ┃
┃         ██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝                   ┃
┃         ███████║██████╔╝█████╗   ╚███╔╝                    ┃
┃         ██╔══██║██╔═══╝ ██╔══╝   ██╔██╗                    ┃
┃         ██║  ██║██║     ███████╗██╔╝ ██╗                   ┃
┃         ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝                   ┃
┃                                                              ┃
┃              AGGRESSIVE POLYMARKET EXECUTION                 ┃
┃                      Version 3.0                             ┃
┃                                                              ┃
┃                 🌍 24/7 NEVER SLEEPS 🌍                     ┃
┃                                                              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
  `);
}

// ============================================
// APEX v3.0 - INITIALIZATION
// ============================================

async function initializeAPEX(): Promise<void> {
  console.clear();
  displayAPEXBanner();
  
  // Load mode from ENV
  state.modeConfig = getApexMode();
  state.mode = state.modeConfig.name;
  
  logger.info(`⚡ APEX v3.0 INITIALIZING...`);
  logger.info(``);
  
  // Auto-detect wallet balance
  if (!state.wallet || !state.client) {
    throw new Error("Wallet or client not initialized");
  }
  
  state.startBalance = await getUsdcBalance(state.wallet, state.address);
  state.currentBalance = state.startBalance;
  state.lastKnownBalance = state.startBalance;
  state.lastBalanceCheck = Date.now();
  
  // Detect account tier
  state.tier = getAccountTier(state.startBalance);
  logger.info(`💰 Balance Detected: ${$(state.startBalance)}`);
  logger.info(`📊 Account Tier: ${state.tier.description} (${state.tier.multiplier}× multiplier)`);
  logger.info(``);
  
  // Load mode settings
  logger.info(`⚙️  MODE: ${state.mode}`);
  logger.info(`   Base Position: ${state.modeConfig.basePositionPct}% of balance`);
  logger.info(`   Max Exposure: ${state.modeConfig.maxExposurePct}%`);
  logger.info(`   Weekly Target: +${state.modeConfig.weeklyTargetPct}%`);
  logger.info(`   Drawdown Halt: -${state.modeConfig.drawdownHaltPct}%`);
  logger.info(``);
  
  // Initialize Oracle with default allocations
  state.oracleState = createOracleState();
  state.strategyAllocations = new Map([
    [Strategy.VELOCITY, 20],
    [Strategy.SHADOW, 20],
    [Strategy.BLITZ, 20],
    [Strategy.GRINDER, 15],
    [Strategy.CLOSER, 15],
    [Strategy.AMPLIFIER, 10],
  ]);
  
  logger.info(`🧠 APEX Oracle: Initialized (24hr performance tracking)`);
  logger.info(`🎯 APEX Hunter: Ready to scan 6 patterns`);
  logger.info(``);
  
  // Calculate target
  const targetMultiplier = state.mode === "AGGRESSIVE" ? 10 : 
                          state.mode === "BALANCED" ? 5 : 3;
  const target = state.startBalance * targetMultiplier;
  const weeksToTarget = Math.log(targetMultiplier) / Math.log(1 + state.modeConfig.weeklyTargetPct / 100);
  
  logger.info(`🎯 Target: ${$(target)} (${targetMultiplier}×)`);
  logger.info(`⏱️  Estimated: ${Math.ceil(weeksToTarget)} weeks`);
  logger.info(``);
  
  // Track weekly progress
  state.weekStartTime = Date.now();
  state.weekStartBalance = state.startBalance;
  state.lastOracleReview = Date.now();
  
  logger.info(`✅ APEX v3.0 ONLINE - 24/7 HUNTING MODE ENGAGED`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(``);
  
  // Send startup notification
  await sendTelegram("⚡ APEX v3.0 ONLINE", 
    `Mode: ${state.mode}\n` +
    `Balance: ${$(state.startBalance)}\n` +
    `Target: ${$(target)} (${targetMultiplier}×)\n` +
    `ETA: ~${Math.ceil(weeksToTarget)} weeks\n\n` +
    `Status: 🟢 HUNTING FOR PROFITS`
  );
}

// ============================================
// APEX v3.0 - FIREWALL (CIRCUIT BREAKER)
// ============================================

async function runFirewallCheck(currentBalance: number, positions: Position[]): Promise<void> {
  // CRITICAL: HALT IF BALANCE TOO LOW
  if (currentBalance < 20) {
    logger.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.error(`🚨 APEX FIREWALL: CRITICAL LOW BALANCE`);
    logger.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.error(`   Balance: ${$(currentBalance)}`);
    logger.error(`   Minimum: $20.00`);
    logger.error(`   Status: TRADING HALTED ⛔`);
    logger.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    await sendTelegram("🚨 APEX FIREWALL: TRADING HALTED",
      `Balance critically low: ${$(currentBalance)}\n\n` +
      `Trading halted until manual intervention.\n` +
      `Minimum balance: $20.00`
    );
    
    state.tradingHalted = true;
    state.haltReason = "CRITICAL_LOW_BALANCE";
    return;
  }
  
  // Reset halt if balance recovered
  if (state.tradingHalted && currentBalance >= 20) {
    state.tradingHalted = false;
    state.haltReason = "";
    logger.info(`✅ APEX Firewall: Trading resumed (balance: ${$(currentBalance)})`);
    await sendTelegram("✅ APEX FIREWALL: TRADING RESUMED",
      `Balance recovered: ${$(currentBalance)}\n` +
      `Trading has been resumed.`
    );
  }
  
  // WARNING: BALANCE GETTING LOW
  if (currentBalance < 50 && !state.lowBalanceWarned) {
    logger.warn(`⚠️ APEX FIREWALL: Low Balance Warning`);
    logger.warn(`   Balance: ${$(currentBalance)}`);
    
    await sendTelegram("⚠️ LOW BALANCE WARNING",
      `Balance: ${$(currentBalance)}\n` +
      `Reducing position sizes\n` +
      `Consider adding funds`
    );
    
    state.lowBalanceWarned = true;
  } else if (currentBalance >= 100 && state.lowBalanceWarned) {
    // Reset warning if balance recovered
    state.lowBalanceWarned = false;
  }
  
  // HOURLY SPENDING LIMIT
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recentTrades = state.oracleState.trades.filter(t => t.timestamp > hourAgo);
  const recentSpending = recentTrades.reduce((sum, t) => sum + (t.pnl < 0 ? Math.abs(t.pnl) : 0), 0);
  
  const maxSpendPerHour = currentBalance * (state.modeConfig.maxExposurePct / 100) * 0.5;
  
  if (recentSpending >= maxSpendPerHour) {
    if (!state.hourlySpendingLimitReached) {
      logger.warn(`⚠️ APEX Firewall: Hourly spending limit reached`);
      logger.warn(`   Spent: ${$(recentSpending)}`);
      logger.warn(`   Limit: ${$(maxSpendPerHour)}/hour`);
    }
    state.hourlySpendingLimitReached = true;
  } else {
    state.hourlySpendingLimitReached = false;
  }
}

// ============================================
// TRADING FUNCTIONS
// ============================================

async function buy(
  tokenId: string,
  outcome: "YES" | "NO",
  requestedSize: number,
  reason: string,
  strategy: StrategyType,
  marketId?: string,
  shares?: number,
): Promise<boolean> {
  if (!state.client || !state.wallet) return false;

  // CRITICAL: Fetch current balance FIRST (always get fresh balance before trading)
  let currentBalance: number;
  try {
    currentBalance = await getUsdcBalance(state.wallet, state.address);
    state.lastKnownBalance = currentBalance;
    state.lastBalanceCheck = Date.now();
  } catch (error) {
    logger.error(`❌ Failed to check balance: ${error}`);
    return false;
  }

  // CRITICAL: Halt if balance too low
  if (currentBalance < 10) {
    logger.error(`🚨 BALANCE TOO LOW: ${$(currentBalance)}`);
    await sendTelegram("🚨 CRITICAL: LOW BALANCE",
      `Balance: ${$(currentBalance)}\n` +
      `Cannot place orders! Minimum: $10`
    );
    return false;
  }

  // Get current positions for reserve calculation
  let positions: Position[] = [];
  try {
    positions = await getPositions(state.address);
  } catch (error) {
    logger.warn(`⚠️ Failed to fetch positions for reserve calculation, using empty list`);
  }

  // Calculate intelligent reserves
  const reserves = calculateIntelligentReserves(currentBalance, positions);
  const availableCapital = reserves.availableForTrading;

  if (availableCapital <= 0) {
    logger.warn(`⚠️ No capital available (all reserved)`);
    return false;
  }

  // Calculate dynamic size based on balance and strategy
  const dynamicSize = calculatePositionSize(currentBalance, state.modeConfig, strategy);

  // CRITICAL: Cap to available capital and requested size
  let finalSize = Math.min(requestedSize, dynamicSize, availableCapital);

  // CRITICAL: Minimum order size
  if (finalSize < 5) {
    if (logger.debug) {
      logger.debug(`⏭️ Position too small: ${$(finalSize)} (min $5)`);
    }
    return false;
  }

  // CRITICAL: Verify sufficient balance (final safety check)
  if (finalSize > currentBalance) {
    logger.error(`🚨 IMPOSSIBLE ORDER: Size ${$(finalSize)} > Balance ${$(currentBalance)}`);
    return false;
  }

  // Log trade details
  logger.info(`⚡ APEX ${strategy}: Buying ${outcome}`);
  logger.info(`   Balance: ${$(currentBalance)}`);
  logger.info(`   Available: ${$(availableCapital)}`);
  logger.info(`   Requested: ${$(requestedSize)}`);
  logger.info(`   Placing: ${$(finalSize)}`);

  if (!state.liveTrading) {
    logger.info(`🔸 [SIM] ⚡ APEX ${strategy}: BUY ${outcome} ${$(finalSize)} | ${reason}`);
    await sendTelegram(`[SIM] APEX ${strategy} BUY`, `${reason}\n${outcome} ${$(finalSize)}`);
    
    // Update cached balance for simulation
    state.lastKnownBalance = currentBalance - finalSize;
    
    // Don't record simulated buys - only record sells with actual P&L
    return true;
  }

  // Place order
  try {
    const result = await postOrder({
      client: state.client,
      tokenId,
      outcome,
      side: "BUY",
      sizeUsd: finalSize,
      marketId,
      shares,
      logger,
    });

    if (result.success) {
      // Update cached balance
      state.lastKnownBalance = currentBalance - finalSize;
      
      logger.info(
        `✅ ⚡ APEX ${strategy}: BUY ${outcome} ${$(result.filledUsd ?? finalSize)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢ | ${reason}`,
      );
      logger.info(`   New balance: ~${$(state.lastKnownBalance)}`);
      
      await sendTelegram(
        `⚡ APEX ${strategy} BUY`,
        `${reason}\n${outcome} ${$(result.filledUsd ?? finalSize)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢\n` +
        `Balance: ~${$(state.lastKnownBalance)}`
      );
      
      // Don't record buy trades in Oracle - only record sells with actual P&L
      state.tradesExecuted++;
      invalidatePositions();
      return true;
    }

    if (result.reason !== "SIMULATED") {
      logger.warn(`⚡ APEX ${strategy}: BUY failed - ${result.reason} | ${reason}`);
    }
    return false;
  } catch (error) {
    logger.error(`❌ Order error: ${error}`);
    return false;
  }
}

async function sell(
  tokenId: string,
  outcome: "YES" | "NO",
  sizeUsd: number,
  reason: string,
  strategy: StrategyType,
  pnl: number = 0,
  shares?: number,
): Promise<boolean> {
  if (!state.client) return false;

  if (!state.liveTrading) {
    logger.info(`🔸 [SIM] ⚡ APEX ${strategy}: SELL ${outcome} ${$(sizeUsd)} | ${reason}`);
    await sendTelegram(`[SIM] APEX ${strategy} SELL`, `${reason}\n${outcome} ${$(sizeUsd)}`);
    
    // Record simulated trade with P&L
    recordTrade(state.oracleState, strategy, pnl, true, tokenId, reason);
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
      `✅ ⚡ APEX ${strategy}: SELL ${outcome} ${$(result.filledUsd ?? sizeUsd)} @ ${((result.avgPrice ?? 0) * 100).toFixed(1)}¢ | ${reason}`,
    );
    await sendTelegram(
      `⚡ APEX ${strategy} SELL`,
      `${reason}\n${outcome} ${$(result.filledUsd ?? sizeUsd)}\nP&L: ${pnl >= 0 ? '+' : ''}${$(pnl)}`,
    );
    
    // Record trade with P&L
    recordTrade(state.oracleState, strategy, pnl, true, tokenId, reason);
    state.tradesExecuted++;
    invalidatePositions();
    return true;
  }

  if (result.reason !== "SIMULATED") {
    logger.warn(`⚡ APEX ${strategy}: SELL failed - ${result.reason} | ${reason}`);
  }
  return false;
}

// ============================================
// APEX v3.0 - HUNTER SCANNER
// ============================================

async function runHunterScan(positions: Position[]): Promise<HunterOpportunity[]> {
  state.hunterStats.scans++;
  
  if (process.env.DEBUG) {
    logger.info(`🔍 APEX Hunter: Scanning markets...`);
  }
  
  const opportunities: HunterOpportunity[] = [];
  
  // For now, use existing positions as market snapshots
  // In a full implementation, you would fetch all active markets
  for (const p of positions) {
    // NOTE: Hunter currently uses limited data from existing positions
    // For full functionality, this should fetch complete market data from the API
    // including: real-time volume, liquidity, price history, whale trades, etc.
    // Current implementation provides basic pattern detection as a foundation
    
    // Create a simple market snapshot from position
    const snapshot: MarketSnapshot = {
      tokenId: p.tokenId,
      conditionId: "", // Not available in position
      marketId: p.marketId,
      yesPrice: p.outcome === "YES" ? p.curPrice : 1 - p.curPrice,
      noPrice: p.outcome === "NO" ? p.curPrice : 1 - p.curPrice,
      volume24h: 0, // Would need to fetch from API
      liquidity: 0,
      createdAt: 0,
      lastPrice: p.curPrice,
      priceHistory: [p.curPrice], // Would need historical data
      spread: 0,
    };
    
    // Skip detection for markets we've already acted on this cycle
    if (state.actedPositions.has(p.tokenId)) continue;
    
    // Run pattern detection (simplified - full implementation would fetch real market data)
    const momentum = detectMomentum(snapshot);
    if (momentum) opportunities.push(momentum);
    
    const mispriced = detectMispricing(snapshot);
    if (mispriced) opportunities.push(mispriced);
    
    // Volume spike and whale detection need additional data - skip for now
    // const volumeSpike = detectVolumeSpike(snapshot, normalVolume);
    // const whaleActivity = detectWhaleActivity(snapshot, recentWhaleTrade);
    
    const newMarket = detectNewMarket(snapshot);
    if (newMarket) opportunities.push(newMarket);
    
    const spreadComp = detectSpreadCompression(snapshot);
    if (spreadComp) opportunities.push(spreadComp);
  }
  
  state.hunterStats.opportunitiesFound += opportunities.length;
  
  if (opportunities.length > 0) {
    logger.info(`🎯 APEX Hunter: Found ${opportunities.length} opportunities`);
    
    // Log top 3
    for (let i = 0; i < Math.min(3, opportunities.length); i++) {
      const opp = opportunities[i];
      logger.info(`   ${i + 1}. ${opp.pattern}: ${opp.outcome} @ $${opp.price.toFixed(2)} (${opp.confidence}% conf)`);
    }
  }
  
  return opportunities;
}

async function executeHunterOpportunities(
  opportunities: HunterOpportunity[],
  currentBalance: number
): Promise<void> {
  if (opportunities.length === 0) return;
  
  // Sort by confidence
  opportunities.sort((a, b) => b.confidence - a.confidence);
  
  // Execute top 3 opportunities
  for (const opp of opportunities.slice(0, 3)) {
    // Check if already acted on this market
    if (state.actedPositions.has(opp.tokenId)) continue;
    
    // Calculate position size using dynamic scaling
    const positionSize = calculatePositionSize(
      currentBalance,
      state.modeConfig,
      Strategy.HUNTER
    );
    
    logger.info(`🎯 APEX Hunter: Executing ${opp.pattern}`);
    logger.info(`   ${opp.outcome} @ $${opp.price.toFixed(2)} - ${opp.reason}`);
    logger.info(`   Size: ${$(positionSize)}`);
    
    // Place order
    const success = await buy(
      opp.tokenId,
      opp.outcome,
      positionSize,
      `${opp.pattern}: ${opp.reason}`,
      Strategy.HUNTER,
      opp.marketId
    );
    
    if (success) {
      state.hunterStats.trades++;
      state.actedPositions.add(opp.tokenId);
      
      await sendTelegram("🎯 APEX HUNTER STRIKE",
        `Pattern: ${opp.pattern}\n` +
        `${opp.outcome} @ $${opp.price.toFixed(2)}\n` +
        `Confidence: ${opp.confidence}%\n` +
        `Reason: ${opp.reason}`
      );
    }
  }
}

// ============================================
// APEX v3.0 - EXIT STRATEGIES
// ============================================

async function runBlitzExits(positions: Position[]): Promise<void> {
  // APEX Blitz - Quick Scalps (0.6-3%)
  for (const p of positions) {
    if (p.pnlPct >= 0.6 && p.pnlPct <= 3) {
      logger.info(`⚡ APEX Blitz: Quick exit ${p.outcome} +${p.pnlPct.toFixed(1)}%`);
      await sell(
        p.tokenId,
        p.outcome as "YES" | "NO",
        p.value,
        `Blitz scalp +${p.pnlPct.toFixed(1)}%`,
        Strategy.BLITZ,
        p.pnlUsd,
        p.size,
      );
    }
  }
}

async function runCommandExits(positions: Position[]): Promise<void> {
  // APEX Command - AutoSell at 99.5¢
  const threshold = 0.995;
  
  for (const p of positions) {
    if (p.curPrice >= threshold) {
      logger.info(`⚡ APEX Command: AutoSell ${p.outcome} @ ${(p.curPrice * 100).toFixed(0)}¢`);
      await sell(
        p.tokenId,
        p.outcome as "YES" | "NO",
        p.value,
        `Command AutoSell (${(p.curPrice * 100).toFixed(0)}¢)`,
        Strategy.BLITZ, // Attribute to BLITZ (exit strategy)
        p.pnlUsd,
        p.size,
      );
    }
  }
}

// ============================================
// APEX v3.0 - ENTRY STRATEGIES
// ============================================

async function runShadowStrategy(positions: Position[], currentBalance: number): Promise<void> {
  // APEX Shadow - Copy Trading
  if (state.targets.length === 0) return;
  
  const allocation = state.strategyAllocations.get(Strategy.SHADOW) || 0;
  if (allocation === 0) return;

  const trades = await fetchRecentTrades(state.targets);
  const minBuyPrice = 0.05; // 5¢ minimum

  for (const t of trades) {
    if (t.side !== "BUY") continue;
    if (t.price < minBuyPrice) continue;
    
    // Calculate dynamic position size
    const positionSize = calculatePositionSize(currentBalance, state.modeConfig, Strategy.SHADOW);
    const size = Math.min(t.sizeUsd * 1.0, positionSize);

    await buy(
      t.tokenId,
      t.outcome as "YES" | "NO",
      size,
      `Shadow: Following ${t.trader.slice(0, 8)}...`,
      Strategy.SHADOW,
      t.marketId,
    );
  }
}

async function runCloserStrategy(positions: Position[], currentBalance: number): Promise<void> {
  // APEX Closer - Endgame (92-97¢)
  // NOTE: This strategy adds MORE to existing profitable positions in endgame range
  // Consider adding position tracking to prevent over-concentration in single markets
  const allocation = state.strategyAllocations.get(Strategy.CLOSER) || 0;
  if (allocation === 0) return;

  for (const p of positions) {
    if (p.curPrice < 0.92 || p.curPrice > 0.97) continue;
    if (p.pnlPct <= 0) continue;

    const positionSize = calculatePositionSize(currentBalance, state.modeConfig, Strategy.CLOSER);

    await buy(
      p.tokenId,
      p.outcome as "YES" | "NO",
      positionSize,
      `Closer: Endgame @ ${(p.curPrice * 100).toFixed(0)}¢`,
      Strategy.CLOSER,
      p.marketId,
    );
  }
}

async function runAmplifierStrategy(positions: Position[], currentBalance: number): Promise<void> {
  // APEX Amplifier - Stack Winners
  const allocation = state.strategyAllocations.get(Strategy.AMPLIFIER) || 0;
  if (allocation === 0) return;

  const stackedTokens = new Set<string>();

  for (const p of positions) {
    if (stackedTokens.has(p.tokenId)) continue;
    if (p.gainCents < 1.5) continue; // Minimum 1.5¢ gain
    if (p.curPrice > 0.75) continue; // Max price 75¢
    if (p.curPrice < ORDER.GLOBAL_MIN_BUY_PRICE) continue;

    const positionSize = calculatePositionSize(currentBalance, state.modeConfig, Strategy.AMPLIFIER);

    const success = await buy(
      p.tokenId,
      p.outcome as "YES" | "NO",
      positionSize,
      `Amplifier: Stack +${p.gainCents.toFixed(1)}¢`,
      Strategy.AMPLIFIER,
      p.marketId,
    );

    if (success) stackedTokens.add(p.tokenId);
  }
}

async function runGrinderStrategy(positions: Position[], currentBalance: number): Promise<void> {
  // APEX Grinder - High Volume Trades
  const allocation = state.strategyAllocations.get(Strategy.GRINDER) || 0;
  if (allocation === 0) return;

  // For now, Grinder is placeholder - would need volume data from API
  if (process.env.DEBUG) {
    logger.info(`⚡ APEX Grinder: Monitoring volume (placeholder)`);
  }
}

async function runVelocityStrategy(positions: Position[], currentBalance: number): Promise<void> {
  // APEX Velocity - Momentum Trading
  const allocation = state.strategyAllocations.get(Strategy.VELOCITY) || 0;
  if (allocation === 0) return;

  // Velocity detection would need price history data
  // For now, this is a placeholder that would integrate with real market data
  if (process.env.DEBUG) {
    logger.info(`⚡ APEX Velocity: Monitoring momentum (placeholder)`);
  }
}

// ============================================
// APEX v3.0 - ORACLE & REPORTING
// ============================================

async function runOracleReview(): Promise<void> {
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`🧠 APEX ORACLE - DAILY STRATEGY REVIEW`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  // Review performance and get new allocations
  const strategies: StrategyType[] = [
    Strategy.VELOCITY,
    Strategy.SHADOW,
    Strategy.BLITZ,
    Strategy.GRINDER,
    Strategy.CLOSER,
    Strategy.AMPLIFIER,
    Strategy.HUNTER,
  ];
  const performance = analyzePerformance(state.oracleState, strategies);
  const performanceWithAllocations = calculateAllocations(performance);
  
  // Apply new allocations
  for (const perf of performanceWithAllocations) {
    state.strategyAllocations.set(perf.strategy, perf.allocation);
  }
  
  // Log results
  logger.info(`📈 24HR PERFORMANCE:`);
  for (const perf of performanceWithAllocations) {
    const emoji = perf.rank === "CHAMPION" ? "🏆" :
                  perf.rank === "PERFORMING" ? "✅" :
                  perf.rank === "TESTING" ? "🧪" :
                  perf.rank === "STRUGGLING" ? "⚠️" : "❌";
    
    logger.info(`${emoji} APEX ${perf.strategy}:`);
    logger.info(`   Trades: ${perf.totalTrades} | WR: ${perf.winRate.toFixed(0)}% | P&L: ${$(perf.totalPnL)}`);
    logger.info(`   Score: ${perf.score.toFixed(0)}/100 | Allocation: ${perf.allocation.toFixed(0)}%`);
  }
  
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  // Send Telegram report
  const totalPnl = performanceWithAllocations.reduce((sum: number, p: StrategyPerformance) => sum + p.totalPnL, 0);
  const totalTrades = performanceWithAllocations.reduce((sum: number, p: StrategyPerformance) => sum + p.totalTrades, 0);
  const avgWinRate = performanceWithAllocations.length > 0 
    ? performanceWithAllocations.reduce((sum: number, p: StrategyPerformance) => sum + p.winRate, 0) / performanceWithAllocations.length 
    : 0;
  
  const champion = performanceWithAllocations.find((p: StrategyPerformance) => p.rank === "CHAMPION");
  const sorted = [...performanceWithAllocations].sort((a, b) => a.score - b.score);
  const worst = sorted[0];
  
  await sendTelegram("🧠 APEX ORACLE - DAILY REVIEW",
    `24hr Performance:\n` +
    `Total Trades: ${totalTrades}\n` +
    `P&L: ${totalPnl >= 0 ? '+' : ''}${$(totalPnl)}\n` +
    `Win Rate: ${avgWinRate.toFixed(0)}%\n\n` +
    `🏆 Best: ${champion?.strategy || 'None'} (+${$(champion?.totalPnL || 0)})\n` +
    `⚠️ Worst: ${worst?.strategy || 'None'} (${$(worst?.totalPnL || 0)})\n\n` +
    `Capital reallocated for next 24hrs`
  );
}

async function sendHourlySummary(currentBalance: number): Promise<void> {
  const hourStart = Date.now() - 60 * 60 * 1000;
  const recentTrades = state.oracleState.trades.filter(t => t.timestamp > hourStart);
  
  const wins = recentTrades.filter(t => t.pnl > 0).length;
  const losses = recentTrades.filter(t => t.pnl < 0).length;
  const totalPnl = recentTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = wins / Math.max(1, wins + losses) * 100;
  
  await sendTelegram("📊 APEX HOURLY SUMMARY",
    `Last Hour:\n` +
    `Trades: ${recentTrades.length}\n` +
    `P&L: ${totalPnl >= 0 ? '+' : ''}${$(totalPnl)}\n` +
    `Win Rate: ${winRate.toFixed(0)}%\n` +
    `Balance: ${$(currentBalance)}`
  );
}

async function sendWeeklyReport(currentBalance: number): Promise<void> {
  const weekGain = currentBalance - state.weekStartBalance;
  const weekGainPct = state.weekStartBalance > 0
    ? (weekGain / state.weekStartBalance) * 100
    : 0;
  
  const targetMultiplier = state.mode === "AGGRESSIVE" ? 10 : 
                          state.mode === "BALANCED" ? 5 : 3;
  const target = state.startBalance * targetMultiplier;
  const progressPct = (currentBalance / target) * 100;
  
  await sendTelegram("📈 APEX WEEKLY REPORT",
    `Week Complete!\n\n` +
    `Starting: ${$(state.weekStartBalance)}\n` +
    `Ending: ${$(currentBalance)}\n` +
    `Gain: ${weekGain >= 0 ? '+' : ''}${$(weekGain)} (${weekGainPct >= 0 ? '+' : ''}${weekGainPct.toFixed(1)}%)\n\n` +
    `Target: +${state.modeConfig.weeklyTargetPct}%\n` +
    `Status: ${weekGainPct >= state.modeConfig.weeklyTargetPct ? '🟢 ON TRACK' : '🟡 BELOW TARGET'}\n\n` +
    `Progress to Goal:\n` +
    `${$(currentBalance)} / ${$(target)}\n` +
    `${progressPct.toFixed(0)}% Complete`
  );
}

// ============================================
// APEX v3.0 - REDEMPTION
// ============================================

async function runRedeem(): Promise<void> {
  if (!state.wallet) return;

  const now = Date.now();
  const intervalMin = 60; // Redeem every 60 minutes
  if (now - state.lastRedeem < intervalMin * 60 * 1000) return;

  state.lastRedeem = now;
  const minPositionUsd = 0.1; // Minimum $0.10 to redeem
  const count = await redeemAll(
    state.wallet,
    state.address,
    minPositionUsd,
    logger,
  );

  if (count > 0) {
    logger.info(`💰 Redeemed ${count} positions`);
    await sendTelegram("💰 Redeem", `Redeemed ${count} positions`);
    invalidatePositions();
  }
}

// ============================================
// APEX v3.0 - MAIN EXECUTION CYCLE
// ============================================

async function runAPEXCycle(): Promise<void> {
  state.cycleCount++;
  
  // Update current balance with error handling
  if (!state.wallet) return;
  try {
    state.currentBalance = await getUsdcBalance(state.wallet, state.address);
    state.lastKnownBalance = state.currentBalance;
    state.lastBalanceCheck = Date.now();
  } catch (error) {
    logger.error(`Failed to update USDC balance; using last known balance: ${error}`);
  }
  
  // Get positions with error handling
  let positions: Position[] = [];
  try {
    positions = await getPositions(state.address);
  } catch (error) {
    logger.error(`Failed to fetch positions; continuing with empty positions: ${error}`);
    positions = [];
  }
  
  // ============================================
  // PRIORITY -1: FIREWALL CHECK (CRITICAL!)
  // ============================================
  await runFirewallCheck(state.currentBalance, positions);
  
  // HALT if trading disabled
  if (state.tradingHalted) {
    logger.error(`⛔ Trading halted: ${state.haltReason}`);
    // Still allow exits and redemptions even when halted
    await runBlitzExits(positions);
    await runCommandExits(positions);
    await runRedeem();
    return;
  }
  
  // Clear acted positions at start of each cycle
  state.actedPositions.clear();
  
  // ============================================
  // PRIORITY 0: HUNTER - ACTIVE SCANNING
  // ============================================
  const opportunities = await runHunterScan(positions);
  
  // ============================================
  // PRIORITY 1: EXITS (Free capital first!)
  // ============================================
  await runBlitzExits(positions);        // Quick scalps (0.6-3%)
  await runCommandExits(positions);      // AutoSell (99.5¢)
  
  // ============================================
  // PRIORITY 2: REDEMPTION (Convert wins to USDC)
  // ============================================
  await runRedeem();
  
  // ============================================
  // PRIORITY 3: ENTRIES (Deploy capital)
  // ============================================
  
  // Check if hourly spending limit reached
  if (state.hourlySpendingLimitReached) {
    if (logger.debug) {
      logger.debug(`⏭️ Hourly spending limit reached, skipping new entries`);
    }
  } else {
    // Calculate available capital
    const reserves = calculateIntelligentReserves(state.currentBalance, positions);
    
    if (reserves.availableForTrading > 5) {
      // Execute Hunter opportunities first (highest priority)
      await executeHunterOpportunities(opportunities, state.currentBalance);
      
      // Then run strategy-based entries based on Oracle allocations
      const allocations = state.strategyAllocations;
      
      if ((allocations.get(Strategy.VELOCITY) ?? 0) > 0) {
        await runVelocityStrategy(positions, state.currentBalance);
      }
      
      if ((allocations.get(Strategy.SHADOW) ?? 0) > 0) {
        await runShadowStrategy(positions, state.currentBalance);
      }
      
      if ((allocations.get(Strategy.GRINDER) ?? 0) > 0) {
        await runGrinderStrategy(positions, state.currentBalance);
      }
      
      if ((allocations.get(Strategy.CLOSER) ?? 0) > 0) {
        await runCloserStrategy(positions, state.currentBalance);
      }
      
      if ((allocations.get(Strategy.AMPLIFIER) ?? 0) > 0) {
        await runAmplifierStrategy(positions, state.currentBalance);
      }
    } else {
      if (logger.debug) {
        logger.debug(`⏭️ No capital available for new entries`);
      }
    }
  }
  
  // ============================================
  // HOURLY: SUMMARY REPORT
  // ============================================
  if (Date.now() - state.lastSummary > 60 * 60 * 1000) {
    await sendHourlySummary(state.currentBalance);
    state.lastSummary = Date.now();
  }
  
  // ============================================
  // DAILY: ORACLE REVIEW
  // ============================================
  if (Date.now() - state.lastOracleReview > 24 * 60 * 60 * 1000) {
    await runOracleReview();
    state.lastOracleReview = Date.now();
  }
  
  // ============================================
  // WEEKLY: PROGRESS REPORT
  // ============================================
  if (Date.now() - state.weekStartTime > 7 * 24 * 60 * 60 * 1000) {
    await sendWeeklyReport(state.currentBalance);
    state.weekStartTime = Date.now();
    state.weekStartBalance = state.currentBalance;
  }
}

//============================================
// MAIN ENTRY POINT
// ============================================

async function main(): Promise<void> {
  // Initialize error reporter
  const errorReporter = new ErrorReporter(logger, {
    githubToken: process.env.GITHUB_ERROR_REPORTER_TOKEN,
  });
  
  try {
    // Get environment variables
    const privateKey = process.env.PRIVATE_KEY;
    const rpcUrl = process.env.RPC_URL;
    
    if (!privateKey || !rpcUrl) {
      throw new Error("PRIVATE_KEY and RPC_URL must be set");
    }
    
    // VPN setup (if configured)
    if (process.env.WIREGUARD_ENABLED === "true" || process.env.WG_CONFIG) {
      logger.info("🔐 VPN: WireGuard enabled");
      capturePreVpnRouting();
      await startWireguard(logger);
      await setupRpcBypass(rpcUrl, logger);
      await setupPolymarketReadBypass(logger);
    } else if (process.env.OPENVPN_ENABLED === "true" || process.env.OVPN_CONFIG) {
      logger.info("🔐 VPN: OpenVPN enabled");
      capturePreVpnRouting();
      await startOpenvpn(logger);
      await setupRpcBypass(rpcUrl, logger);
      await setupPolymarketReadBypass(logger);
    }

    // Validate live trading
    state.liveTrading = isLiveTradingEnabled();
    if (!state.liveTrading) {
      logger.warn("⚠️  SIMULATION MODE - Set LIVE_TRADING=I_UNDERSTAND_THE_RISKS to enable");
    }

    // Initialize wallet and client
    const authResult = await createClobClient(privateKey, rpcUrl);
    if (!authResult.success || !authResult.client || !authResult.wallet || !authResult.address) {
      throw new Error(`Authentication failed: ${authResult.error || 'Unknown error'}`);
    }
    
    state.client = authResult.client;
    state.wallet = authResult.wallet;
    state.address = authResult.address;

    // Validate wallet has funds
    const usdcBalance = await getUsdcBalance(authResult.wallet, authResult.address);
    if (usdcBalance < 1) {
      logger.error("❌ Wallet has insufficient USDC balance");
      logger.error(`   Address: ${authResult.address}`);
      logger.error(`   Balance: $${usdcBalance.toFixed(2)}`);
      logger.error("   Please deposit USDC to continue");
      process.exit(1);
    }

    // Check USDC allowance
    const allowance = await getUsdcAllowance(authResult.wallet, authResult.address);
    if (allowance < 100) {
      logger.warn(`⚠️  Low USDC allowance: $${allowance.toFixed(2)}`);
      logger.warn(`   You may need to approve USDC spending`);
      logger.warn(`   Run: npm run set-token-allowance`);
    }

    // Get copy trading targets
    const targets = await getTargetAddresses();
    state.targets = targets;
    if (state.targets.length > 0) {
      logger.info(`🎯 Copy trading: ${state.targets.length} target(s)`);
    }

    // Initialize Telegram
    await initTelegram();

    // Initialize APEX v3.0
    await initializeAPEX();

    // Main loop
    const intervalMs = parseInt(process.env.INTERVAL_MS || "5000");
    logger.info(`⏱️  Cycle interval: ${intervalMs}ms`);

    while (true) {
      try {
        await runAPEXCycle();
      } catch (err) {
        logger.error(`⚠️  Cycle error: ${err}`);
        
        // Report error to GitHub
        await errorReporter.reportError(err as Error, {
          operation: "apex_main_cycle",
          balance: state.lastKnownBalance,
          cycleCount: state.cycleCount,
        });
        
        await sendTelegram("⚠️ Cycle Error", String(err));
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  } catch (err) {
    logger.error(`❌ Fatal error: ${err}`);
    
    // Report fatal error to GitHub
    await errorReporter.reportError(err as Error, {
      operation: "apex_initialization",
      balance: state.startBalance,
    });
    
    await sendTelegram("❌ Fatal Error", String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
