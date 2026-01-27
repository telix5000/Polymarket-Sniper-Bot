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
import { Contract } from "ethers";
import axios from "axios";

import {
  // Types
  type Position,
  type Logger,
  type OrderOutcome,
  // Auth
  createClobClient,
  isLiveTradingEnabled,
  // Config
  ORDER,
  POLYGON,
  SELL,
  // Data
  getPositions,
  invalidatePositions,
  getUsdcBalance,
  getPolBalance,
  getUsdcAllowance,
  // Trading
  postOrder,
  // Smart Sell (improved sell execution)
  smartSell,
  type SmartSellConfig,
  // Copy trading
  getTargetAddresses,
  fetchRecentTrades,
  // Notifications
  initTelegram,
  sendTelegram,
  // Redemption
  redeemAll,
  redeemAllPositions,
  fetchRedeemablePositions,
  // VPN
  capturePreVpnRouting,
  startWireguard,
  startOpenvpn,
  setupRpcBypass,
  setupPolymarketReadBypass,
} from "./lib";

// APEX v3.0 Core Modules
import { getApexMode, type ModeConfig } from "./core/modes";

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

import { calculateIntelligentReserves } from "./core/reserves";

import {
  getEmergencySellConfig,
  calculateEmergencyMinPrice,
  shouldActivateEmergencySells,
  logEmergencyConfig,
  type EmergencySellConfig,
} from "./core/emergency";

// APEX v3.0 Strategy Modules
import {
  detectMomentum,
  detectMispricing,
  detectNewMarket,
  detectSpreadCompression,
  type HunterOpportunity,
  type MarketSnapshot,
} from "./strategies/hunter";

import {
  detectBlitz,
  type BlitzSignal,
} from "./strategies/blitz";

import {
  detectAutoSell,
  type CommandSignal,
} from "./strategies/command";

import {
  updateRatchet,
  isRatchetTriggered,
  calculateOptimalTrailing,
  type RatchetState,
  type RatchetSignal,
} from "./strategies/ratchet";

import {
  detectLadder,
  updateLadderState,
  calculatePartialSize,
  type LadderState,
  type LadderSignal,
  DEFAULT_LADDER,
} from "./strategies/ladder";

import {
  detectReaper,
  shouldEnterScavengerMode,
  prioritizeReaperExits,
  type ReaperSignal,
} from "./strategies/reaper";

// APEX v3.0 Protection Modules
import {
  detectShield,
  shouldStopHedge,
  shouldTakeProfitHedge,
  type ShieldSignal,
  type HedgeState,
} from "./strategies/shield";

import {
  detectGuardian,
  calculateDynamicStopLoss,
  isInDangerZone,
  type GuardianSignal,
} from "./strategies/guardian";

import {
  detectSentinel,
  getSentinelUrgency,
  type SentinelSignal,
} from "./strategies/sentinel";

// APEX v3.0 Entry Strategies
import {
  calculateVelocity,
  shouldRideMomentum,
  isMomentumReversing,
} from "./strategies/velocity";

import {
  calculateGrindSize,
  shouldExitGrind,
  type MarketMetrics,
} from "./strategies/grinder";

// APEX v3.0 Firewall Module
import {
  checkFirewall,
  calculateExposure,
  shouldHaltTrading,
  getFirewallSummary,
  type FirewallStatus,
} from "./strategies/firewall";

// APEX v3.0 Closer Module
import {
  detectCloser,
  shouldExitBeforeClose,
  calculateCloserSize,
  type CloserSignal,
} from "./strategies/closer";

// APEX v3.0 Amplifier Module
import {
  detectAmplifier,
  isSafeToStack,
  type AmplifierSignal,
} from "./strategies/amplifier";

// APEX v3.0 Shadow Module
import {
  fetchShadowTrades,
  filterQualityTrades,
  getTraderStats,
  type ShadowConfig,
  type TraderStats,
} from "./strategies/shadow";

import { POLYMARKET_API } from "./lib/constants";

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
  mode: string; // "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE"
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
  
  // Exit strategy state tracking
  ratchetStates: Map<string, RatchetState>;
  ladderStates: Map<string, LadderState>;
  
  // Market data for reaper mode
  volume24h: number;
  orderBookDepth: number;

  // Timing
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

  // Recovery Mode (CRITICAL for v3.0)
  recoveryMode: boolean;
  prioritizeExits: boolean;
  errorReporter?: ErrorReporter;
  
  // APEX v3.0 Protection Module State
  hedgeStates: Map<string, HedgeState>; // Track active hedges by tokenId
  priceHistory: Map<string, number[]>;  // Track price history for velocity detection
  // Emergency Sell Configuration (APEX v3.0 PR #4)
  emergencySellConfig: EmergencySellConfig;
  lastEmergencyConfigLog: number; // Timestamp of last emergency config log
  lastRecoveryTipLog: number; // Timestamp of last recovery tip log
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
  ratchetStates: new Map(),
  ladderStates: new Map(),
  // NOTE: volume24h and orderBookDepth are initialized to 0 but not currently populated.
  // These are used by the reaper strategy for scavenger mode detection.
  // Future enhancement: populate these from market data API calls.
  volume24h: 0,
  orderBookDepth: 0,
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
  recoveryMode: false,
  prioritizeExits: false,
  errorReporter: undefined,
  hedgeStates: new Map(),
  priceHistory: new Map(),
  emergencySellConfig: getEmergencySellConfig(),
  lastEmergencyConfigLog: 0,
  lastRecoveryTipLog: 0,
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
// RECOVERY MODE - Liquidate positions when balance is low
// ============================================

// Recovery Mode Constants
const RECOVERY_MODE_BALANCE_THRESHOLD = 20; // Balance below this triggers recovery mode
const MINIMUM_OPERATING_BALANCE = 1; // Minimum balance to continue operations
const PROFITABLE_POSITION_THRESHOLD = 0.5; // Minimum profit % to exit in recovery (0.5%)
const NEAR_RESOLUTION_PRICE_THRESHOLD = 0.95; // Price threshold for near-resolution (95¢)
const ACCEPTABLE_LOSS_THRESHOLD = -2; // Max loss % for near-resolution exits (-2%)
const MAX_ACCEPTABLE_LOSS = -5; // Max loss % for emergency exits (-5%)

// Note: Emergency sell thresholds are now configured via state.emergencySellConfig
// See EMERGENCY_SELL_MODE and EMERGENCY_BALANCE_THRESHOLD environment variables

/**
 * Calculate total portfolio value (balance + position value)
 * 
 * @param balance - Current USDC balance
 * @param positions - Array of open positions
 * @returns Portfolio metrics including total value, position value, and count
 */
function calculatePortfolioValue(balance: number, positions: Position[]): {
  totalValue: number;
  positionValue: number;
  positionCount: number;
} {
  const positionValue = positions.reduce((sum, p) => sum + p.value, 0);
  const totalValue = balance + positionValue;
  
  return {
    totalValue,
    positionValue,
    positionCount: positions.length,
  };
}

/**
 * Display comprehensive startup dashboard
 */
function displayStartupDashboard(
  balance: number,
  positions: Position[],
  portfolio: ReturnType<typeof calculatePortfolioValue>,
  recoveryMode: boolean,
): void {
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`📊 STARTUP PORTFOLIO SUMMARY`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`💵 USDC Balance: ${$(balance)}`);
  logger.info(`📦 Open Positions: ${portfolio.positionCount}`);
  logger.info(`💰 Position Value: ${$(portfolio.positionValue)}`);
  logger.info(`📈 Total Portfolio: ${$(portfolio.totalValue)}`);
  
  if (recoveryMode) {
    logger.warn(`⚠️  RECOVERY MODE: ACTIVE`);
    logger.warn(`   Low balance detected, prioritizing exits`);
  }
  
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(``);
}

/**
 * Run auto-redeem check
 * Called periodically to claim resolved positions
 */
async function runAutoRedeem(): Promise<number> {
  if (!state.wallet) return 0;

  // Check frequency depends on mode:
  // - Recovery mode: every 10 cycles (more urgent - need liquidity)
  // - Normal mode: every 50 cycles (periodic cleanup)
  const checkInterval = state.recoveryMode ? 10 : 50;
  if (state.cycleCount % checkInterval !== 0) return 0;

  logger.debug?.(`Checking for redeemable positions...`);

  const result = await redeemAllPositions(state.wallet, state.address, logger);

  if (result.redeemed > 0) {
    await sendTelegram(
      "🎁 AUTO-REDEEM",
      `Redeemed ${result.redeemed} market(s)\n` +
        `Approximate value: $${result.totalValue.toFixed(2)}\n\n` +
        `Check USDC balance for payouts!`,
    );
  }

  return result.redeemed;
}

/**
 * Run recovery exits - aggressively liquidate positions to free capital
 * Now with emergency sell mode support
 */
async function runRecoveryExits(
  positions: Position[],
  balance: number,
): Promise<number> {
  let exitsExecuted = 0;
  
  // Enrich positions with entry time and price history
  const enrichedPositions = enrichPositions(positions);
  
  const emergencyActive = shouldActivateEmergencySells(balance, state.emergencySellConfig);
  
  // Log emergency config at most once per minute (60 seconds)
  const now = Date.now();
  if (emergencyActive && (now - state.lastEmergencyConfigLog) > 60000) {
    logEmergencyConfig(state.emergencySellConfig, logger);
    state.lastEmergencyConfigLog = now;
  }
  
  logger.warn(`♻️ RECOVERY MODE (Cycle ${state.cycleCount})`);
  logger.warn(`   Balance: $${balance.toFixed(2)} | Positions: ${positions.length}`);
  logger.warn(`   Emergency mode: ${emergencyActive ? '🚨 ACTIVE' : '⏸️  Standby'}`);
  
  if (!emergencyActive) {
    logger.info(`   Balance above $${state.emergencySellConfig.balanceThreshold} - using normal sells`);
  }
  
  // Track positions that have been successfully exited to avoid duplicate attempts
  const exitedTokenIds = new Set<string>();
  
  // Priority 1: Exit ANY profitable position (pnlPct > PROFITABLE_POSITION_THRESHOLD)
  const profitablePositions = enrichedPositions
    .filter((p) => p.pnlPct > PROFITABLE_POSITION_THRESHOLD)
    .sort((a, b) => b.pnlPct - a.pnlPct); // Most profitable first
  
  for (const position of profitablePositions) {
    logger.info(`🔄 Recovery: ${position.outcome} +${position.pnlPct.toFixed(1)}%`);
    
    const success = await sellPositionEmergency(
      position, 
      `Recovery: take ${position.pnlPct.toFixed(1)}% profit`,
      emergencyActive
    );
    if (success) {
      exitsExecuted++;
      exitedTokenIds.add(position.tokenId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  
  // Priority 2: Exit near-resolution (curPrice > NEAR_RESOLUTION_PRICE_THRESHOLD)
  // Filter out already exited positions
  const nearResolution = enrichedPositions
    .filter((p) => 
      !exitedTokenIds.has(p.tokenId) &&
      p.curPrice > NEAR_RESOLUTION_PRICE_THRESHOLD && 
      p.pnlPct > ACCEPTABLE_LOSS_THRESHOLD
    );
  
  for (const position of nearResolution) {
    logger.info(`🔄 Recovery: ${position.outcome} @ ${(position.curPrice * 100).toFixed(0)}¢`);
    
    const success = await sellPositionEmergency(
      position,
      "Recovery: near resolution",
      emergencyActive
    );
    if (success) {
      exitsExecuted++;
      exitedTokenIds.add(position.tokenId);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  
  // Priority 3: If emergency AND desperate (balance < threshold), exit small losses
  if (emergencyActive) {
    const smallLosses = enrichedPositions
      .filter((p) => 
        !exitedTokenIds.has(p.tokenId) &&
        p.pnlPct > MAX_ACCEPTABLE_LOSS && 
        p.pnlPct <= PROFITABLE_POSITION_THRESHOLD
      )
      .sort((a, b) => b.pnlPct - a.pnlPct); // Least losing first
    
    for (const position of smallLosses) {
      logger.warn(`🔄 Emergency: ${position.outcome} ${position.pnlPct.toFixed(1)}%`);
      
      const success = await sellPositionEmergency(
        position,
        `Emergency: free capital (${position.pnlPct.toFixed(1)}% loss)`,
        true  // Force emergency mode
      );
      if (success) {
        exitsExecuted++;
        exitedTokenIds.add(position.tokenId);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  
  if (exitsExecuted > 0) {
    logger.info(`✅ Recovery: Exited ${exitsExecuted} positions`);
    
    // Check if recovered
    const newBalance = await getUsdcBalance(state.wallet!, state.address);
    if (newBalance >= RECOVERY_MODE_BALANCE_THRESHOLD) {
      logger.info(`🎉 RECOVERY COMPLETE! Balance: $${newBalance.toFixed(2)}`);
      state.recoveryMode = false;
      
      await sendTelegram("✅ RECOVERY COMPLETE",
        `Balance restored: $${newBalance.toFixed(2)}\n` +
        `Exited ${exitsExecuted} positions\n\n` +
        `Resuming normal trading`
      );
    } else {
      logger.info(`📊 Recovery progress: $${newBalance.toFixed(2)} (need $${RECOVERY_MODE_BALANCE_THRESHOLD})`);
    }
  } else {
    logger.warn(`⚠️ Recovery: No positions could be exited this cycle`);
    
    // Show tips at most once per 5 minutes (300 seconds)
    const now = Date.now();
    if ((now - state.lastRecoveryTipLog) > 300000) {
      if (!emergencyActive) {
        logger.info(`💡 Tip: Balance is $${balance.toFixed(2)}`);
        logger.info(`   Emergency mode activates at < $${state.emergencySellConfig.balanceThreshold}`);
      } else if (state.emergencySellConfig.mode === 'CONSERVATIVE') {
        logger.warn(`💡 Tip: CONSERVATIVE mode may block very low bids`);
        logger.warn(`   Consider MODERATE or NUCLEAR mode if desperate`);
        logger.warn(`   Set: EMERGENCY_SELL_MODE=MODERATE or NUCLEAR`);
      }
      state.lastRecoveryTipLog = now;
    }
  }
  
  return exitsExecuted;
}

/**
 * Check startup balance and enter recovery mode if needed
 */
async function checkStartupBalance(
  balance: number,
  address: string,
): Promise<{ shouldExit: boolean; recoveryMode: boolean }> {
  // Check if user wants to skip balance check
  if (process.env.SKIP_BALANCE_CHECK_ON_STARTUP === "true") {
    logger.info(`⚠️  Skipping startup balance check (SKIP_BALANCE_CHECK_ON_STARTUP=true)`);
    return { shouldExit: false, recoveryMode: false };
  }
  
  // Fetch positions to calculate total portfolio value
  let positions: Position[] = [];
  try {
    positions = await getPositions(address);
  } catch (error) {
    logger.error(`Failed to fetch positions for balance check: ${error}`);
    positions = [];
  }
  
  const portfolio = calculatePortfolioValue(balance, positions);
  
  // Display startup dashboard
  displayStartupDashboard(balance, positions, portfolio, false);
  
  // Decision logic
  if (balance < RECOVERY_MODE_BALANCE_THRESHOLD && positions.length > 0) {
    // Low balance BUT positions exist - enter recovery mode
    logger.warn(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.warn(`🚨 RECOVERY MODE ACTIVATED`);
    logger.warn(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.warn(`   Balance: ${$(balance)} (below $${RECOVERY_MODE_BALANCE_THRESHOLD} threshold)`);
    logger.warn(`   Positions: ${positions.length} (total value: ${$(portfolio.positionValue)})`);
    logger.warn(`   Strategy: Aggressively liquidate positions to free capital`);
    logger.warn(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(``);
    
    await sendTelegram(
      "🚨 Recovery Mode Activated",
      `Balance: ${$(balance)}\n` +
        `Positions: ${positions.length}\n` +
        `Position Value: ${$(portfolio.positionValue)}\n` +
        `Total Portfolio: ${$(portfolio.totalValue)}\n\n` +
        `Bot will aggressively liquidate positions to free capital.`,
    );
    
    return { shouldExit: false, recoveryMode: true };
  } else if (balance < MINIMUM_OPERATING_BALANCE && positions.length === 0) {
    // Low balance AND no positions - exit
    logger.error("❌ Wallet has insufficient USDC balance");
    logger.error(`   Address: ${address}`);
    logger.error(`   Balance: ${$(balance)}`);
    logger.error(`   Positions: 0`);
    logger.error("   Please deposit USDC to continue");
    logger.error("");
    logger.error("   To bypass this check, set: SKIP_BALANCE_CHECK_ON_STARTUP=true");
    
    return { shouldExit: true, recoveryMode: false };
  } else {
    // Sufficient balance or positions to work with
    return { shouldExit: false, recoveryMode: false };
  }
}

// ============================================
// APEX v3.0 - CORE TRADING FUNCTIONS
// ============================================

/**
 * Position cache for tracking entry time and price history
 */
const positionCache = new Map<string, { 
  entryTime: number; 
  priceHistory: number[];
}>();

/**
 * Enrich positions with entry time and price history
 * These fields are needed by strategies but not provided by API
 */
function enrichPositions(positions: Position[]): Position[] {
  const now = Date.now();
  
  return positions.map(p => {
    // Get or create cache entry
    let cache = positionCache.get(p.tokenId);
    if (!cache) {
      cache = { entryTime: now, priceHistory: [] };
      positionCache.set(p.tokenId, cache);
    }
    
    // Update price history (only when price changes)
    const lastPrice = cache.priceHistory[cache.priceHistory.length - 1];
    if (cache.priceHistory.length === 0 || lastPrice !== p.curPrice) {
      cache.priceHistory.push(p.curPrice);
      if (cache.priceHistory.length > 100) {
        cache.priceHistory = cache.priceHistory.slice(-100);
      }
    }
    
    return {
      ...p,
      entryTime: cache.entryTime,
      priceHistory: [...cache.priceHistory],
    };
  });
}

// Max uint256 for infinite approval
const MAX_UINT256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

/**
 * Ensure USDC is approved for trading
 * Auto-approves if allowance is low
 */
async function ensureUSDCApproval(): Promise<void> {
  if (!state.wallet) return;
  
  const allowance = await getUsdcAllowance(state.wallet, state.address);
  
  if (allowance >= 1000) {
    logger.info(`✅ USDC allowance: $${allowance.toFixed(0)}`);
    return;
  }
  
  logger.warn(`⚠️ USDC allowance low: $${allowance.toFixed(2)}`);
  logger.info(`🔧 Auto-approving USDC allowance...`);
  
  try {
    const usdc = new Contract(
      POLYGON.USDC_ADDRESS,
      ["function approve(address spender, uint256 amount) returns (bool)"],
      state.wallet
    );
    
    const tx = await usdc.approve(POLYGON.CTF_EXCHANGE, MAX_UINT256);
    logger.info(`⏳ Waiting for approval tx: ${tx.hash.slice(0, 16)}...`);
    
    await tx.wait();
    
    logger.info(`✅ USDC approval complete - infinite allowance granted`);
    
    await sendTelegram("✅ USDC Approved",
      `Infinite USDC allowance granted\n` +
      `TX: ${tx.hash.slice(0, 16)}...`
    );
  } catch (error) {
    logger.error(`❌ Auto-approval failed: ${error}`);
    logger.error(`   Please manually run: npm run set-token-allowance`);
  }
}

/**
 * Check POL balance for gas
 * Warn if low, halt if critical
 */
async function checkPolBalance(): Promise<void> {
  if (!state.wallet) return;
  
  const polBalance = await getPolBalance(state.wallet, state.address);
  
  if (polBalance < 0.5) {
    logger.warn(`⚠️ Low POL balance: ${polBalance.toFixed(3)} POL`);
    logger.warn(`   You may run out of gas soon`);
    logger.warn(`   Minimum recommended: 1 POL`);
    
    await sendTelegram("⚠️ LOW GAS WARNING",
      `POL Balance: ${polBalance.toFixed(3)}\n` +
      `Recommended: 1 POL minimum\n\n` +
      `Please deposit POL to avoid stuck transactions`
    );
  }
  
  if (polBalance < 0.1) {
    logger.error(`🚨 CRITICAL: POL balance too low to trade`);
    state.tradingHalted = true;
    state.haltReason = "INSUFFICIENT_GAS";
    
    await sendTelegram("🚨 TRADING HALTED: NO GAS",
      `POL Balance: ${polBalance.toFixed(3)}\n\n` +
      `Cannot execute trades without gas.\n` +
      `Deposit POL immediately!`
    );
  } else if (state.tradingHalted && state.haltReason === "INSUFFICIENT_GAS" && polBalance >= 0.1) {
    // Auto-resume trading when POL balance is restored
    state.tradingHalted = false;
    state.haltReason = "";
    logger.info(`✅ POL balance restored: ${polBalance.toFixed(3)} POL - Trading resumed`);
    
    await sendTelegram("✅ TRADING RESUMED",
      `POL Balance: ${polBalance.toFixed(3)}\n` +
      `Gas restored - trading has resumed automatically`
    );
  }
}

/**
 * Sell a position using SmartSell with improved protections
 * 
 * IMPROVEMENTS over the old implementation:
 * 1. Orderbook depth analysis - calculates expected fill price before executing
 * 2. Dynamic slippage - adjusts based on position state (profit, loss, near-resolution)
 * 3. Liquidity checks - won't sell into thin orderbooks unless forced
 * 4. Better logging - shows expected vs actual fills
 * 
 * @param position - Position to sell
 * @param reason - Reason for selling (for logging/telegram)
 * @param forceSell - If true, sell regardless of liquidity conditions (for stop-loss)
 */
async function sellPosition(
  position: Position,
  reason: string,
  forceSell: boolean = false
): Promise<boolean> {
  
  if (!state.client) return false;
  
  // Check live trading mode
  if (!state.liveTrading) {
    // Return true for simulation - this mirrors the behavior of buy() function.
    // In simulation mode, we log what would happen and return success to allow
    // the bot cycle to continue normally without executing real trades.
    logger.info(
      `🔸 [SIM] SELL ${position.outcome} $${position.value.toFixed(2)} | ${reason}`,
    );
    await sendTelegram(
      "[SIM] POSITION SELL",
      `${position.outcome}\n$${position.value.toFixed(2)}\n${reason}`,
    );
    return true;
  }
  
  logger.info(`🔄 Selling ${position.outcome}`);
  logger.info(`   Shares: ${position.size.toFixed(2)}`);
  logger.info(`   Value: $${position.value.toFixed(2)}`);
  logger.info(`   P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%`);
  logger.info(`   Reason: ${reason}`);
  
  try {
    // Configure smart sell based on position state
    const config: SmartSellConfig = {
      logger,
      forceSell,
    };
    
    // If this is a stop-loss scenario (significant loss), allow more slippage
    if (position.pnlPct <= -SELL.LOSS_THRESHOLD_PCT) {
      config.maxSlippagePct = SELL.LOSS_SLIPPAGE_PCT;
      logger.info(`   ⚠️ Stop-loss mode: allowing ${SELL.LOSS_SLIPPAGE_PCT}% slippage`);
    }
    
    // Minimum price check (allow 5% slippage for exits - more lenient than buys)
    // This helps ensure positions can be liquidated in volatile conditions
    const minPrice = position.avgPrice * 0.95;
    if (bestBid < minPrice) {
      logger.warn(`❌ Price too low: ${(bestBid * 100).toFixed(0)}¢ < ${(minPrice * 100).toFixed(0)}¢ (min 95% of entry)`);
      return false;
    // If position is near resolution ($0.95+), use tighter slippage
    if (position.curPrice >= SELL.HIGH_PRICE_THRESHOLD) {
      config.maxSlippagePct = SELL.HIGH_PRICE_SLIPPAGE_PCT;
      logger.info(`   💎 High-probability position: using tight ${SELL.HIGH_PRICE_SLIPPAGE_PCT}% slippage`);
    }
    
    // Execute smart sell
    const result = await smartSell(state.client, position, config);
    
    if (result.success) {
      const filled = result.filledUsd ?? (position.size * (result.avgPrice ?? position.curPrice));
      const actualSlippage = result.actualSlippagePct ?? 0;
      
      logger.info(`✅ Sold: $${filled.toFixed(2)}`);
      if (result.analysis) {
        logger.info(`   Best bid: ${(result.analysis.bestBid * 100).toFixed(1)}¢`);
        logger.info(`   Avg fill: ${((result.avgPrice ?? position.curPrice) * 100).toFixed(1)}¢`);
        logger.info(`   Slippage: ${actualSlippage.toFixed(2)}%`);
        logger.info(`   Order type: ${result.orderType ?? 'FOK'}`);
      }
      
      await sendTelegram("💰 POSITION SOLD",
        `${position.outcome} @ ${((result.avgPrice ?? position.curPrice) * 100).toFixed(0)}¢\n` +
        `P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%\n` +
        `Received: $${filled.toFixed(2)}\n` +
        `Slippage: ${actualSlippage.toFixed(2)}%\n` +
        `Reason: ${reason}`
      );
      
      return true;
    } else {
      logger.warn(`❌ Sell failed: ${result.reason}`);
      
      // Provide helpful context on why the sell failed
      if (result.analysis) {
        logger.warn(`   Best bid: ${(result.analysis.bestBid * 100).toFixed(1)}¢`);
        logger.warn(`   Expected slippage: ${result.analysis.expectedSlippagePct.toFixed(2)}%`);
        logger.warn(`   Liquidity: $${result.analysis.liquidityAtSlippage.toFixed(2)}`);
        // Note: we skip calling getSellRecommendation here to avoid
        // an additional orderbook fetch; the above analysis already explains
        // why the sell failed.
      }
      
      return false;
    }
  } catch (error) {
    logger.error(`❌ Sell error: ${error}`);
    
    if (state.errorReporter) {
      await state.errorReporter.reportError(error as Error, {
        operation: "sell_position",
        tokenId: position.tokenId,
      });
    }
    
    return false;
  }
}

/**
 * Execute sell with emergency mode support
 * Uses postOrder with configurable price protection
 */
async function sellPositionEmergency(
  position: Position,
  reason: string,
  emergencyMode: boolean
): Promise<boolean> {
  
  if (!state.client) return false;
  
  logger.info(`🔄 Selling ${position.outcome}`);
  logger.info(`   Shares: ${position.size.toFixed(2)}`);
  logger.info(`   Value: $${position.value.toFixed(2)}`);
  logger.info(`   Entry: ${(position.avgPrice * 100).toFixed(1)}¢`);
  logger.info(`   Current: ${(position.curPrice * 100).toFixed(1)}¢`);
  logger.info(`   P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%`);
  logger.info(`   Reason: ${reason}`);
  
  // Calculate minimum acceptable price based on emergency mode
  let maxAcceptablePrice: number | undefined;
  
  if (emergencyMode) {
    maxAcceptablePrice = calculateEmergencyMinPrice(
      position.avgPrice,
      state.emergencySellConfig
    );
    
    if (maxAcceptablePrice !== undefined) {
      logger.info(`   Min acceptable: ${(maxAcceptablePrice * 100).toFixed(1)}¢ (${state.emergencySellConfig.mode} mode)`);
    } else {
      logger.warn(`   ⚠️  NUCLEAR MODE - No price protection!`);
    }
  } else {
    // Normal mode: 1% slippage tolerance
    maxAcceptablePrice = position.avgPrice * 0.99;
    logger.info(`   Min acceptable: ${(maxAcceptablePrice * 100).toFixed(1)}¢ (1% slippage)`);
  }
  
  try {
    // Use postOrder with emergency price protection
    const result = await postOrder({
      client: state.client,
      tokenId: position.tokenId,
      outcome: position.outcome as "YES" | "NO",
      side: 'SELL',
      sizeUsd: position.value,
      maxAcceptablePrice, // undefined = NO PROTECTION in NUCLEAR mode
      shares: position.size, // Specify exact shares to sell
      logger,
    });
    
    if (result.success) {
      logger.info(`✅ Sold: $${result.filledUsd?.toFixed(2) || position.value.toFixed(2)}`);
      
      await sendTelegram("💰 POSITION SOLD",
        `${position.outcome}\n` +
        `Entry: ${(position.avgPrice * 100).toFixed(0)}¢\n` +
        `Sold: ${(position.curPrice * 100).toFixed(0)}¢\n` +
        `P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%\n` +
        `Received: $${result.filledUsd?.toFixed(2) || position.value.toFixed(2)}\n` +
        `Reason: ${reason}`
      );
      
      return true;
    } else {
      logger.warn(`❌ Sell failed: ${result.reason}`);
      
      if (result.reason === 'PRICE_TOO_LOW') {
        logger.warn(`   Bid price below ${state.emergencySellConfig.mode} threshold`);
        logger.warn(`   To force sell, use NUCLEAR mode (⚠️  accepts massive losses)`);
      }
      
      return false;
    }
  } catch (error) {
    logger.error(`❌ Sell error: ${error}`);
    
    if (state.errorReporter) {
      await state.errorReporter.reportError(error as Error, {
        operation: "emergency_sell",
        tokenId: position.tokenId,
        mode: state.emergencySellConfig.mode,
      });
    }
    
    return false;
  }
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
  
  // STEP 1: Check POL gas
  await checkPolBalance();

  // Auto-detect wallet balance
  if (!state.wallet || !state.client) {
    throw new Error("Wallet or client not initialized");
  }

  state.startBalance = await getUsdcBalance(state.wallet, state.address);
  state.currentBalance = state.startBalance;
  state.lastKnownBalance = state.startBalance;
  state.lastBalanceCheck = Date.now();
  
  // Get positions for portfolio calculation
  const positions = await getPositions(state.address);
  const enrichedPositions = enrichPositions(positions);
  const positionValue = enrichedPositions.reduce((sum, p) => sum + p.value, 0);
  const totalValue = state.startBalance + positionValue;

  // Detect account tier
  state.tier = getAccountTier(state.startBalance);
  logger.info(`💰 Balance Detected: ${$(state.startBalance)}`);
  logger.info(`📊 Open Positions: ${enrichedPositions.length}`);
  logger.info(`💼 Position Value: ${$(positionValue)}`);
  logger.info(`💎 Total Portfolio: ${$(totalValue)}`);
  logger.info(
    `📊 Account Tier: ${state.tier.description} (${state.tier.multiplier}× multiplier)`,
  );
  logger.info(``);

  // Check for redeemable positions on startup
  logger.info(`🎁 Checking for resolved positions to redeem...`);

  const redeemResult = await redeemAllPositions(
    state.wallet,
    state.address,
    logger,
  );

  if (redeemResult.redeemed > 0) {
    logger.info(
      `✅ Redeemed ${redeemResult.redeemed} position(s) on startup`,
    );

    // Refresh balance
    state.startBalance = await getUsdcBalance(state.wallet, state.address);
    state.currentBalance = state.startBalance;
    state.lastKnownBalance = state.startBalance;

    await sendTelegram(
      "🎁 Startup Redemption",
      `Redeemed ${redeemResult.redeemed} market(s)\n` +
        `New balance: ${$(state.startBalance)}`,
    );

    // Recalculate tier with new balance
    state.tier = getAccountTier(state.startBalance);
  }

  logger.info(``);

  // STEP 2: Auto-approve USDC
  await ensureUSDCApproval();

  // Load mode settings
  logger.info(`⚙️  MODE: ${state.mode}`);
  logger.info(
    `   Base Position: ${state.modeConfig.basePositionPct}% of balance`,
  );
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
  const targetMultiplier =
    state.mode === "AGGRESSIVE" ? 10 : state.mode === "BALANCED" ? 5 : 3;
  const target = state.startBalance * targetMultiplier;
  const weeksToTarget =
    Math.log(targetMultiplier) /
    Math.log(1 + state.modeConfig.weeklyTargetPct / 100);

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
  await sendTelegram(
    "⚡ APEX v3.0 ONLINE",
    `Mode: ${state.mode}\n` +
      `Balance: ${$(state.startBalance)}\n` +
      `Target: ${$(target)} (${targetMultiplier}×)\n` +
      `ETA: ~${Math.ceil(weeksToTarget)} weeks\n\n` +
      `Status: 🟢 HUNTING FOR PROFITS`,
  );
}

// ============================================
// APEX v3.0 - FIREWALL (CIRCUIT BREAKER)
// ============================================

async function runFirewallCheck(
  currentBalance: number,
  positions: Position[],
): Promise<void> {
  // Calculate current exposure from positions
  const currentExposure = calculateExposure(positions);
  const maxExposure = currentBalance * (state.modeConfig.maxExposurePct / 100);
  
  // Use firewall module's halt check (includes drawdown)
  const haltCheck = shouldHaltTrading(currentBalance, state.startBalance, state.modeConfig);
  
  if (haltCheck.halt) {
    // Only alert/log on transition to halted state (not every cycle)
    if (!state.tradingHalted) {
      logger.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.error(`🚨 APEX FIREWALL: ${haltCheck.reason}`);
      logger.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.error(`   Balance: ${$(currentBalance)}`);
      logger.error(`   Start Balance: ${$(state.startBalance)}`);
      logger.error(`   Exposure: ${$(currentExposure)} / ${$(maxExposure)}`);
      logger.error(`   Status: TRADING HALTED ⛔`);
      logger.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      
      // Log firewall summary
      const summary = getFirewallSummary(currentExposure, maxExposure, currentBalance, state.startBalance);
      logger.error(summary);

      await sendTelegram(
        "🚨 APEX FIREWALL: TRADING HALTED",
        `${haltCheck.reason}\n\n` +
          `Balance: ${$(currentBalance)}\n` +
          `Exposure: ${$(currentExposure)} / ${$(maxExposure)}\n\n` +
          `New trades halted. Exits/redemptions continue.`,
      );

      state.tradingHalted = true;
      state.haltReason = haltCheck.reason;
    }
    return;
  }

  // Reset halt if conditions cleared
  if (state.tradingHalted && !haltCheck.halt) {
    state.tradingHalted = false;
    state.haltReason = "";
    logger.info(
      `✅ APEX Firewall: Trading resumed (balance: ${$(currentBalance)})`,
    );
    await sendTelegram(
      "✅ APEX FIREWALL: TRADING RESUMED",
      `Balance recovered: ${$(currentBalance)}\n` + `Trading has been resumed.`,
    );
  }

  // WARNING: BALANCE GETTING LOW
  if (currentBalance < 50 && !state.lowBalanceWarned) {
    logger.warn(`⚠️ APEX FIREWALL: Low Balance Warning`);
    logger.warn(`   Balance: ${$(currentBalance)}`);
    logger.warn(getFirewallSummary(currentExposure, maxExposure, currentBalance, state.startBalance));

    await sendTelegram(
      "⚠️ LOW BALANCE WARNING",
      `Balance: ${$(currentBalance)}\n` +
        `Reducing position sizes\n` +
        `Consider adding funds`,
    );

    state.lowBalanceWarned = true;
  } else if (currentBalance >= 100 && state.lowBalanceWarned) {
    // Reset warning if balance recovered
    state.lowBalanceWarned = false;
  }

  // HOURLY REALIZED LOSS LIMIT
  // Note: Only tracks realized losses from SELL orders (not total buy spend).
  // This prevents runaway losses from poor trades rather than enforcing a hard buy cap.
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recentTrades = state.oracleState.trades.filter(
    (t) => t.timestamp > hourAgo,
  );
  const recentLoss = recentTrades.reduce(
    (sum, t) => sum + (t.pnl < 0 ? Math.abs(t.pnl) : 0),
    0,
  );

  const maxLossPerHour =
    currentBalance * (state.modeConfig.maxExposurePct / 100) * 0.5;

  if (recentLoss >= maxLossPerHour) {
    if (!state.hourlySpendingLimitReached) {
      logger.warn(`⚠️ APEX Firewall: Hourly loss limit reached`);
      logger.warn(`   Loss: ${$(recentLoss)}`);
      logger.warn(`   Max loss: ${$(maxLossPerHour)}/hour`);
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
  positions: Position[], // Pass positions from cycle to avoid extra RPC call
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
    
    // Report balance check error
    if (state.errorReporter) {
      await state.errorReporter.reportError(error as Error, {
        operation: "balance_check",
        balance: state.lastKnownBalance,
        cycleCount: state.cycleCount,
      });
    }
    
    return false;
  }

  // CRITICAL: Halt if balance too low
  if (currentBalance < 10) {
    logger.error(`🚨 BALANCE TOO LOW: ${$(currentBalance)}`);
    
    await sendTelegram(
      "🚨 CRITICAL: LOW BALANCE",
      `Balance: ${$(currentBalance)}\n` + `Cannot place orders! Minimum: $10`,
    );
    
    // Report low balance error
    if (state.errorReporter) {
      await state.errorReporter.reportError(
        new Error(`Insufficient balance: ${currentBalance}`),
        {
          operation: "trade_attempt",
          balance: currentBalance,
          cycleCount: state.cycleCount,
        },
      );
    }
    
    return false;
  }

  // Calculate intelligent reserves using positions from current cycle
  const reserves = calculateIntelligentReserves(currentBalance, positions);
  const availableCapital = reserves.availableForTrading;

  if (availableCapital <= 0) {
    logger.warn(`⚠️ No capital available (all reserved)`);
    return false;
  }

  // Calculate dynamic size based on balance and strategy
  const dynamicSize = calculatePositionSize(
    currentBalance,
    state.modeConfig,
    strategy,
  );

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
    logger.error(
      `🚨 IMPOSSIBLE ORDER: Size ${$(finalSize)} > Balance ${$(currentBalance)}`,
    );
    return false;
  }

  // Log trade details
  logger.info(`⚡ APEX ${strategy}: Buying ${outcome}`);
  logger.info(`   Balance: ${$(currentBalance)}`);
  logger.info(`   Available: ${$(availableCapital)}`);
  logger.info(`   Requested: ${$(requestedSize)}`);
  logger.info(`   Placing: ${$(finalSize)}`);

  if (!state.liveTrading) {
    logger.info(
      `🔸 [SIM] ⚡ APEX ${strategy}: BUY ${outcome} ${$(finalSize)} | ${reason}`,
    );
    await sendTelegram(
      `[SIM] APEX ${strategy} BUY`,
      `${reason}\n${outcome} ${$(finalSize)}`,
    );

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
          `Balance: ~${$(state.lastKnownBalance)}`,
      );

      // Don't record buy trades in Oracle - only record sells with actual P&L
      state.tradesExecuted++;
      invalidatePositions();
      return true;
    }

    if (result.reason !== "SIMULATED") {
      logger.warn(
        `⚡ APEX ${strategy}: BUY failed - ${result.reason} | ${reason}`,
      );
      
      // Report order failures to error reporter
      if (state.errorReporter && result.reason) {
        const errorMsg = result.reason;
        
        // Only report critical errors (balance, allowance, auth)
        if (
          errorMsg.includes("INSUFFICIENT_BALANCE") ||
          errorMsg.includes("INSUFFICIENT_ALLOWANCE") ||
          errorMsg.includes("401") ||
          errorMsg.includes("CLOUDFLARE")
        ) {
          await state.errorReporter.reportError(
            new Error(`Order failed: ${result.reason}`),
            {
              operation: "place_order",
              balance: state.lastKnownBalance,
              cycleCount: state.cycleCount,
              tokenId,
            },
          );
        }
      }
    }
    return false;
  } catch (error) {
    logger.error(`❌ Order error: ${error}`);
    
    // Report unexpected order errors
    if (state.errorReporter) {
      await state.errorReporter.reportError(error as Error, {
        operation: "place_order_exception",
        balance: state.lastKnownBalance,
        cycleCount: state.cycleCount,
        tokenId,
      });
    }
    
    return false;
  }
}

// Note: The deprecated sell() function has been removed.
// All sell operations now use sellPosition() which has:
// - Proper price protection (5% slippage tolerance)
// - Live trading mode checking  
// - Better error handling
// - Telegram notifications

// ============================================
// APEX v3.0 - HUNTER SCANNER
// ============================================

interface MarketData {
  conditionId: string;
  question: string;
  tokens: { tokenId: string; outcome: string; price: number }[];
  volume: number;
  liquidity: number;
}

/**
 * Fetch active markets from Gamma API
 * NOTE: This function is currently unused but provides infrastructure
 * for future full-market scanning capabilities in APEX Hunter.
 * When integrated, it will enable scanning external markets beyond current positions.
 */
async function fetchActiveMarkets(limit: number = 100): Promise<MarketData[]> {
  try {
    const url = `${POLYMARKET_API.GAMMA}/markets?limit=${limit}&active=true`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (!Array.isArray(data)) return [];
    
    return data.map(m => ({
      conditionId: m.conditionId,
      question: m.question,
      tokens: (m.tokens || []).map((t: any) => ({
        tokenId: t.tokenId || t.token_id,
        outcome: t.outcome,
        price: Number(t.price) || 0,
      })),
      volume: Number(m.volume) || 0,
      liquidity: Number(m.liquidity) || 0,
    }));
  } catch (error) {
    if (logger.debug) {
      logger.debug(`Market fetch error: ${error}`);
    }
    return [];
  }
}

async function runHunterScan(
  positions: Position[],
): Promise<HunterOpportunity[]> {
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
      logger.info(
        `   ${i + 1}. ${opp.pattern}: ${opp.outcome} @ $${opp.price.toFixed(2)} (${opp.confidence}% conf)`,
      );
    }
  }

  return opportunities;
}

async function executeHunterOpportunities(
  opportunities: HunterOpportunity[],
  currentBalance: number,
  positions: Position[],
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
      Strategy.HUNTER,
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
      positions,
      opp.marketId,
    );

    if (success) {
      state.hunterStats.trades++;
      state.actedPositions.add(opp.tokenId);

      await sendTelegram(
        "🎯 APEX HUNTER STRIKE",
        `Pattern: ${opp.pattern}\n` +
          `${opp.outcome} @ $${opp.price.toFixed(2)}\n` +
          `Confidence: ${opp.confidence}%\n` +
          `Reason: ${opp.reason}`,
      );
    }
  }
}

// ============================================
// APEX v3.0 - EXIT STRATEGIES
// ============================================

/**
 * Run all exit strategies
 * Priority order: Blitz → Command → Ratchet → Ladder → Reaper
 */
async function runExitStrategies(positions: Position[]): Promise<number> {
  let exitCount = 0;
  
  // Enrich positions with entry time and price history
  const enrichedPositions = enrichPositions(positions);
  
  // Track which positions we've sold in this cycle to prevent double-selling
  const soldTokenIds = new Set<string>();
  
  // BLITZ - Quick scalps (10%+ profit, high urgency)
  for (const p of enrichedPositions) {
    if (soldTokenIds.has(p.tokenId)) continue;
    
    const signal = detectBlitz(p, 10, 5);
    if (signal && signal.urgency === "HIGH") {
      const success = await sellPosition(p, signal.reason);
      if (success) {
        exitCount++;
        soldTokenIds.add(p.tokenId);
      }
    }
  }
  
  // COMMAND - AutoSell near $1 (99.5¢+)
  for (const p of enrichedPositions) {
    if (soldTokenIds.has(p.tokenId)) continue;
    
    const signal = detectAutoSell(p, 0.995);
    if (signal) {
      const success = await sellPosition(p, signal.reason);
      if (success) {
        exitCount++;
        soldTokenIds.add(p.tokenId);
      }
    }
  }
  
  // RATCHET - Trailing stops (adaptive based on volatility)
  for (const p of enrichedPositions) {
    if (soldTokenIds.has(p.tokenId)) continue;
    
    const ratchetState = state.ratchetStates.get(p.tokenId);
    const trailingPct = calculateOptimalTrailing(p);
    const updated = updateRatchet(p, ratchetState || null, trailingPct);
    state.ratchetStates.set(p.tokenId, updated);
    
    const signal = isRatchetTriggered(p, updated);
    if (signal) {
      const success = await sellPosition(p, signal.reason);
      if (success) {
        exitCount++;
        soldTokenIds.add(p.tokenId);
        state.ratchetStates.delete(p.tokenId);
      }
    }
  }
  
  // LADDER - Partial exits at profit milestones
  for (const p of enrichedPositions) {
    if (soldTokenIds.has(p.tokenId)) continue;
    
    const ladderState = state.ladderStates.get(p.tokenId);
    const signal = detectLadder(p, ladderState || null, DEFAULT_LADDER);
    if (signal) {
      // Create partial position for partial sell
      const partialSize = calculatePartialSize(p, signal.exitPct);
      const partialPosition: Position = { 
        ...p, 
        size: partialSize, 
        value: partialSize * p.curPrice,
        // Scale P&L to the partial size
        pnlUsd: p.size && p.size > 0 && p.pnlUsd !== undefined
          ? (p.pnlUsd * partialSize) / p.size
          : p.pnlUsd,
        // Percentage P&L remains the same for the partial position
        pnlPct: p.pnlPct,
      };
      
      const success = await sellPosition(partialPosition, signal.reason);
      if (success) {
        exitCount++;
        const updated = updateLadderState(
          ladderState || {
            tokenId: p.tokenId,
            exitedPct: 0,
            lastMilestone: 0,
            exitHistory: [],
          }, 
          signal.exitPct, 
          signal.milestone
        );
        state.ladderStates.set(p.tokenId, updated);
        
        // NOTE: We intentionally DO NOT delete the ladder state when exitedPct >= 100.
        // If, due to any inconsistency, this position remains in the portfolio
        // on a subsequent cycle, preserving the final ladder state prevents the
        // ladder logic from being reinitialized from 0% exited for the same token.
      }
    }
  }
  
  // REAPER - Scavenger mode opportunistic exits
  const isLowLiquidity = shouldEnterScavengerMode(
    state.volume24h || 0,
    state.orderBookDepth || 0,
    state.targets.length
  );
  
  if (isLowLiquidity) {
    const reaperSignals: ReaperSignal[] = [];
    
    for (const p of enrichedPositions) {
      if (soldTokenIds.has(p.tokenId)) continue;
      
      const signal = detectReaper(p, {
        isLowLiquidity: true,
        volumeDry: true,
        spreadWide: false,
        targetInactive: state.targets.length === 0,
      });
      
      if (signal) reaperSignals.push(signal);
    }
    
    const prioritized = prioritizeReaperExits(reaperSignals);
    
    for (const signal of prioritized.filter(s => s.priority === "HIGH")) {
      if (soldTokenIds.has(signal.position.tokenId)) continue;
      
      const success = await sellPosition(signal.position, signal.reason);
      if (success) {
        exitCount++;
        soldTokenIds.add(signal.position.tokenId);
      }
    }
  }
  
  return exitCount;
}

// ============================================
// APEX v3.0 - PROTECTION STRATEGIES
// ============================================

/**
 * Run all protection strategies
 * Priority order: Guardian (stop-loss) → Sentinel (emergency) → Shield (hedging)
 */
async function runProtectionStrategies(positions: Position[]): Promise<number> {
  let protectionCount = 0;
  
  // Enrich positions with entry time and price history
  const enrichedPositions = enrichPositions(positions);
  
  // Track which positions we've acted on
  const actedTokenIds = new Set<string>();
  
  // Get mode-specific protection settings
  const maxLossPct = state.mode === "CONSERVATIVE" ? 15 : 
                     state.mode === "BALANCED" ? 20 : 25;
  const hedgeTriggerPct = state.mode === "CONSERVATIVE" ? 15 : 
                          state.mode === "BALANCED" ? 20 : 25;
  
  // GUARDIAN - Hard stop-loss protection
  for (const p of enrichedPositions) {
    if (actedTokenIds.has(p.tokenId)) continue;
    
    // Check if position already has a hedge (skip guardian if hedged)
    const isHedged = state.hedgeStates.has(p.tokenId);
    
    // Check for danger zone warning
    if (isInDangerZone(p, maxLossPct * 0.6)) {
      logger.warn(`🛡️ APEX Guardian: ${p.outcome} in danger zone (${p.pnlPct.toFixed(1)}% loss)`);
    }
    
    const signal = detectGuardian(p, maxLossPct, isHedged);
    if (signal) {
      logger.warn(`🛡️ APEX Guardian: STOP-LOSS triggered for ${p.outcome} (${signal.stopLossPct.toFixed(1)}% loss)`);
      const success = await sellPosition(p, signal.reason);
      if (success) {
        protectionCount++;
        actedTokenIds.add(p.tokenId);
        
        // Clean up any associated hedge state
        state.hedgeStates.delete(p.tokenId);
        
        await sendTelegram(
          "🛡️ GUARDIAN STOP-LOSS",
          `${p.outcome} exited at ${signal.stopLossPct.toFixed(1)}% loss\n` +
          `Value: $${p.value.toFixed(2)}\n` +
          `Reason: ${signal.reason}`
        );
      }
    }
  }
  
  // SENTINEL - Emergency exit for markets closing soon
  for (const p of enrichedPositions) {
    if (actedTokenIds.has(p.tokenId)) continue;
    
    const signal = detectSentinel(p);
    if (signal) {
      const urgency = signal.minutesToClose !== undefined 
        ? getSentinelUrgency(signal.minutesToClose) 
        : "HIGH";
      
      // Force exit on CRITICAL urgency or if force flag is set
      if (urgency === "CRITICAL" || signal.force) {
        logger.warn(`🚨 APEX Sentinel: EMERGENCY EXIT for ${p.outcome} - ${signal.reason}`);
        const success = await sellPosition(p, signal.reason);
        if (success) {
          protectionCount++;
          actedTokenIds.add(p.tokenId);
          
          await sendTelegram(
            "🚨 SENTINEL EMERGENCY",
            `${p.outcome} force exited!\n` +
            `Time remaining: ${signal.minutesToClose?.toFixed(1) ?? "Unknown"} min\n` +
            `P&L: ${p.pnlPct.toFixed(1)}%\n` +
            `Reason: ${signal.reason}`
          );
        }
      } else if (urgency === "HIGH") {
        // Warn but don't force exit
        logger.warn(`⚠️ APEX Sentinel: WARNING for ${p.outcome} - market closing soon`);
      }
    }
  }
  
  // SHIELD - Intelligent hedging for losing positions
  for (const p of enrichedPositions) {
    if (actedTokenIds.has(p.tokenId)) continue;
    
    const isHedged = state.hedgeStates.has(p.tokenId);
    const signal = detectShield(p, isHedged, hedgeTriggerPct);
    
    if (signal) {
      logger.info(`🛡️ APEX Shield: Hedge signal for ${p.outcome} (${p.pnlPct.toFixed(1)}% loss)`);
      
      // Calculate hedge position size
      const positionSize = calculatePositionSize(
        state.currentBalance,
        state.modeConfig,
        Strategy.SHADOW, // Use conservative weight for hedges
      );
      const hedgeSize = Math.min(signal.hedgeSize, positionSize * 0.5);
      
      // NOTE: Executing a hedge requires the tokenId of the opposite outcome, which
      // we don't have directly. In a real implementation, we would need to:
      // 1. Look up the market by marketId/conditionId
      // 2. Find the opposite outcome's tokenId
      // 3. Execute the buy on that tokenId
      //
      // For now, we log the hedge signal for manual follow-up and track that we've
      // considered hedging this position. Full hedge implementation requires market
      // data integration to resolve opposite tokenIds.
      
      if (hedgeSize >= 5) {
        logger.warn(
          `🛡️ APEX Shield: Hedge recommended for ${p.outcome} ` +
          `(${p.pnlPct.toFixed(1)}% loss) → consider ${signal.hedgeOutcome} hedge of $${hedgeSize.toFixed(2)}`
        );
        
        await sendTelegram(
          "🛡️ SHIELD HEDGE SIGNAL",
          `⚠️ Manual hedge recommended:\n` +
          `Position: ${p.outcome}\n` +
          `Current loss: ${p.pnlPct.toFixed(1)}%\n` +
          `Recommended: Buy ${signal.hedgeOutcome} for $${hedgeSize.toFixed(2)}\n\n` +
          `Note: Automatic hedging requires market data integration.`
        );
        
        // Mark that we've signaled this position to avoid spam
        actedTokenIds.add(p.tokenId);
      }
    }
  }
  
  // NOTE: Hedge stop-loss/take-profit monitoring is disabled until automatic
  // hedge execution is implemented with proper tokenId resolution.
  // The existing positions are already monitored by Guardian for stop-loss.
  
  return protectionCount;
}

// ============================================
// APEX v3.0 - ENTRY STRATEGIES
// ============================================

async function runShadowStrategy(
  positions: Position[],
  currentBalance: number,
): Promise<void> {
  // APEX Shadow - Copy Trading using module functions
  if (state.targets.length === 0) return;

  const allocation = state.strategyAllocations.get(Strategy.SHADOW) || 0;
  if (allocation === 0) return;

  // Use module's fetchShadowTrades with config
  const rawTrades = await fetchShadowTrades(state.targets, {
    minTradeSize: 10,
    maxTradeSize: 1000,
    onlyBuys: true,
    timeWindowSeconds: 60,
  });
  
  // Use module's quality filtering
  const qualityTrades = filterQualityTrades(rawTrades, 0.3);
  
  // Log trader stats periodically
  if (state.cycleCount % 60 === 0 && qualityTrades.length > 0) {
    const stats = getTraderStats(qualityTrades);
    logger.info(`📊 APEX Shadow: Tracking ${stats.length} traders, ${qualityTrades.length} quality trades`);
  }

  // Calculate position size
  const positionSize = calculatePositionSize(
    currentBalance,
    state.modeConfig,
    Strategy.SHADOW,
  );

  for (const t of qualityTrades) {
    const size = Math.min(t.sizeUsd * 1.0, positionSize);

    await buy(
      t.tokenId,
      t.outcome as "YES" | "NO",
      size,
      `Shadow: Following ${t.trader.slice(0, 8)}... @ ${(t.price * 100).toFixed(0)}¢`,
      Strategy.SHADOW,
      positions,
      t.marketId,
    );
  }
}

async function runCloserStrategy(
  positions: Position[],
  currentBalance: number,
): Promise<void> {
  // APEX Closer - Endgame Strategy using module functions
  const allocation = state.strategyAllocations.get(Strategy.CLOSER) || 0;
  if (allocation === 0) return;

  const basePositionSize = calculatePositionSize(
    currentBalance,
    state.modeConfig,
    Strategy.CLOSER,
  );

  for (const p of positions) {
    // Use module's detectCloser to find opportunities
    const signal = detectCloser(
      p.marketEndTime,
      p.curPrice,
      p.outcome as "YES" | "NO",
      p.tokenId,
      p.conditionId,
      p.marketId,
    );
    
    if (signal && signal.confidence > 50) {
      // Use module's risk-adjusted position sizing
      const hoursToClose = signal.hoursToClose;
      const closerSize = calculateCloserSize(basePositionSize, hoursToClose, p.curPrice);
      
      if (closerSize >= 5) {
        logger.info(`📊 APEX Closer: ${signal.reason} (confidence: ${signal.confidence.toFixed(0)}%)`);
        
        await buy(
          p.tokenId,
          p.outcome as "YES" | "NO",
          closerSize,
          signal.reason,
          Strategy.CLOSER,
          positions,
          p.marketId,
        );
      }
    }
    
    // Check if positions should exit before close
    if (shouldExitBeforeClose(p, 1)) {
      logger.info(`📊 APEX Closer: Exit recommended - market closing soon`);
      await sellPosition(p, "APEX Closer: Market closing soon");
    }
  }
}

async function runAmplifierStrategy(
  positions: Position[],
  currentBalance: number,
): Promise<void> {
  // APEX Amplifier - Stack Winners using module functions
  const allocation = state.strategyAllocations.get(Strategy.AMPLIFIER) || 0;
  if (allocation === 0) return;

  const stackedTokens = new Set<string>();
  
  // Calculate current exposure for safety checks
  const currentExposure = calculateExposure(positions);
  const maxExposure = currentBalance * (state.modeConfig.maxExposurePct / 100);
  
  const maxStackSize = calculatePositionSize(
    currentBalance,
    state.modeConfig,
    Strategy.AMPLIFIER,
  );

  for (const p of positions) {
    if (stackedTokens.has(p.tokenId)) continue;
    
    // Check if already stacked (would need position history tracking)
    const alreadyStacked = state.actedPositions.has(`stack:${p.tokenId}`);
    
    // Use module's detectAmplifier to find stacking opportunities
    const signal = detectAmplifier(p, maxStackSize, alreadyStacked);
    
    if (signal && signal.confidence > 30) {
      // Use module's safety check before stacking
      if (!isSafeToStack(p, currentExposure, maxExposure)) {
        logger.debug?.(`📊 APEX Amplifier: Skipping ${p.outcome} - unsafe to stack`);
        continue;
      }
      
      logger.info(`📊 APEX Amplifier: ${signal.reason} (confidence: ${signal.confidence.toFixed(0)}%)`);
      
      const success = await buy(
        p.tokenId,
        p.outcome as "YES" | "NO",
        signal.stackSize,
        signal.reason,
        Strategy.AMPLIFIER,
        positions,
        p.marketId,
      );

      if (success) {
        stackedTokens.add(p.tokenId);
        state.actedPositions.add(`stack:${p.tokenId}`);
      }
    }
  }
}

async function runGrinderStrategy(
  positions: Position[],
  currentBalance: number,
): Promise<void> {
  // APEX Grinder - High Volume Trades
  const allocation = state.strategyAllocations.get(Strategy.GRINDER) || 0;
  if (allocation === 0) return;

  // Calculate position size for grinder strategy
  const basePositionSize = calculatePositionSize(
    currentBalance,
    state.modeConfig,
    Strategy.GRINDER,
  );
  
  // Grinder uses smaller position sizes for more frequent trades
  const grindSize = calculateGrindSize(basePositionSize);
  
  if (grindSize < 5) return; // Minimum $5 for grind trades
  
  // Check existing positions for grind exit conditions
  for (const p of positions) {
    // NOTE: Market metrics are approximated from available data.
    // In production, these would come from market data API calls.
    // The Grinder strategy currently uses conservative defaults that favor
    // P&L-based exits rather than volume/spread-based exits.
    const metrics: MarketMetrics = {
      tokenId: p.tokenId,
      volume24h: state.volume24h || 5000, // Use state or default
      volume1h: (state.volume24h || 5000) / 24, // Approximate hourly volume
      spread: 0.015, // Conservative 1.5% spread assumption
      liquidity: 1000,
      // Price stability: mid-range prices (20-80¢) are more stable
      priceStability: p.curPrice > 0.2 && p.curPrice < 0.8 ? 0.8 : 0.5,
    };
    
    // Check if should exit existing grind position
    // Exit triggers: P&L >= 8%, or detected volume/spread issues
    if (shouldExitGrind(p, metrics)) {
      logger.info(`📊 APEX Grinder: Exit signal for ${p.outcome} (${p.pnlPct.toFixed(1)}%)`);
      await sellPosition(p, `APEX Grinder: Exit (${p.pnlPct.toFixed(1)}% P&L)`);
    }
  }
  
  // Note: Entry signals would require market scanning with volume data
  // For now, Grinder focuses on managing existing positions using P&L targets
}

async function runVelocityStrategy(
  positions: Position[],
  currentBalance: number,
): Promise<void> {
  // APEX Velocity - Momentum Trading
  const allocation = state.strategyAllocations.get(Strategy.VELOCITY) || 0;
  if (allocation === 0) return;

  // Calculate position size for velocity strategy
  const positionSize = calculatePositionSize(
    currentBalance,
    state.modeConfig,
    Strategy.VELOCITY,
  );
  
  if (positionSize < 5) return; // Minimum $5 for velocity trades
  
  // Update price history for all positions
  for (const p of positions) {
    const history = state.priceHistory.get(p.tokenId) || [];
    history.push(p.curPrice);
    
    // Keep last 60 price points (approximately 5 minutes of data at 5-second intervals)
    if (history.length > 60) history.shift();
    state.priceHistory.set(p.tokenId, history);
    
    // Check for momentum reversal on existing positions (exit signal)
    if (history.length >= 10) {
      const currentVelocity = calculateVelocity(history);
      
      if (isMomentumReversing(p, currentVelocity)) {
        logger.info(`⚡ APEX Velocity: Momentum reversal for ${p.outcome} (velocity: ${currentVelocity.toFixed(1)}%)`);
        await sellPosition(p, `APEX Velocity: Momentum reversal (${currentVelocity.toFixed(1)}% velocity)`);
      } else if (shouldRideMomentum(p, currentVelocity)) {
        // Keep position, momentum still strong
        logger.debug?.(`⚡ APEX Velocity: Riding momentum for ${p.outcome} (velocity: ${currentVelocity.toFixed(1)}%)`);
      }
    }
  }
  
  // Note: New entry signals would require scanning markets with price history
  // For now, Velocity focuses on managing existing positions based on momentum
}

// ============================================
// APEX v3.0 - HELPER FUNCTIONS
// ============================================

/**
 * Send hourly summary
 */
async function sendHourlySummary(balance: number): Promise<void> {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recentTrades = state.oracleState.trades.filter(t => t.timestamp > hourAgo);
  
  const pnl = recentTrades.reduce((sum, t) => sum + t.pnl, 0);
  const successfulTrades = recentTrades.filter(t => t.success);
  const wins = successfulTrades.filter(t => t.pnl > 0).length;
  const losses = successfulTrades.filter(t => t.pnl <= 0).length;
  const winRate = successfulTrades.length > 0 ? (wins / successfulTrades.length) * 100 : 0;
  
  // Get current positions
  if (!state.client) return;
  const positions = await getPositions(state.address);
  const enrichedPositions = enrichPositions(positions);
  const positionValue = enrichedPositions.reduce((sum, p) => sum + p.value, 0);
  const totalValue = balance + positionValue;
  
  await sendTelegram("📊 HOURLY SUMMARY",
    `Last Hour:\n` +
    `Trades: ${recentTrades.length}\n` +
    `Wins: ${wins} | Losses: ${losses}\n` +
    `Win rate: ${winRate.toFixed(1)}%\n` +
    `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n\n` +
    `Current:\n` +
    `Balance: $${balance.toFixed(2)}\n` +
    `Positions: ${enrichedPositions.length} ($${positionValue.toFixed(2)})\n` +
    `Total: $${totalValue.toFixed(2)}`
  );
}

/**
 * Send weekly report
 */
async function sendWeeklyReport(currentBalance: number): Promise<void> {
  const weekGain = currentBalance - state.weekStartBalance;
  const weekGainPct =
    state.weekStartBalance > 0 ? (weekGain / state.weekStartBalance) * 100 : 0;

  const targetMultiplier =
    state.mode === "AGGRESSIVE" ? 10 : state.mode === "BALANCED" ? 5 : 3;
  const target = state.startBalance * targetMultiplier;
  const progressPct = (currentBalance / target) * 100;

  await sendTelegram(
    "📈 APEX WEEKLY REPORT",
    `Week Complete!\n\n` +
      `Starting: ${$(state.weekStartBalance)}\n` +
      `Ending: ${$(currentBalance)}\n` +
      `Gain: ${weekGain >= 0 ? "+" : ""}${$(weekGain)} (${weekGainPct >= 0 ? "+" : ""}${weekGainPct.toFixed(1)}%)\n\n` +
      `Target: +${state.modeConfig.weeklyTargetPct}%\n` +
      `Status: ${weekGainPct >= state.modeConfig.weeklyTargetPct ? "🟢 ON TRACK" : "🟡 BELOW TARGET"}\n\n` +
      `Progress to Goal:\n` +
      `${$(currentBalance)} / ${$(target)}\n` +
      `${progressPct.toFixed(0)}% Complete`,
  );
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
    const emoji =
      perf.rank === "CHAMPION"
        ? "🏆"
        : perf.rank === "PERFORMING"
          ? "✅"
          : perf.rank === "TESTING"
            ? "🧪"
            : perf.rank === "STRUGGLING"
              ? "⚠️"
              : "❌";

    logger.info(`${emoji} APEX ${perf.strategy}:`);
    logger.info(
      `   Trades: ${perf.totalTrades} | WR: ${perf.winRate.toFixed(0)}% | P&L: ${$(perf.totalPnL)}`,
    );
    logger.info(
      `   Score: ${perf.score.toFixed(0)}/100 | Allocation: ${perf.allocation.toFixed(0)}%`,
    );
  }

  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Send Telegram report
  const totalPnl = performanceWithAllocations.reduce(
    (sum: number, p: StrategyPerformance) => sum + p.totalPnL,
    0,
  );
  const totalTrades = performanceWithAllocations.reduce(
    (sum: number, p: StrategyPerformance) => sum + p.totalTrades,
    0,
  );
  const avgWinRate =
    performanceWithAllocations.length > 0
      ? performanceWithAllocations.reduce(
          (sum: number, p: StrategyPerformance) => sum + p.winRate,
          0,
        ) / performanceWithAllocations.length
      : 0;

  const champion = performanceWithAllocations.find(
    (p: StrategyPerformance) => p.rank === "CHAMPION",
  );
  const sorted = [...performanceWithAllocations].sort(
    (a, b) => a.score - b.score,
  );
  const worst = sorted[0];

  await sendTelegram(
    "🧠 APEX ORACLE - DAILY REVIEW",
    `24hr Performance:\n` +
      `Total Trades: ${totalTrades}\n` +
      `P&L: ${totalPnl >= 0 ? "+" : ""}${$(totalPnl)}\n` +
      `Win Rate: ${avgWinRate.toFixed(0)}%\n\n` +
      `🏆 Best: ${champion?.strategy || "None"} (+${$(champion?.totalPnL || 0)})\n` +
      `⚠️ Worst: ${worst?.strategy || "None"} (${$(worst?.totalPnL || 0)})\n\n` +
      `Capital reallocated for next 24hrs`,
  );
}

// ============================================
// APEX v3.0 - REDEMPTION
// ============================================

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
    logger.error(
      `Failed to update USDC balance; using last known balance: ${error}`,
    );
  }

  // Get positions with error handling
  let positions: Position[] = [];
  try {
    positions = await getPositions(state.address);
  } catch (error) {
    logger.error(
      `Failed to fetch positions; continuing with empty positions: ${error}`,
    );
    positions = [];
  }

  // ============================================
  // PRIORITY -1: RECOVERY MODE CHECK
  // ============================================
  
  // Check if we should enter/exit recovery mode
  if (state.recoveryMode || state.currentBalance < RECOVERY_MODE_BALANCE_THRESHOLD) {
    if (!state.recoveryMode && state.currentBalance < RECOVERY_MODE_BALANCE_THRESHOLD && positions.length > 0) {
      // Just entered recovery mode
      state.recoveryMode = true;
      state.prioritizeExits = true;
      
      logger.warn(`🚨 RECOVERY MODE ACTIVATED (balance: ${$(state.currentBalance)})`);
      
      await sendTelegram(
        "🚨 Recovery Mode Activated",
        `Balance dropped to ${$(state.currentBalance)}\n` +
          `Positions: ${positions.length}\n` +
          `Prioritizing exits to free capital.`,
      );
    }
    
    if (state.recoveryMode) {
      // PRIORITY 0: Auto-redeem resolved markets (FREE MONEY!)
      const redeemed = await runAutoRedeem();
      if (redeemed > 0) {
        logger.info(
          `✅ Auto-redeemed ${redeemed} positions - checking new balance...`,
        );

        // Refresh balance after redemption
        try {
          const newBalance = await getUsdcBalance(state.wallet, state.address);
          state.currentBalance = newBalance;
          state.lastKnownBalance = newBalance;

          if (newBalance >= RECOVERY_MODE_BALANCE_THRESHOLD) {
            logger.info(
              `🎉 RECOVERY COMPLETE! Balance: ${$(newBalance)}`,
            );
            state.recoveryMode = false;
            state.prioritizeExits = false;

            await sendTelegram(
              "✅ RECOVERY COMPLETE (via redemption)",
              `Balance restored: ${$(newBalance)}\n` +
                `Redeemed ${redeemed} positions\n\n` +
                `Resuming normal trading`,
            );

            return; // Exit recovery mode
          }

          logger.info(
            `📊 Balance after redemption: ${$(newBalance)} (need $${RECOVERY_MODE_BALANCE_THRESHOLD})`,
          );
        } catch (error) {
          logger.error(`Failed to update balance after redemption: ${error}`);
        }
      }

      // Run recovery exits
      const exitsCount = await runRecoveryExits(positions, state.currentBalance);
      
      if (exitsCount > 0) {
        logger.info(`✅ Recovery: Exited ${exitsCount} position(s)`);
        invalidatePositions(); // Force refresh
        
        // Recheck balance
        try {
          state.currentBalance = await getUsdcBalance(state.wallet, state.address);
          state.lastKnownBalance = state.currentBalance;
        } catch (error) {
          logger.error(`Failed to update balance after recovery exits: ${error}`);
        }
      }
      
      // Check if we can exit recovery mode
      if (state.currentBalance >= RECOVERY_MODE_BALANCE_THRESHOLD) {
        state.recoveryMode = false;
        state.prioritizeExits = false;
        
        logger.info(`✅ RECOVERY MODE COMPLETE - Balance restored to ${$(state.currentBalance)}`);
        
        await sendTelegram(
          "✅ Recovery Mode Complete",
          `Balance restored to ${$(state.currentBalance)}\n` +
            `Resuming normal operations.`,
        );
      } else {
        // Still in recovery, skip new entries
        logger.info(`🚨 Recovery mode active - skipping new entries`);
        return;
      }
    }
  }

  // ============================================
  // PRIORITY -1: FIREWALL CHECK (CRITICAL!)
  // ============================================
  await runFirewallCheck(state.currentBalance, positions);

  // HALT if trading disabled
  if (state.tradingHalted) {
    logger.error(`⛔ Trading halted: ${state.haltReason}`);
    // Still allow exits and redemptions even when halted
    const exitCount = await runExitStrategies(positions);
    if (exitCount > 0) {
      logger.info(`📤 Exited ${exitCount} positions while halted`);
      invalidatePositions();
    }
    // Check for redemptions even when halted
    const redeemed = await runAutoRedeem();
    if (redeemed > 0) {
      logger.info(`💰 Auto-redeemed ${redeemed} positions while halted`);
      invalidatePositions();
    }
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
  const exitCount = await runExitStrategies(positions);
  if (exitCount > 0) {
    logger.info(`📤 Exited ${exitCount} positions this cycle`);
    invalidatePositions(); // Force refresh after exits
  }

  // ============================================
  // PRIORITY 1.5: PROTECTION (Guard remaining positions)
  // ============================================
  const protectionCount = await runProtectionStrategies(positions);
  if (protectionCount > 0) {
    logger.info(`🛡️ Protection actions: ${protectionCount} this cycle`);
    invalidatePositions(); // Force refresh after protection actions
  }

  // ============================================
  // PRIORITY 2: REDEMPTION (Convert wins to USDC)
  // ============================================
  // Auto-redeem runs every 50 cycles in normal mode, every 10 in recovery
  const redeemed = await runAutoRedeem();
  if (redeemed > 0) {
    logger.info(`💰 Auto-redeemed ${redeemed} positions`);
    invalidatePositions(); // Force refresh after redemption
    
    // Refresh balance after redemption
    try {
      state.currentBalance = await getUsdcBalance(state.wallet, state.address);
      state.lastKnownBalance = state.currentBalance;
    } catch (error) {
      logger.error(`Failed to update balance after redemption: ${error}`);
    }
  }

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
    const reserves = calculateIntelligentReserves(
      state.currentBalance,
      positions,
    );

    if (reserves.availableForTrading > 5) {
      // Execute Hunter opportunities first (highest priority)
      await executeHunterOpportunities(
        opportunities,
        state.currentBalance,
        positions,
      );

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
    } else if (
      process.env.OPENVPN_ENABLED === "true" ||
      process.env.OVPN_CONFIG
    ) {
      logger.info("🔐 VPN: OpenVPN enabled");
      capturePreVpnRouting();
      await startOpenvpn(logger);
      await setupRpcBypass(rpcUrl, logger);
      await setupPolymarketReadBypass(logger);
    }

    // Validate live trading
    state.liveTrading = isLiveTradingEnabled();
    if (!state.liveTrading) {
      logger.warn(
        "⚠️  SIMULATION MODE - Set LIVE_TRADING=I_UNDERSTAND_THE_RISKS to enable",
      );
    }

    // Initialize wallet and client
    const authResult = await createClobClient(privateKey, rpcUrl);
    if (
      !authResult.success ||
      !authResult.client ||
      !authResult.wallet ||
      !authResult.address
    ) {
      throw new Error(
        `Authentication failed: ${authResult.error || "Unknown error"}`,
      );
    }

    state.client = authResult.client;
    state.wallet = authResult.wallet;
    state.address = authResult.address;

    // Initialize Error Reporter
    state.errorReporter = errorReporter;

    // Check startup balance and determine if recovery mode needed
    const usdcBalance = await getUsdcBalance(
      authResult.wallet,
      authResult.address,
    );
    
    const balanceCheck = await checkStartupBalance(usdcBalance, authResult.address);
    
    if (balanceCheck.shouldExit) {
      process.exit(1);
    }
    
    // Set recovery mode if needed
    state.recoveryMode = balanceCheck.recoveryMode;
    state.prioritizeExits = balanceCheck.recoveryMode;

    // Check USDC allowance
    const allowance = await getUsdcAllowance(
      authResult.wallet,
      authResult.address,
    );
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
        if (state.errorReporter) {
          await state.errorReporter.reportError(err as Error, {
            operation: "apex_main_cycle",
            balance: state.lastKnownBalance,
            cycleCount: state.cycleCount,
          });
        }

        await sendTelegram("⚠️ Cycle Error", String(err));
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch (err) {
    logger.error(`❌ Fatal error: ${err}`);

    // Report fatal error to GitHub
    if (state.errorReporter) {
      await state.errorReporter.reportError(err as Error, {
        operation: "apex_initialization",
        balance: state.startBalance,
      });
    }

    await sendTelegram("❌ Fatal Error", String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
