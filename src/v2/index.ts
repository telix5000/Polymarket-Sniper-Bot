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
 * RISK MANAGEMENT (⚠️ Important for API limits):
 *   MAX_OPEN_POSITIONS   - Max concurrent positions (default: 1000, provides 500 normal + 500 hedge slots)
 *                          ⚠️ Higher values = more API calls. If hitting rate limits, reduce to 50-100.
 *                          Recommended: 50-100 for free API tiers, 500-1000 for high-volume trading.
 *   HEDGE_BUFFER         - Reserve this many position slots for protective hedges (default: 500)
 *                          ⚠️ IMPORTANT: Normal trades stop at (MAX_OPEN_POSITIONS - HEDGE_BUFFER)
 *                          so you can ALWAYS hedge when losing. Must be < MAX_OPEN_POSITIONS.
 *   SCALE_DOWN_THRESHOLD - Start scaling bets when positions >= this % of effective max (default: 0.7 = 70%)
 *   SCALE_DOWN_MIN_PCT   - Minimum bet scale at max positions (default: 0.25 = 25% of normal)
 *   MAX_DRAWDOWN_PCT     - Stop trading if session drawdown exceeds this (default: 15-30%)
 *   MAX_DAILY_LOSS_USD   - Stop trading if daily loss exceeds this (default: $50-200)
 *   ORDER_COOLDOWN_MS    - Min time between orders (default: 500-2000ms)
 *   MAX_ORDERS_PER_HOUR  - Rate limit orders per hour (default: 100-500)
 *
 * LIVE TRADING:
 *   LIVE_TRADING=I_UNDERSTAND_THE_RISKS  (or ARB_LIVE_TRADING)
 *
 * OPTIONAL:
 *   INTERVAL_MS or FETCH_INTERVAL - Cycle interval (default: 5000ms)
 *   TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID - Alerts (or TELEGRAM_TOKEN/TELEGRAM_CHAT)
 *   VPN_BYPASS_RPC       - Route RPC outside VPN (default: true)
 *   REDEEM_INTERVAL_MIN  - How often to check for redeemable positions (default: 10-15 min)
 *
 * See README.md for full ENV reference with V1 compatibility aliases.
 */

import { JsonRpcProvider, Wallet, Contract, Interface, ZeroHash } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import axios from "axios";
import {
  postOrder,
  type OrderSide,
  type OrderOutcome,
  ABSOLUTE_MIN_TRADEABLE_PRICE,
} from "../utils/post-order.util";
import { createPolymarketAuthFromEnv } from "../clob/polymarket-auth";

// V1 Features: Adaptive Learning, On-Chain Exit, On-Chain Trading
import {
  getAdaptiveLearner,
  type AdaptiveTradeLearner,
} from "../arbitrage/learning/adaptive-learner";
import { executeOnChainOrder } from "../trading/onchain-executor";

// V2 Features: Profitability Optimizer
import { 
  ProfitabilityOptimizer, 
  createProfitabilityOptimizer,
  type AnalyzablePosition,
  type OptimizationResult,
  type ProfitabilityOptimizerConfig,
} from "./profitability-optimizer";

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
  entryTime?: number; // When position was first seen
  lastPrice?: number; // Previous price for spike detection
  priceHistory?: number[]; // Recent prices for momentum
  marketEndTime?: number; // Market close time (Unix timestamp ms) - for near-close hedging
}

interface Config {
  autoSell: {
    enabled: boolean;
    threshold: number;
    minHoldSec: number;
    // V1 features
    disputeWindowExitEnabled: boolean; // Exit positions stuck in dispute window
    disputeWindowExitPrice: number; // Price for dispute exit (default: 0.999)
    stalePositionHours: number; // Sell profitable positions held too long (0 = disabled)
    quickWinEnabled: boolean; // Quick win exit for big fast gains
    quickWinMaxHoldMinutes: number; // Max hold time for quick win
    quickWinProfitPct: number; // Profit % threshold for quick win
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
    minHedgeUsd: number; // Minimum hedge size (skip smaller)
    maxEntryPrice: number; // Only hedge positions with entry below this
    forceLiquidationPct: number; // Force liquidation instead of hedge at this loss
    emergencyLossPct: number; // Emergency protection threshold
    minHoldSeconds: number; // Min hold before hedging (avoid bid-ask spread issues)
    // Near-close hedging rules
    nearCloseWindowMinutes: number; // Minutes before market close to apply stricter rules
    nearCloseLossPct: number; // Stricter loss threshold near close
    noHedgeWindowMinutes: number; // Don't hedge in final N minutes
    // Hedge-up feature (buy more when winning near resolution)
    hedgeUpEnabled: boolean; // Buy more shares when price is high near close
    hedgeUpPriceThreshold: number; // Min price to trigger hedge-up (e.g., 0.85)
    hedgeUpMaxPrice: number; // Max price for hedge-up (e.g., 0.95)
    hedgeUpMaxUsd: number; // Max USD per hedge-up buy
    // Hedge exit
    hedgeExitThreshold: number; // P&L % to exit hedge pair
  };
  scalp: {
    enabled: boolean;
    minProfitPct: number;
    minGainCents: number;
    lowPriceThreshold: number;
    minProfitUsd: number;
    // V1 scalp features
    suddenSpikeEnabled: boolean; // Detect sudden price spikes
    suddenSpikeThresholdPct: number; // Spike threshold %
    suddenSpikeWindowMinutes: number; // Window for spike detection
    resolutionExclusionPrice: number; // Don't scalp near-resolution positions
    // Hold time requirements
    minHoldMinutes: number; // Min hold before considering scalp
    maxHoldMinutes: number; // Force exit after this time (if profitable)
  };
  stack: {
    enabled: boolean;
    minGainCents: number;
    maxUsd: number;
    maxPrice: number;
  };
  endgame: {
    enabled: boolean;
    minPrice: number;
    maxPrice: number;
    maxUsd: number;
  };
  redeem: { enabled: boolean; intervalMin: number; minPositionUsd: number };
  copy: {
    enabled: boolean;
    addresses: string[];
    multiplier: number;
    minUsd: number;
    maxUsd: number;
    minBuyPrice: number;
  };
  arbitrage: {
    enabled: boolean;
    maxUsd: number;
    minEdgeBps: number;
    minBuyPrice: number;
  };
  sellSignal: {
    enabled: boolean;
    minLossPctToAct: number;
    profitThresholdToSkip: number;
    severeLossPct: number;
    cooldownMs: number;
  };
  // Risk management
  risk: {
    maxDrawdownPct: number; // Max session drawdown before stopping
    maxDailyLossUsd: number; // Max daily loss before stopping
    maxOpenPositions: number; // Max concurrent positions (⚠️ more = more API calls)
    orderCooldownMs: number; // Min time between orders
    maxOrdersPerHour: number; // Rate limit
    // Bet scaling when approaching position cap
    scaleDownThreshold: number; // Start scaling when positions >= this % of max (default: 70%)
    scaleDownMinPct: number; // Minimum scale factor (default: 25% = 0.25x base size)
    // Hedge buffer - ALWAYS reserve slots for protective hedges
    hedgeBuffer: number; // Reserve this many position slots for hedges (default: 500)
  };
  maxPositionUsd: number;
  reservePct: number;
  // V1 Features
  adaptiveLearning: { enabled: boolean }; // Learn from trade outcomes, avoid bad markets
  onChainExit: { enabled: boolean; priceThreshold: number }; // Exit NOT_TRADABLE positions on-chain
  tradeMode: "clob" | "onchain"; // Trade via CLOB API or direct on-chain
  // POL Reserve - auto-swap USDC to POL to maintain minimum POL balance for gas
  polReserve: {
    enabled: boolean; // Enable automatic POL rebalancing
    targetPol: number; // Target POL balance (default: 50)
    minPol: number; // Minimum POL before triggering rebalance (default: 10)
    maxSwapUsd: number; // Max USDC to swap per rebalance (default: 100)
    checkIntervalMin: number; // How often to check POL balance (default: 5 minutes)
    slippagePct: number; // Slippage tolerance for swap (default: 1%)
  };
  // Dynamic Reserves - Risk-aware capital allocation (V1 DynamicReservesController feature)
  dynamicReserves: {
    enabled: boolean; // Enable risk-aware reserve scaling
    baseReserveFloorUsd: number; // Minimum reserve floor in USD
    baseReserveEquityPct: number; // Reserve as % of equity (positions + cash)
    maxReserveUsd: number; // Cap on total reserve requirement
    hedgeCapUsd: number; // Max per-position reserve (aligns with hedge max)
    hedgeTriggerLossPct: number; // Loss % to trigger hedge-tier reserve
    catastrophicLossPct: number; // Loss % for catastrophic-tier reserve
    highWinProbPriceThreshold: number; // Price threshold for high win probability (low reserve)
  };
  // Profitability Optimizer - Risk-aware decision making for maximizing income
  profitabilityOptimizer: {
    enabled: boolean;                  // Enable profitability-guided trading decisions
    minExpectedValueUsd: number;       // Minimum EV to recommend an action
    riskTolerance: number;             // Risk tolerance factor (0-1)
    logRecommendations: boolean;       // Log optimizer recommendations for debugging
  };
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
      enabled: true,
      threshold: 0.999,
      minHoldSec: 60,
      disputeWindowExitEnabled: true,
      disputeWindowExitPrice: 0.999,
      stalePositionHours: 24,
      quickWinEnabled: false,
      quickWinMaxHoldMinutes: 60,
      quickWinProfitPct: 90,
    },
    stopLoss: { enabled: true, maxLossPct: 20, minHoldSec: 120 },
    hedge: {
      enabled: true,
      triggerPct: 20,
      maxUsd: 10,
      allowExceedMax: false,
      absoluteMaxUsd: 25,
      reservePct: 25,
      minHedgeUsd: 1,
      maxEntryPrice: 0.75,
      forceLiquidationPct: 50,
      emergencyLossPct: 30,
      minHoldSeconds: 120,
      nearCloseWindowMinutes: 30,
      nearCloseLossPct: 10,
      noHedgeWindowMinutes: 5,
      hedgeUpEnabled: false,
      hedgeUpPriceThreshold: 0.85,
      hedgeUpMaxPrice: 0.95,
      hedgeUpMaxUsd: 10,
      hedgeExitThreshold: 15,
    },
    scalp: {
      enabled: true,
      minProfitPct: 8,
      minGainCents: 8,
      lowPriceThreshold: 0,
      minProfitUsd: 2.0,
      suddenSpikeEnabled: true,
      suddenSpikeThresholdPct: 15,
      suddenSpikeWindowMinutes: 5,
      resolutionExclusionPrice: 0.9,
      minHoldMinutes: 45,
      maxHoldMinutes: 120,
    },
    stack: { enabled: true, minGainCents: 25, maxUsd: 15, maxPrice: 0.9 },
    endgame: { enabled: true, minPrice: 0.985, maxPrice: 0.995, maxUsd: 15 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0 },
    copy: {
      enabled: false,
      addresses: [],
      multiplier: 0.15,
      minUsd: 50,
      maxUsd: 50,
      minBuyPrice: 0.5,
    },
    arbitrage: {
      enabled: true,
      maxUsd: 15,
      minEdgeBps: 300,
      minBuyPrice: 0.05,
    },
    sellSignal: {
      enabled: true,
      minLossPctToAct: 15,
      profitThresholdToSkip: 20,
      severeLossPct: 40,
      cooldownMs: 60000,
    },
    risk: {
      maxDrawdownPct: 15,
      maxDailyLossUsd: 50,
      maxOpenPositions: 1000,
      orderCooldownMs: 2000,
      maxOrdersPerHour: 100,
      scaleDownThreshold: 0.7,
      scaleDownMinPct: 0.25,
      hedgeBuffer: 500,
    },
    maxPositionUsd: 15,
    reservePct: 25,
    adaptiveLearning: { enabled: false },
    onChainExit: { enabled: true, priceThreshold: 0.99 },
    tradeMode: "clob",
    polReserve: {
      enabled: true,
      targetPol: 50,
      minPol: 10,
      maxSwapUsd: 100,
      checkIntervalMin: 5,
      slippagePct: 1,
    },
    // Conservative: Higher reserves, lower risk tolerance
    dynamicReserves: {
      enabled: true,
      baseReserveFloorUsd: 25,
      baseReserveEquityPct: 0.08,
      maxReserveUsd: 250,
      hedgeCapUsd: 25,
      hedgeTriggerLossPct: 15,
      catastrophicLossPct: 40,
      highWinProbPriceThreshold: 0.9,
    },
    // Conservative: Lower risk tolerance for profitability optimizer
    profitabilityOptimizer: {
      enabled: true,
      minExpectedValueUsd: 1.0,
      riskTolerance: 0.3,
      logRecommendations: false,
    },
  },
  balanced: {
    autoSell: {
      enabled: true,
      threshold: 0.999,
      minHoldSec: 60,
      disputeWindowExitEnabled: true,
      disputeWindowExitPrice: 0.999,
      stalePositionHours: 24,
      quickWinEnabled: false,
      quickWinMaxHoldMinutes: 60,
      quickWinProfitPct: 90,
    },
    stopLoss: { enabled: true, maxLossPct: 25, minHoldSec: 60 },
    hedge: {
      enabled: true,
      triggerPct: 20,
      maxUsd: 15,
      allowExceedMax: false,
      absoluteMaxUsd: 50,
      reservePct: 20,
      minHedgeUsd: 1,
      maxEntryPrice: 0.8,
      forceLiquidationPct: 50,
      emergencyLossPct: 30,
      minHoldSeconds: 60,
      nearCloseWindowMinutes: 30,
      nearCloseLossPct: 15,
      noHedgeWindowMinutes: 5,
      hedgeUpEnabled: true,
      hedgeUpPriceThreshold: 0.85,
      hedgeUpMaxPrice: 0.95,
      hedgeUpMaxUsd: 15,
      hedgeExitThreshold: 10,
    },
    scalp: {
      enabled: true,
      minProfitPct: 5,
      minGainCents: 5,
      lowPriceThreshold: 0,
      minProfitUsd: 1.0,
      suddenSpikeEnabled: true,
      suddenSpikeThresholdPct: 12,
      suddenSpikeWindowMinutes: 5,
      resolutionExclusionPrice: 0.9,
      minHoldMinutes: 30,
      maxHoldMinutes: 90,
    },
    stack: { enabled: true, minGainCents: 20, maxUsd: 25, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.985, maxPrice: 0.995, maxUsd: 25 },
    redeem: { enabled: true, intervalMin: 15, minPositionUsd: 0 },
    copy: {
      enabled: false,
      addresses: [],
      multiplier: 0.15,
      minUsd: 1,
      maxUsd: 100,
      minBuyPrice: 0.5,
    },
    arbitrage: {
      enabled: true,
      maxUsd: 25,
      minEdgeBps: 200,
      minBuyPrice: 0.05,
    },
    sellSignal: {
      enabled: true,
      minLossPctToAct: 15,
      profitThresholdToSkip: 20,
      severeLossPct: 40,
      cooldownMs: 60000,
    },
    risk: {
      maxDrawdownPct: 20,
      maxDailyLossUsd: 100,
      maxOpenPositions: 1000,
      orderCooldownMs: 1000,
      maxOrdersPerHour: 200,
      scaleDownThreshold: 0.7,
      scaleDownMinPct: 0.25,
      hedgeBuffer: 500,
    },
    maxPositionUsd: 25,
    reservePct: 20,
    adaptiveLearning: { enabled: false },
    onChainExit: { enabled: true, priceThreshold: 0.99 },
    tradeMode: "clob",
    polReserve: {
      enabled: true,
      targetPol: 50,
      minPol: 10,
      maxSwapUsd: 100,
      checkIntervalMin: 5,
      slippagePct: 1,
    },
    // Balanced: Moderate reserves, balanced risk tolerance
    dynamicReserves: {
      enabled: true,
      baseReserveFloorUsd: 20,
      baseReserveEquityPct: 0.05,
      maxReserveUsd: 200,
      hedgeCapUsd: 50,
      hedgeTriggerLossPct: 20,
      catastrophicLossPct: 50,
      highWinProbPriceThreshold: 0.85,
    },
    // Balanced: Moderate risk tolerance for profitability optimizer
    profitabilityOptimizer: {
      enabled: true,
      minExpectedValueUsd: 0.5,
      riskTolerance: 0.5,
      logRecommendations: false,
    },
  },
  aggressive: {
    autoSell: {
      enabled: true,
      threshold: 0.999,
      minHoldSec: 30,
      disputeWindowExitEnabled: true,
      disputeWindowExitPrice: 0.999,
      stalePositionHours: 12,
      quickWinEnabled: true,
      quickWinMaxHoldMinutes: 30,
      quickWinProfitPct: 50,
    },
    stopLoss: { enabled: true, maxLossPct: 35, minHoldSec: 30 },
    hedge: {
      enabled: true,
      triggerPct: 20,
      maxUsd: 50,
      allowExceedMax: true,
      absoluteMaxUsd: 100,
      reservePct: 15,
      minHedgeUsd: 1,
      maxEntryPrice: 0.85,
      forceLiquidationPct: 50,
      emergencyLossPct: 25,
      minHoldSeconds: 30,
      nearCloseWindowMinutes: 15,
      nearCloseLossPct: 20,
      noHedgeWindowMinutes: 3,
      hedgeUpEnabled: true,
      hedgeUpPriceThreshold: 0.8,
      hedgeUpMaxPrice: 0.95,
      hedgeUpMaxUsd: 50,
      hedgeExitThreshold: 5,
    },
    scalp: {
      enabled: true,
      minProfitPct: 4,
      minGainCents: 3,
      lowPriceThreshold: 0,
      minProfitUsd: 0.5,
      suddenSpikeEnabled: true,
      suddenSpikeThresholdPct: 10,
      suddenSpikeWindowMinutes: 3,
      resolutionExclusionPrice: 0.95,
      minHoldMinutes: 15,
      maxHoldMinutes: 60,
    },
    stack: { enabled: true, minGainCents: 15, maxUsd: 100, maxPrice: 0.95 },
    endgame: { enabled: true, minPrice: 0.85, maxPrice: 0.94, maxUsd: 100 },
    redeem: { enabled: true, intervalMin: 10, minPositionUsd: 0 },
    copy: {
      enabled: false,
      addresses: [],
      multiplier: 0.15,
      minUsd: 5,
      maxUsd: 200,
      minBuyPrice: 0.5,
    },
    arbitrage: {
      enabled: true,
      maxUsd: 100,
      minEdgeBps: 200,
      minBuyPrice: 0.05,
    },
    sellSignal: {
      enabled: true,
      minLossPctToAct: 10,
      profitThresholdToSkip: 25,
      severeLossPct: 35,
      cooldownMs: 30000,
    },
    risk: {
      maxDrawdownPct: 30,
      maxDailyLossUsd: 200,
      maxOpenPositions: 1000,
      orderCooldownMs: 500,
      maxOrdersPerHour: 500,
      scaleDownThreshold: 0.7,
      scaleDownMinPct: 0.25,
      hedgeBuffer: 500,
    },
    maxPositionUsd: 100,
    reservePct: 15,
    adaptiveLearning: { enabled: false },
    onChainExit: { enabled: true, priceThreshold: 0.99 },
    tradeMode: "clob",
    polReserve: {
      enabled: true,
      targetPol: 50,
      minPol: 10,
      maxSwapUsd: 100,
      checkIntervalMin: 5,
      slippagePct: 1,
    },
    // Aggressive: Lower reserves, higher risk tolerance
    dynamicReserves: {
      enabled: true,
      baseReserveFloorUsd: 15,
      baseReserveEquityPct: 0.03,
      maxReserveUsd: 150,
      hedgeCapUsd: 100,
      hedgeTriggerLossPct: 25,
      catastrophicLossPct: 60,
      highWinProbPriceThreshold: 0.8,
    },
    // Aggressive: Higher risk tolerance for profitability optimizer
    profitabilityOptimizer: {
      enabled: true,
      minExpectedValueUsd: 0.25,
      riskTolerance: 0.7,
      logRecommendations: false,
    },
  },
};

// ============ CONSTANTS ============

const API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC_ADDRESS = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"; // Wrapped POL (WMATIC) on Polygon
const QUICKSWAP_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"; // QuickSwap Router V2
const INDEX_SETS: number[] = [1, 2];
const PROXY_ABI = [
  "function proxy(address dest, bytes calldata data) external returns (bytes memory)",
];
const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external",
];

// Uniswap V2 Router ABI (QuickSwap uses the same interface)
const ROUTER_ABI = [
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];
const ASSUMED_MARKET_DURATION_HOURS = 24; // Used for hold-time fallback when market end time is unavailable

// Cache TTL configuration
const MARKET_END_TIME_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes for successful lookups
const MARKET_END_TIME_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for failed lookups
const MARKET_END_TIME_CACHE_MAX_SIZE = 500;
const ZERO_PRICE_BLOCK_TTL_MS = 60 * 60 * 1000; // 1 hour - how long to block sell retries for zero-price tokens

// Arbitrage configuration
const DEFAULT_ARBITRAGE_ACTIVE_MARKET_LIMIT = 100; // Matches V1 endgame-sweep

// ============ STATE ============

const state = {
  positions: [] as Position[],
  lastFetch: 0,
  lastRedeem: 0,
  lastBalanceCheck: 0,
  lastPolCheck: 0, // Last time we checked/rebalanced POL
  lastOrderTime: 0,
  lastReserveLog: 0, // Last time we logged reserve status
  balance: 0,
  polBalance: 0, // POL balance in wallet
  sessionStartBalance: 0,
  dailyStartBalance: 0,
  dailyStartTime: 0,
  ordersThisHour: 0,
  hourStartTime: 0,
  stacked: new Set<string>(),
  hedged: new Set<string>(),
  sold: new Set<string>(),
  copied: new Set<string>(),
  zeroPriceTokens: new Map<string, number>(), // tokenId -> timestamp when marked (TTL: ZERO_PRICE_BLOCK_TTL_MS)
  sellSignalCooldown: new Map<string, number>(),
  positionEntryTime: new Map<string, number>(),
  positionPriceHistory: new Map<string, { price: number; time: number }[]>(), // For momentum tracking
  positionMomentum: new Map<string, number>(), // tokenId -> momentum score (-1 to +1)
  // Market end time cache with TTL support
  // Value: { endTime: number (-1 = not available), cachedAt: number (timestamp) }
  marketEndTimeCache: new Map<string, { endTime: number; cachedAt: number }>(),
  telegram: undefined as
    | { token: string; chatId: string; silent: boolean }
    | undefined,
  proxyAddress: undefined as string | undefined,
  copyLastCheck: new Map<string, number>(),
  clobClient: undefined as (ClobClient & { wallet: Wallet }) | undefined,
  wallet: undefined as Wallet | undefined,
  provider: undefined as JsonRpcProvider | undefined,
  liveTrading: false,
  authOk: false,
  riskHalted: false,
  vpnActive: false, // Track VPN status
  // V1 Features
  adaptiveLearner: undefined as AdaptiveTradeLearner | undefined,
  pendingTrades: new Map<
    string,
    {
      marketId: string;
      tradeId: string;
      entryPrice: number;
      sizeUsd: number;
      timestamp: number;
    }
  >(), // For adaptive learning
  // Initial investment tracking for overall P&L
  initialInvestment: undefined as number | undefined,
  // V2 Features
  profitabilityOptimizer: undefined as ProfitabilityOptimizer | undefined,
  lastProfitOptLog: 0, // Last time we logged profitability optimizer recommendations
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
function recordTrade(
  side: "BUY" | "SELL",
  outcome: string,
  strategy: string,
  sizeUsd: number,
  price: number,
  success: boolean,
) {
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

  // Calculate total value (balance + holdings)
  const holdingsValue = state.positions.reduce((sum, p) => sum + p.value, 0);
  const totalValue = state.balance + holdingsValue;

  const lines = [
    `📊 <b>Session Summary</b>`,
    `Trades: ${totalTrades} (${ledger.buyCount} buys, ${ledger.sellCount} sells)`,
    `Bought: ${$(ledger.totalBuys)}`,
    `Sold: ${$(ledger.totalSells)}`,
    `Net Flow: ${$(netFlow)}`,
    `Balance: ${$(state.balance)} (${balanceChange >= 0 ? "+" : ""}${$(balanceChange)})`,
    `Holdings: ${$(holdingsValue)} (${state.positions.length} positions)`,
    `Total Value: ${$(totalValue)}`,
  ];

  // Add overall P&L if INITIAL_INVESTMENT_USD is set
  if (state.initialInvestment !== undefined && state.initialInvestment > 0) {
    const overallGainLoss = totalValue - state.initialInvestment;
    const overallReturnPct = (overallGainLoss / state.initialInvestment) * 100;
    const sign = overallGainLoss >= 0 ? "+" : "";
    lines.push(
      `📈 <b>Overall P&amp;L</b>: ${sign}${$(overallGainLoss)} (${sign}${overallReturnPct.toFixed(1)}%)`,
    );
  }

  return lines.join("\n");
}

/** Send periodic summary if enough time has passed */
async function maybeSendSummary() {
  if (Date.now() - ledger.lastSummary < ledger.summaryIntervalMs) return;

  // Always send summaries if user has positions, any balance, or completed trades
  // This gives users a "portfolio status" update even when balance is depleted
  const hasPositions = state.positions.length > 0;
  const hasAnyBalance = state.balance >= 0 && state.sessionStartBalance > 0;
  const hasTrades = ledger.buyCount + ledger.sellCount > 0;

  if (!hasPositions && !hasAnyBalance && !hasTrades) {
    return; // Nothing to report
  }

  ledger.lastSummary = Date.now();
  const summary = getLedgerSummary();
  log(summary.replace(/<[^>]*>/g, "")); // Log without HTML tags

  if (state.telegram) {
    await axios
      .post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
        chat_id: state.telegram.chatId,
        text: summary,
        parse_mode: "HTML",
        disable_notification: state.telegram.silent,
      })
      .catch((e) => log(`⚠️ Telegram summary error: ${e.message}`));
  }
}

// ============ RISK MANAGEMENT ============

/**
 * Check if we can place an order based on risk limits
 * Returns { allowed: boolean, reason?: string }
 */
function checkRiskLimits(
  cfg: Config,
  skipPositionCap = false,
): { allowed: boolean; reason?: string } {
  if (state.riskHalted) {
    return { allowed: false, reason: "Risk halted - limits exceeded" };
  }

  // Check session drawdown
  if (state.sessionStartBalance > 0) {
    const drawdownPct =
      ((state.sessionStartBalance - state.balance) /
        state.sessionStartBalance) *
      100;
    if (drawdownPct >= cfg.risk.maxDrawdownPct) {
      state.riskHalted = true;
      return {
        allowed: false,
        reason: `Max drawdown ${drawdownPct.toFixed(1)}% >= ${cfg.risk.maxDrawdownPct}%`,
      };
    }
  }

  // Check daily loss
  const now = Date.now();
  if (
    state.dailyStartTime === 0 ||
    now - state.dailyStartTime > 24 * 60 * 60 * 1000
  ) {
    // Reset daily tracking
    state.dailyStartBalance = state.balance;
    state.dailyStartTime = now;
  }
  const dailyLoss = state.dailyStartBalance - state.balance;
  if (dailyLoss >= cfg.risk.maxDailyLossUsd) {
    state.riskHalted = true;
    return {
      allowed: false,
      reason: `Daily loss ${$(dailyLoss)} >= ${$(cfg.risk.maxDailyLossUsd)}`,
    };
  }

  // Check order rate limit
  if (state.hourStartTime === 0 || now - state.hourStartTime > 60 * 60 * 1000) {
    state.ordersThisHour = 0;
    state.hourStartTime = now;
  }
  if (state.ordersThisHour >= cfg.risk.maxOrdersPerHour) {
    return {
      allowed: false,
      reason: `Rate limit: ${state.ordersThisHour} orders this hour`,
    };
  }

  // Check order cooldown
  if (now - state.lastOrderTime < cfg.risk.orderCooldownMs) {
    return {
      allowed: false,
      reason: `Cooldown: ${cfg.risk.orderCooldownMs - (now - state.lastOrderTime)}ms remaining`,
    };
  }

  // Check max open positions (leave buffer for hedges)
  // Normal trades blocked when positions >= (max - hedgeBuffer)
  // Hedges can still execute up to the absolute max
  // SELL orders skip this check since they reduce positions, not increase them
  if (!skipPositionCap) {
    const effectiveMax = cfg.risk.maxOpenPositions - cfg.risk.hedgeBuffer;
    if (state.positions.length >= effectiveMax) {
      return {
        allowed: false,
        reason: `Position cap: ${state.positions.length} >= ${effectiveMax} (${cfg.risk.hedgeBuffer} slots reserved for hedges)`,
      };
    }
  }

  return { allowed: true };
}

/** Record that an order was placed (for rate limiting) */
function recordOrderPlaced() {
  state.lastOrderTime = Date.now();
  state.ordersThisHour++;
}

/**
 * Calculate bet scale factor based on current position count
 *
 * As positions approach the cap, scale down bet sizes to:
 * 1. Reduce API calls (smaller bets = less risk of rejection)
 * 2. Conserve capital for protective trades
 * 3. Prevent over-concentration
 *
 * ⚠️ HEDGE BUFFER: Normal trades use effectiveMax = maxOpenPositions - hedgeBuffer
 * This reserves slots for protective hedges even when scaling kicks in.
 *
 * Example with maxOpenPositions=20, hedgeBuffer=3, scaleDownThreshold=0.7, scaleDownMinPct=0.25:
 * - effectiveMax = 17 (20 - 3 hedge slots)
 * - 12 positions (70% of 17) → scale = 1.0 (full size)
 * - 15 positions (88% of 17) → scale = 0.5 (interpolated)
 * - 17 positions (100% of 17) → scale = 0.25 (minimum), normal trades blocked
 * - 18-20 positions → ONLY hedges allowed (using reserved buffer)
 */
function getBetScaleFactor(cfg: Config): number {
  const currentCount = state.positions.length;
  // Use effective max (minus hedge buffer) for scaling calculation
  const effectiveMax = cfg.risk.maxOpenPositions - cfg.risk.hedgeBuffer;
  const thresholdPct = cfg.risk.scaleDownThreshold;
  const minScale = cfg.risk.scaleDownMinPct;

  const currentPct = currentCount / effectiveMax;

  // Below threshold: full size
  if (currentPct <= thresholdPct) {
    return 1.0;
  }

  // At or above effective max: minimum size
  if (currentPct >= 1.0) {
    return minScale;
  }

  // Interpolate between threshold and effective max
  // Linear interpolation: scale decreases from 1.0 to minScale as position count goes from threshold to max
  const rangeAboveThreshold = 1.0 - thresholdPct;
  const pctIntoRange = (currentPct - thresholdPct) / rangeAboveThreshold;
  const scale = 1.0 - (1.0 - minScale) * pctIntoRange;

  return Math.max(minScale, scale);
}

/**
 * Apply bet scaling to a USD amount
 * Logs when scaling is applied for transparency
 */
function scaleBetSize(baseUsd: number, cfg: Config, reason: string): number {
  const scaleFactor = getBetScaleFactor(cfg);
  const effectiveMax = cfg.risk.maxOpenPositions - cfg.risk.hedgeBuffer;

  if (scaleFactor < 1.0) {
    const scaledUsd = baseUsd * scaleFactor;
    log(
      `📉 Bet scaled | ${reason} | ${$(baseUsd)} → ${$(scaledUsd)} (${(scaleFactor * 100).toFixed(0)}% @ ${state.positions.length}/${effectiveMax} positions, ${cfg.risk.hedgeBuffer} hedge slots reserved)`,
    );
    return Math.max(1, scaledUsd); // Minimum $1
  }

  return baseUsd;
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
function updateMomentum(
  tokenId: string,
  history: { price: number; time: number }[],
) {
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
  const momentum = Math.max(
    -1,
    Math.min(1, consistency * 0.7 + magnitude * 10 * 0.3),
  );
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
  const recentPrices = history.slice(-3).map((h) => h.price);
  const olderPrices = history.slice(-6, -3).map((h) => h.price);

  if (olderPrices.length < 3) return false;

  const recentAvg =
    recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
  const olderAvg = olderPrices.reduce((a, b) => a + b, 0) / olderPrices.length;

  // Momentum is fading if we were rising but now flat or falling
  return olderAvg < recentAvg && recentPrices[2] <= recentPrices[1];
}

/** Detect sudden price spike within time window */
function detectPriceSpike(
  tokenId: string,
  currentPrice: number,
  thresholdPct: number,
  windowMinutes?: number,
): boolean {
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

  const changePct =
    ((currentPrice - oldestInWindow.price) / oldestInWindow.price) * 100;
  return changePct >= thresholdPct;
}

/** Dynamic reserves based on drawdown (V1 feature) */
function getDynamicReservePct(cfg: Config): number {
  if (state.sessionStartBalance <= 0) return cfg.reservePct;

  const drawdownPct =
    ((state.sessionStartBalance - state.balance) / state.sessionStartBalance) *
    100;

  // Increase reserves as drawdown increases
  if (drawdownPct >= 20) return Math.min(50, cfg.reservePct + 25); // +25% reserves at 20% drawdown
  if (drawdownPct >= 10) return Math.min(40, cfg.reservePct + 15); // +15% reserves at 10% drawdown
  if (drawdownPct >= 5) return Math.min(35, cfg.reservePct + 5); // +5% reserves at 5% drawdown

  return cfg.reservePct;
}

/**
 * Risk-aware position reserve tier classification
 * Based on V1 DynamicReservesController logic
 */
type ReserveTier =
  | "NONE"
  | "HIGH_WIN_PROB"
  | "NORMAL"
  | "HEDGE"
  | "CATASTROPHIC";

interface PositionRiskReserve {
  tokenId: string;
  tier: ReserveTier;
  reserveUsd: number;
  reason: string;
}

/**
 * Compute risk-aware reserve requirement for a single position
 * This mirrors V1's DynamicReservesController per-position reserve logic
 */
function computePositionRiskReserve(
  pos: Position,
  cfg: Config,
): PositionRiskReserve {
  const dr = cfg.dynamicReserves;
  const notionalUsd = pos.curPrice * pos.size;
  const lossPct = Math.abs(Math.min(0, pos.pnlPct)); // Only count losses

  // Near-resolution positions need no reserve (high probability of payout)
  // curPrice >= 0.99 (99¢) is considered near-resolution
  if (pos.curPrice >= 0.99) {
    return {
      tokenId: pos.tokenId,
      tier: "NONE",
      reserveUsd: 0,
      reason: "NEAR_RESOLUTION",
    };
  }

  // HIGH WIN PROBABILITY: When current price is high (e.g., ≥85¢), minimal reserves needed
  // This takes precedence over loss tiers because high current price = high probability of winning
  if (pos.curPrice >= dr.highWinProbPriceThreshold) {
    const reserve = Math.min(0.5, notionalUsd * 0.02); // 2% of notional, capped at $0.50
    return {
      tokenId: pos.tokenId,
      tier: "HIGH_WIN_PROB",
      reserveUsd: reserve,
      reason: `HIGH_WIN_PROB_${(pos.curPrice * 100).toFixed(0)}¢`,
    };
  }

  // CATASTROPHIC LOSS: Position down >= catastrophicLossPct (e.g., 50%)
  // Needs full hedge reserve to cover potential forced liquidation or emergency hedge
  if (lossPct >= dr.catastrophicLossPct) {
    const reserve = Math.min(dr.hedgeCapUsd, notionalUsd * 1.0); // 100% of notional, capped at hedgeCapUsd
    return {
      tokenId: pos.tokenId,
      tier: "CATASTROPHIC",
      reserveUsd: reserve,
      reason: `CATASTROPHIC_LOSS_${lossPct.toFixed(0)}%`,
    };
  }

  // HEDGE TRIGGER: Position down >= hedgeTriggerLossPct (e.g., 20%)
  // Needs half of notional reserved for hedge execution
  if (lossPct >= dr.hedgeTriggerLossPct) {
    const reserve = Math.min(dr.hedgeCapUsd, notionalUsd * 0.5); // 50% of notional, capped at hedgeCapUsd
    return {
      tokenId: pos.tokenId,
      tier: "HEDGE",
      reserveUsd: reserve,
      reason: `HEDGE_TIER_${lossPct.toFixed(0)}%`,
    };
  }

  // NORMAL: Small buffer for general volatility protection
  const reserve = Math.min(2, notionalUsd * 0.1); // 10% of notional, capped at $2
  return {
    tokenId: pos.tokenId,
    tier: "NORMAL",
    reserveUsd: reserve,
    reason: "NORMAL_BUFFER",
  };
}

/**
 * Compute total risk-aware reserve requirement based on all positions
 * This is the main function that calculates reserves based on:
 * 1. Base reserve (floor or equity percentage)
 * 2. Per-position risk reserves (based on P&L tiers)
 * 3. Maximum cap on total reserves
 */
function computeRiskAwareReserve(cfg: Config): {
  totalReserveUsd: number;
  positionReserves: PositionRiskReserve[];
  baseReserveUsd: number;
} {
  const dr = cfg.dynamicReserves;

  if (!dr.enabled) {
    return { totalReserveUsd: 0, positionReserves: [], baseReserveUsd: 0 };
  }

  // Calculate equity (cash + position value)
  const positionValue = state.positions.reduce((sum, p) => sum + p.value, 0);
  const equityUsd = state.balance + positionValue;

  // A) Base reserve: max(floor, equityPct * equity)
  const baseReserveUsd = Math.max(
    dr.baseReserveFloorUsd,
    dr.baseReserveEquityPct * equityUsd,
  );

  // B) Per-position reserves based on P&L tier and risk
  const positionReserves = state.positions.map((pos) =>
    computePositionRiskReserve(pos, cfg),
  );
  const totalPositionReserve = positionReserves.reduce(
    (sum, pr) => sum + pr.reserveUsd,
    0,
  );

  // C) Total capped at maxReserveUsd
  const totalReserveUsd = Math.min(
    baseReserveUsd + totalPositionReserve,
    dr.maxReserveUsd,
  );

  return { totalReserveUsd, positionReserves, baseReserveUsd };
}

/** Get total position value for a token (for max position check) */
function getTotalPositionValue(tokenId: string): number {
  return state.positions
    .filter(
      (p) =>
        p.tokenId === tokenId ||
        p.conditionId ===
          state.positions.find((pos) => pos.tokenId === tokenId)?.conditionId,
    )
    .reduce((sum, p) => sum + p.value, 0);
}

/** Pre-execution order checks (V1 feature) */
async function preOrderCheck(
  tokenId: string,
  side: "BUY" | "SELL",
  sizeUsd: number,
  cfg: Config,
): Promise<{ ok: boolean; reason?: string }> {
  // Check global max position size for BUY orders
  if (side === "BUY") {
    const currentValue = getTotalPositionValue(tokenId);
    if (currentValue + sizeUsd > cfg.maxPositionUsd * 2) {
      // Allow up to 2x for hedges
      return {
        ok: false,
        reason: `Would exceed max position: ${$(currentValue + sizeUsd)} > ${$(cfg.maxPositionUsd * 2)}`,
      };
    }
  }

  // Check minimum order size
  if (sizeUsd < 1) {
    return { ok: false, reason: `Order too small: ${$(sizeUsd)} < $1.00` };
  }

  // For SELL, verify we have the position and price is tradeable
  if (side === "SELL") {
    const position = state.positions.find((p) => p.tokenId === tokenId);
    if (!position) {
      return { ok: false, reason: "No position to sell" };
    }
    if (sizeUsd > position.value * 1.1) {
      // Allow 10% buffer for price changes
      return {
        ok: false,
        reason: `Sell size ${$(sizeUsd)} exceeds position value ${$(position.value)}`,
      };
    }
    // Skip sell if current price is at or below minimum tradeable price
    // This prevents spammy ZERO_PRICE warnings in postOrder
    if (position.curPrice <= ABSOLUTE_MIN_TRADEABLE_PRICE) {
      return {
        ok: false,
        reason: `Price ${(position.curPrice * 100).toFixed(2)}¢ <= min ${(ABSOLUTE_MIN_TRADEABLE_PRICE * 100).toFixed(2)}¢`,
      };
    }
  }

  return { ok: true };
}

// ============ ADAPTIVE LEARNING HELPERS ============

/**
 * Evaluate trade with adaptive learner (V1 feature)
 * Returns adjusted size based on market confidence
 */
function evaluateTradeWithLearning(
  conditionId: string,
  sizeUsd: number,
  spreadBps: number,
  cfg: Config,
): { shouldTrade: boolean; adjustedSize: number; reason?: string } {
  if (!cfg.adaptiveLearning.enabled || !state.adaptiveLearner) {
    return { shouldTrade: true, adjustedSize: sizeUsd };
  }

  const evaluation = state.adaptiveLearner.evaluateTrade({
    marketId: conditionId,
    edgeBps: 100, // Default edge estimate
    spreadBps,
    sizeUsd,
  });

  if (!evaluation.shouldTrade) {
    return {
      shouldTrade: false,
      adjustedSize: 0,
      reason: evaluation.reasons.join(", "),
    };
  }

  // Apply size adjustment from learner
  const adjustedSize = sizeUsd * evaluation.adjustments.sizeMultiplier;
  return { shouldTrade: true, adjustedSize: Math.max(1, adjustedSize) };
}

/**
 * Record trade outcome for adaptive learning
 * Stores tradeId so we can update outcome when position closes
 */
function recordTradeForLearning(
  conditionId: string,
  entryPrice: number,
  sizeUsd: number,
  spreadBps = 50,
) {
  if (!state.adaptiveLearner) return;

  const timestamp = Date.now();
  const tradeId = state.adaptiveLearner.recordTrade({
    marketId: conditionId,
    timestamp,
    entryPrice,
    sizeUsd,
    edgeBps: 100,
    spreadBps,
    outcome: "pending",
  });

  state.pendingTrades.set(conditionId, {
    marketId: conditionId,
    tradeId,
    entryPrice,
    sizeUsd,
    timestamp,
  });
}

// ============ PROFITABILITY OPTIMIZER HELPERS ============

/**
 * Convert internal Position to AnalyzablePosition for the profitability optimizer
 */
function toAnalyzablePosition(p: Position): AnalyzablePosition {
  return {
    tokenId: p.tokenId,
    marketId: p.conditionId,
    outcome: p.outcome.toUpperCase() === "YES" ? "YES" : "NO",
    size: p.size,
    avgPrice: p.avgPrice,
    curPrice: p.curPrice,
    pnlPct: p.pnlPct,
    value: p.value,
    minutesToClose: p.marketEndTime ? Math.max(0, (p.marketEndTime - Date.now()) / 60000) : undefined,
    spreadBps: 50, // Assume default spread if not available
  };
}

/**
 * Run profitability optimizer analysis and log recommendations
 * 
 * The optimizer analyzes all positions and suggests the most profitable actions:
 * - STACK: Double down on winning positions with momentum
 * - HEDGE_DOWN: Protect against losses by buying the opposite outcome
 * - HEDGE_UP: Maximize gains on high-probability positions
 * - SELL: Lock in value when opportunity cost is favorable
 * 
 * Returns top recommendations sorted by expected value
 */
function analyzePortfolioProfitability(cfg: Config): OptimizationResult[] {
  if (!cfg.profitabilityOptimizer.enabled || !state.profitabilityOptimizer) {
    return [];
  }

  const portfolioValue = state.balance + state.positions.reduce((sum, p) => sum + p.value, 0);
  const availableCash = getAvailableBalance(cfg);
  
  // Convert positions to analyzable format
  const analyzablePositions = state.positions.map(toAnalyzablePosition);
  
  // Get optimizer recommendations
  const recommendations = state.profitabilityOptimizer.findBestActions(
    analyzablePositions,
    [], // No new opportunities in cycle mode (those come from copy trading)
    availableCash,
    portfolioValue,
  );
  
  // Filter by minimum EV threshold
  const minEv = cfg.profitabilityOptimizer.minExpectedValueUsd;
  const actionableRecs = recommendations.filter(
    r => r.rankedActions[0]?.expectedValueUsd >= minEv
  );
  
  // Log recommendations if enabled and interval has passed
  const LOG_INTERVAL_MS = 60_000; // Log every 60 seconds
  if (cfg.profitabilityOptimizer.logRecommendations && 
      Date.now() - state.lastProfitOptLog >= LOG_INTERVAL_MS &&
      actionableRecs.length > 0) {
    state.lastProfitOptLog = Date.now();
    
    log(`📊 [ProfitOptimizer] Top ${Math.min(3, actionableRecs.length)} recommendations:`);
    for (const rec of actionableRecs.slice(0, 3)) {
      const action = rec.rankedActions[0];
      log(`   ${action.action}: EV=${$(action.expectedValueUsd)} | ${rec.summary.slice(0, 80)}`);
    }
  }
  
  return actionableRecs;
}

// ============ LOGGING ============

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ============ ALERTS (Rich Telegram - V1 feature) ============

/**
 * Send clean alerts for Telegram
 * Format: ACTION | RESULT | DETAILS
 * Uses HTML parse mode for reliable message delivery
 */
async function alert(action: string, details: string, success = true) {
  const icon = success ? "✅" : "❌";
  const line = `${escapeHtml(action)} ${icon} | ${escapeHtml(details)}`;
  log(`📢 ${action} ${icon} | ${details}`);
  if (state.telegram) {
    await axios
      .post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
        chat_id: state.telegram.chatId,
        text: line,
        parse_mode: "HTML",
        disable_notification: state.telegram.silent,
      })
      .catch((e) => log(`⚠️ Telegram error: ${e.message}`));
  }
}

/**
 * Rich trade alert with full context (V1 feature)
 * Uses HTML parse mode for reliable message delivery
 */
async function alertTrade(
  side: "BUY" | "SELL",
  strategy: string,
  outcome: string,
  sizeUsd: number,
  price?: number,
  success = true,
  errorMsg?: string,
) {
  const icon = success ? "✅" : "❌";
  const priceStr = price ? ` @ ${(price * 100).toFixed(1)}¢` : "";
  const balanceStr = state.balance > 0 ? ` | Bal: ${$(state.balance)}` : "";
  const pnlStr =
    state.sessionStartBalance > 0
      ? ` | P&amp;L: ${$(state.balance - state.sessionStartBalance)}`
      : "";

  let msg: string;
  const escapedStrategy = escapeHtml(strategy);
  const escapedOutcome = escapeHtml(outcome);
  if (success) {
    msg = `${side} ${icon} | <b>${escapedStrategy}</b>\n${escapedOutcome} ${$(sizeUsd)}${priceStr}${balanceStr}${pnlStr}`;
  } else {
    msg = `${side} ${icon} | <b>${escapedStrategy}</b>\n${escapedOutcome} ${$(sizeUsd)} | ${escapeHtml(errorMsg || "Failed")}`;
  }

  log(`📢 ${side} ${icon} | ${strategy} | ${outcome} ${$(sizeUsd)}${priceStr}${balanceStr}${pnlStr.replace("&amp;", "&")}`);

  if (state.telegram) {
    await axios
      .post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
        chat_id: state.telegram.chatId,
        text: msg,
        parse_mode: "HTML",
        disable_notification: state.telegram.silent,
      })
      .catch((e) => log(`⚠️ Telegram error: ${e.message}`));
  }
}

/** Send startup/shutdown alerts with rich context */
async function alertStatus(msg: string) {
  log(`📢 ${msg}`);
  if (state.telegram) {
    await axios
      .post(`https://api.telegram.org/bot${state.telegram.token}/sendMessage`, {
        chat_id: state.telegram.chatId,
        text: `🤖 ${escapeHtml(msg)}`,
        parse_mode: "HTML",
        disable_notification: state.telegram.silent,
      })
      .catch((e) => log(`⚠️ Telegram error: ${e.message}`));
  }
}

// ============ FORMATTING ============

/**
 * Escape HTML entities for Telegram message (HTML parse mode)
 * Required to prevent message parsing failures when content contains <, >, or &
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
  if (Date.now() - state.lastFetch < 30000 && state.positions.length)
    return state.positions;

  try {
    const { data } = await axios.get(`${API}/positions?user=${wallet}`);
    const rawPositions = (data || [])
      .filter((p: any) => Number(p.size) > 0 && !p.redeemable)
      .map((p: any) => {
        const size = Number(p.size),
          avgPrice = Number(p.avgPrice),
          curPrice = Number(p.curPrice);
        const cost = size * avgPrice,
          value = size * curPrice;
        return {
          tokenId: p.asset,
          conditionId: p.conditionId,
          outcome: p.outcome || "YES",
          size,
          avgPrice,
          curPrice,
          value,
          pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
          gainCents: (curPrice - avgPrice) * 100,
        };
      });

    // Fetch market end times in batches to avoid overwhelming the Gamma API
    // Cache helps on subsequent cycles, but first fetch or cache misses need rate limiting
    const BATCH_SIZE = 10;
    const positionsWithEndTime: Position[] = [];

    for (let i = 0; i < rawPositions.length; i += BATCH_SIZE) {
      const batch = rawPositions.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (p: Omit<Position, "marketEndTime">) => {
          const marketEndTime = await fetchMarketEndTime(p.tokenId);
          return { ...p, marketEndTime };
        }),
      );
      positionsWithEndTime.push(...batchResults);
    }

    state.positions = positionsWithEndTime;
    state.lastFetch = Date.now();
    log(`📊 ${state.positions.length} positions`);
  } catch (e) {
    log(`❌ API: ${e}`);
  }
  return state.positions;
}

interface RedeemablePosition {
  conditionId: string;
  value: number; // Position value in USD
}

async function fetchRedeemable(wallet: string): Promise<RedeemablePosition[]> {
  try {
    const { data } = await axios.get(
      `${API}/positions?user=${wallet}&redeemable=true`,
    );
    if (!data || !Array.isArray(data)) return [];

    // Group by conditionId and sum values (in case of multiple tokens per condition)
    const byCondition = new Map<string, number>();
    for (const p of data) {
      const cid = p.conditionId;
      if (!cid) continue;
      const size = Number(p.size) || 0;
      const priceSource = p.curPrice ?? p.currentPrice;
      const price = priceSource == null ? 0 : Number(priceSource) || 0;
      const value = size * price;
      byCondition.set(cid, (byCondition.get(cid) || 0) + value);
    }

    return Array.from(byCondition.entries()).map(([conditionId, value]) => ({
      conditionId,
      value,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch market end time from Gamma API
 * Returns Unix timestamp in milliseconds, or undefined if not available
 * Uses cache with TTL to avoid redundant API calls
 * Caches both successful and failed lookups (with different TTLs)
 */
async function fetchMarketEndTime(
  tokenId: string,
): Promise<number | undefined> {
  const now = Date.now();

  // Check cache first (with TTL validation)
  const cached = state.marketEndTimeCache.get(tokenId);
  if (cached !== undefined) {
    const isNegativeCache = cached.endTime === -1;
    const ttl = isNegativeCache
      ? MARKET_END_TIME_NEGATIVE_CACHE_TTL_MS
      : MARKET_END_TIME_CACHE_TTL_MS;

    // Return cached value if not expired
    if (now - cached.cachedAt < ttl) {
      return cached.endTime === -1 ? undefined : cached.endTime;
    }
    // Cache expired - remove and fetch fresh
    state.marketEndTimeCache.delete(tokenId);
  }

  // Helper to cache result with size limit enforcement
  const cacheResult = (endTime: number) => {
    if (state.marketEndTimeCache.size >= MARKET_END_TIME_CACHE_MAX_SIZE) {
      // Remove oldest entry (FIFO eviction)
      const firstKey = state.marketEndTimeCache.keys().next().value;
      if (firstKey) {
        state.marketEndTimeCache.delete(firstKey);
      }
    }
    state.marketEndTimeCache.set(tokenId, { endTime, cachedAt: now });
  };

  try {
    // Gamma API endpoint for token/market info
    const { data } = await axios.get(
      `${GAMMA_API}/markets?clob_token_ids=${tokenId}`,
      { timeout: 5000 },
    );

    const market = data?.[0];
    if (!market) {
      cacheResult(-1); // Cache negative result
      return undefined;
    }

    // Try to get end date from various fields
    const endDateStr = market.end_date_iso || market.endDate || market.end_date;
    if (!endDateStr) {
      cacheResult(-1); // Cache negative result
      return undefined;
    }

    // Parse the date string to Unix timestamp (milliseconds)
    const endTime = new Date(endDateStr).getTime();
    if (Number.isNaN(endTime) || !Number.isFinite(endTime) || endTime <= 0) {
      cacheResult(-1); // Cache negative result
      return undefined;
    }

    // Cache successful result
    cacheResult(endTime);
    return endTime;
  } catch {
    cacheResult(-1); // Cache negative result on error
    return undefined;
  }
}

async function fetchProxy(wallet: string): Promise<string | undefined> {
  try {
    const { data } = await axios.get(`${API}/profile?address=${wallet}`);
    return data?.proxyAddress?.toLowerCase();
  } catch {
    return undefined;
  }
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
        side:
          a.side?.toUpperCase() === "BUY"
            ? ("BUY" as const)
            : ("SELL" as const),
        price: Number(a.price) || 0,
        usdSize: Number(a.usdcSize) || Number(a.size) * Number(a.price) || 0,
        timestamp: Number(a.timestamp) || 0,
        txHash: a.transactionHash || `${a.asset}-${a.timestamp}`, // Use txHash for deduping
      }));
  } catch {
    return [];
  }
}

async function countBuys(wallet: string, tokenId: string): Promise<number> {
  try {
    const { data } = await axios.get(
      `${API}/trades?user=${wallet}&asset=${tokenId}&limit=20`,
    );
    return (data || []).filter((t: any) => t.side?.toUpperCase() === "BUY")
      .length;
  } catch {
    return 0;
  }
}

function invalidate() {
  state.lastFetch = 0;
}

// ============ BALANCE & RESERVES ============

const USDC_ABI = ["function balanceOf(address) view returns (uint256)"];

async function fetchBalance(): Promise<number> {
  // Cache balance for 30s
  if (Date.now() - state.lastBalanceCheck < 30000 && state.balance > 0)
    return state.balance;

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
 * Uses BOTH percentage-based reserves (drawdown scaling) AND risk-aware reserves (position analysis)
 * Takes the HIGHER of the two reserve requirements to ensure adequate protection
 */
function getAvailableBalance(cfg: Config): number {
  // 1. Percentage-based reserve (drawdown scaling)
  const dynamicReservePct = getDynamicReservePct(cfg);
  const pctBasedReserve = state.balance * (dynamicReservePct / 100);

  // 2. Risk-aware reserve (position analysis)
  const { totalReserveUsd } = computeRiskAwareReserve(cfg);

  // Use the higher of the two reserve requirements to ensure adequate protection
  const effectiveReserve = Math.max(pctBasedReserve, totalReserveUsd);

  return Math.max(0, state.balance - effectiveReserve);
}

/**
 * Get detailed reserve breakdown for logging/diagnostics
 */
function getReserveBreakdown(cfg: Config): {
  pctReserve: number;
  riskReserve: number;
  effectiveReserve: number;
  mode: "RISK_ON" | "RISK_OFF";
  topPositionRisks: PositionRiskReserve[];
} {
  const dynamicReservePct = getDynamicReservePct(cfg);
  const pctReserve = state.balance * (dynamicReservePct / 100);
  const { totalReserveUsd, positionReserves } = computeRiskAwareReserve(cfg);
  const effectiveReserve = Math.max(pctReserve, totalReserveUsd);
  const mode = state.balance >= effectiveReserve ? "RISK_ON" : "RISK_OFF";

  // Top 5 position risks by reserve amount
  const topPositionRisks = positionReserves
    .sort((a, b) => b.reserveUsd - a.reserveUsd)
    .slice(0, 5);

  return {
    pctReserve,
    riskReserve: totalReserveUsd,
    effectiveReserve,
    mode,
    topPositionRisks,
  };
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

// ============ POL RESERVE MANAGEMENT ============

/**
 * Fetch current POL balance
 */
async function fetchPolBalance(): Promise<number> {
  if (!state.provider || !state.wallet) return 0;

  try {
    const balance = await state.provider.getBalance(state.wallet.address);
    state.polBalance = Number(balance) / 1e18; // POL has 18 decimals
    return state.polBalance;
  } catch (e) {
    log(`⚠️ POL balance check failed: ${e}`);
    return state.polBalance || 0;
  }
}

/**
 * Get quote for USDC -> POL swap via QuickSwap
 * Returns the amount of POL we would receive for a given USDC amount
 */
async function getSwapQuote(
  usdcAmount: number,
): Promise<{ polAmount: number; path: string[] }> {
  if (!state.provider) throw new Error("No provider");

  const router = new Contract(QUICKSWAP_ROUTER, ROUTER_ABI, state.provider);
  const path = [USDC_ADDRESS, WMATIC_ADDRESS];
  const usdcAmountWei = BigInt(Math.floor(usdcAmount * 1e6)); // USDC has 6 decimals

  const amounts = await router.getAmountsOut(usdcAmountWei, path);
  const polAmount = Number(amounts[1]) / 1e18; // POL has 18 decimals

  return { polAmount, path };
}

/**
 * Execute USDC -> POL swap via QuickSwap
 * Uses swapExactTokensForETH to get native POL (not WMATIC)
 */
async function swapUsdcToPol(
  usdcAmount: number,
  minPolOut: number,
  cfg: Config,
): Promise<boolean> {
  if (!state.wallet || !state.provider) {
    log("❌ POL Swap | No wallet/provider");
    return false;
  }

  if (!state.liveTrading) {
    log(
      `🔸 POL Swap [SIM] | ${$(usdcAmount)} USDC → ~${minPolOut.toFixed(2)} POL`,
    );
    return true;
  }

  try {
    const usdcAmountWei = BigInt(Math.round(usdcAmount * 1e6));
    const minPolOutWei = BigInt(Math.round(minPolOut * 1e18));
    const path = [USDC_ADDRESS, WMATIC_ADDRESS];
    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minute deadline

    // First, approve USDC spending by the router
    const usdcContract = new Contract(
      USDC_ADDRESS,
      [
        "function approve(address spender, uint256 amount) returns (bool)",
        "function allowance(address owner, address spender) view returns (uint256)",
      ],
      state.wallet,
    );

    // Use max uint256 approval to avoid repeated approval transactions
    const MAX_UINT256 = (1n << 256n) - 1n;

    // Check current allowance
    const currentAllowance = await usdcContract.allowance(
      state.wallet.address,
      QUICKSWAP_ROUTER,
    );
    if (currentAllowance < usdcAmountWei) {
      log(`🔄 POL Swap | Approving USDC for QuickSwap...`);
      const approveTx = await usdcContract.approve(
        QUICKSWAP_ROUTER,
        MAX_UINT256,
      );
      await approveTx.wait();
      log(`✅ POL Swap | USDC approval confirmed`);
    }

    // Execute swap
    const router = new Contract(QUICKSWAP_ROUTER, ROUTER_ABI, state.wallet);
    log(
      `🔄 POL Swap | Swapping ${$(usdcAmount)} USDC → min ${minPolOut.toFixed(2)} POL...`,
    );

    const swapTx = await router.swapExactTokensForETH(
      usdcAmountWei,
      minPolOutWei,
      path,
      state.wallet.address,
      deadline,
    );

    const receipt = await swapTx.wait();
    log(`✅ POL Swap | Confirmed in tx ${receipt.hash.slice(0, 10)}...`);

    // Refresh balances (bypass cached USDC balance after swap)
    state.lastBalanceCheck = 0;
    await fetchBalance();
    await fetchPolBalance();

    await alertStatus(
      `💱 POL Rebalance | Swapped ${$(usdcAmount)} USDC → POL | New POL: ${state.polBalance.toFixed(2)}`,
    );
    return true;
  } catch (e: any) {
    log(`❌ POL Swap failed: ${e.message}`);
    return false;
  }
}

/**
 * Check POL balance and rebalance if below minimum
 * Called periodically from the main cycle
 */
async function checkAndRebalancePol(cfg: Config): Promise<void> {
  if (!cfg.polReserve.enabled) return;

  // Check interval (default: every 5 minutes)
  const checkIntervalMs = cfg.polReserve.checkIntervalMin * 60 * 1000;
  if (Date.now() - state.lastPolCheck < checkIntervalMs) return;

  state.lastPolCheck = Date.now();

  // Fetch current POL balance
  const polBalance = await fetchPolBalance();

  // If above minimum, no action needed
  if (polBalance >= cfg.polReserve.minPol) {
    return;
  }

  log(
    `⚠️ POL Low | Current: ${polBalance.toFixed(2)} POL | Target: ${cfg.polReserve.targetPol} POL`,
  );

  // Calculate how much POL we need
  const polNeeded = cfg.polReserve.targetPol - polBalance;

  // Get swap quote to determine USDC needed
  try {
    // POL price estimate for initial calculation (actual price comes from DEX quote)
    // POL typically trades between $0.30-$1.50 - we use a conservative estimate
    const POL_PRICE_ESTIMATE_USD = 1.5;
    const MIN_SWAP_USD = 5; // Minimum swap to avoid dust transactions
    const AVAILABLE_USDC_BUFFER = 0.9; // Use 90% of available USDC to leave buffer
    const MIN_POL_QUOTE_THRESHOLD = 0.5; // Require at least 50% of needed POL from quote
    const MIN_POL_RETRY_THRESHOLD = 0.3; // On retry, accept 30% of needed POL

    // Start with a reasonable estimate based on current POL price
    let usdcToSwap = Math.min(
      polNeeded * POL_PRICE_ESTIMATE_USD,
      cfg.polReserve.maxSwapUsd,
    );

    // Ensure we have enough USDC, respecting dynamic reserve percentage
    const dynamicReservePct = getDynamicReservePct(cfg);
    const availableUsdc =
      state.balance - (state.balance * dynamicReservePct) / 100;
    if (usdcToSwap > availableUsdc) {
      log(
        `⚠️ POL Rebalance | Insufficient USDC (need ~${$(usdcToSwap)}, have ${$(availableUsdc)} available)`,
      );
      // Try with available amount, leaving a small buffer
      usdcToSwap = Math.max(availableUsdc * AVAILABLE_USDC_BUFFER, 0);
    }

    if (usdcToSwap < MIN_SWAP_USD) {
      log(
        `⚠️ POL Rebalance | Swap amount too small (${$(usdcToSwap)}), skipping`,
      );
      return;
    }

    // Get actual quote from DEX
    let quote = await getSwapQuote(usdcToSwap);

    // Check if we'll get enough POL from this swap
    if (quote.polAmount < polNeeded * MIN_POL_QUOTE_THRESHOLD) {
      log(
        `⚠️ POL Rebalance | Quote too low: ${quote.polAmount.toFixed(2)} POL for ${$(usdcToSwap)}`,
      );
      // Increase swap amount and try again
      usdcToSwap = Math.min(
        usdcToSwap * 2,
        cfg.polReserve.maxSwapUsd,
        availableUsdc,
      );
      quote = await getSwapQuote(usdcToSwap);
      if (quote.polAmount < polNeeded * MIN_POL_RETRY_THRESHOLD) {
        log(`❌ POL Rebalance | Cannot get enough POL, skipping`);
        return;
      }
    }

    // Calculate minimum POL out with slippage protection
    const minPolOut = quote.polAmount * (1 - cfg.polReserve.slippagePct / 100);

    log(
      `💱 POL Rebalance | Swapping ${$(usdcToSwap)} USDC → ~${quote.polAmount.toFixed(2)} POL (min: ${minPolOut.toFixed(2)})`,
    );

    // Execute swap
    await swapUsdcToPol(usdcToSwap, minPolOut, cfg);
  } catch (e: any) {
    log(`❌ POL Rebalance failed: ${e.message}`);
  }
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
async function executeSell(
  tokenId: string,
  conditionId: string,
  outcome: string,
  sizeUsd: number,
  reason: string,
  cfg: Config,
  curPrice?: number,
): Promise<boolean> {
  const priceStr = curPrice ? ` @ ${$price(curPrice)}` : "";

  // Skip if token has zero price level (with TTL to allow periodic retry)
  // These positions can only be redeemed, not sold via CLOB
  const zeroPriceTime = state.zeroPriceTokens.get(tokenId);
  if (zeroPriceTime && Date.now() - zeroPriceTime < ZERO_PRICE_BLOCK_TTL_MS) {
    return false;
  }
  // TTL expired, remove from map and allow retry
  if (zeroPriceTime) {
    state.zeroPriceTokens.delete(tokenId);
  }
  
  // Risk check: SELL orders NEVER blocked by position cap (they reduce positions)
  // Protective exits (StopLoss/AutoSell/ForceLiq/DisputeExit) bypass ALL risk checks
  const riskCheck = checkRiskLimits(cfg, true); // skipPositionCap=true for SELL orders
  const protectiveExitTypes = ["StopLoss", "AutoSell", "ForceLiq", "DisputeExit"];
  const isProtectiveExit = protectiveExitTypes.some((type) => reason.includes(type));
  // Also ignore position cap failures for ALL SELL orders (defensive check)
  const isPositionCapFailure = riskCheck.reason?.includes("Position cap");
  if (!riskCheck.allowed && !isProtectiveExit && !isPositionCapFailure) {
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
    await alertTrade(
      "SELL",
      `${reason} [SIM]`,
      outcome,
      sizeUsd,
      curPrice,
      true,
    );
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, true);
    recordOrderPlaced();
    return true;
  }

  if (!state.wallet) {
    log(`❌ SELL | ${reason} | No wallet`);
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
    return false;
  }

  log(`💰 SELL | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);

  try {
    // On-chain mode: try direct wallet trade, fallback to CLOB if not implemented
    if (cfg.tradeMode === "onchain") {
      log(
        `⛓️ SELL [ONCHAIN] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`,
      );
      const result = await executeOnChainOrder({
        wallet: state.wallet,
        tokenId,
        outcome: outcome as OrderOutcome,
        side: "SELL" as OrderSide,
        sizeUsd,
        maxAcceptablePrice: curPrice ? curPrice * 0.95 : undefined, // 5% slippage
        logger: simpleLogger as any,
      });

      if (result.success) {
        await alertTrade("SELL", reason, outcome, sizeUsd, curPrice, true);
        recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, true);
        recordOrderPlaced();
        invalidate();
        return true;
      }

      // Handle NO_LIQUIDITY: No on-chain liquidity to sell into
      // Add to cooldown list to prevent repeated attempts for 1h, these can only be redeemed
      if (result.reason === "NO_LIQUIDITY") {
        state.zeroPriceTokens.set(tokenId, Date.now());
        log(
          `⚠️ SELL | ${reason} | No on-chain liquidity - skipping for 1h (redeem only) | ${outcome} ${$(sizeUsd)}`,
        );
        return false;
      }

      // Fallback to CLOB if on-chain not implemented yet
      if (result.reason === "NOT_IMPLEMENTED" && state.clobClient) {
        log(`⚠️ On-chain not ready, falling back to CLOB`);
        // Fall through to CLOB logic below
      } else {
        await alertTrade(
          "SELL",
          reason,
          outcome,
          sizeUsd,
          curPrice,
          false,
          result.reason,
        );
        recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
        return false;
      }
    }

    // CLOB mode: use API
    if (!state.clobClient) {
      log(`❌ SELL | ${reason} | No CLOB client`);
      recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
      return false;
    }

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

    // Handle ZERO_PRICE_LEVEL: Add to ignore list to prevent infinite retry
    // These positions can only be redeemed, not sold via CLOB
    if (result.reason === "ZERO_PRICE_LEVEL") {
      state.zeroPriceTokens.set(tokenId, Date.now());
      log(
        `⚠️ SELL | ${reason} | Zero price - skipping for 1h (redeem only) | ${outcome} ${$(sizeUsd)}`,
      );
      return false;
    }

    await alertTrade(
      "SELL",
      reason,
      outcome,
      sizeUsd,
      curPrice,
      false,
      result.reason,
    );
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
    return false;
  } catch (e: any) {
    await alertTrade(
      "SELL",
      reason,
      outcome,
      sizeUsd,
      curPrice,
      false,
      e.message?.slice(0, 30),
    );
    recordTrade("SELL", outcome, reason, sizeUsd, curPrice || 0, false);
    return false;
  }
}

/**
 * Execute a BUY order
 * Alert format: "BUY ✅ | {reason} | {outcome} {amount} @ {price}"
 */
async function executeBuy(
  tokenId: string,
  conditionId: string,
  outcome: string,
  sizeUsd: number,
  reason: string,
  cfg: Config,
  allowReserve = false,
  price?: number,
): Promise<boolean> {
  const priceStr = price ? ` @ ${$price(price)}` : "";

  // Risk check - only TRUE protective hedges bypass risk checks
  // HedgeUp is NOT a protective hedge (it's doubling down on winners), so it MUST respect risk limits
  // True hedges: "Hedge (X%)", "EmergencyHedge (X%)", "SellSignal Hedge (X%)"
  const isProtectiveHedge =
    reason.startsWith("Hedge (") ||
    reason.startsWith("EmergencyHedge") ||
    reason.startsWith("SellSignal Hedge");
  const riskCheck = checkRiskLimits(cfg);
  if (!riskCheck.allowed && !isProtectiveHedge) {
    log(`⚠️ BUY blocked | ${riskCheck.reason}`);
    return false;
  }
  
  // Hard cap: even protective hedges cannot exceed maxOpenPositions
  // This ensures position count never goes unbounded
  if (state.positions.length >= cfg.risk.maxOpenPositions) {
    log(`⚠️ BUY blocked | Hard position cap: ${state.positions.length} >= ${cfg.risk.maxOpenPositions} (absolute max)`);
    return false;
  }

  // Pre-execution checks (V1 feature)
  const preCheck = await preOrderCheck(tokenId, "BUY", sizeUsd, cfg);
  if (!preCheck.ok && !isProtectiveHedge) {
    log(`⚠️ BUY pre-check failed | ${preCheck.reason}`);
    return false;
  }

  // Adaptive learning check (V1 feature) - skip for protective hedges
  if (
    cfg.adaptiveLearning.enabled &&
    state.adaptiveLearner &&
    !isProtectiveHedge
  ) {
    const evalResult = evaluateTradeWithLearning(conditionId, sizeUsd, 50, cfg);
    if (!evalResult.shouldTrade) {
      log(`🧠 BUY blocked by learning | ${evalResult.reason}`);
      return false;
    }
    sizeUsd = evalResult.adjustedSize;
  }

  // Check reserves before buying (hedging can dip into reserves)
  if (!canSpend(sizeUsd, cfg, allowReserve)) {
    const avail = allowReserve ? state.balance : getAvailableBalance(cfg);
    log(
      `⚠️ BUY | ${reason} | Insufficient (${$(sizeUsd)} > ${$(avail)} avail)`,
    );
    return false;
  }

  if (!state.liveTrading) {
    log(`🔸 BUY [SIM] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
    await alertTrade("BUY", `${reason} [SIM]`, outcome, sizeUsd, price, true);
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, true);
    recordOrderPlaced();
    // Record for adaptive learning
    if (cfg.adaptiveLearning.enabled)
      recordTradeForLearning(conditionId, price || 0.5, sizeUsd);
    return true;
  }

  if (!state.wallet) {
    log(`❌ BUY | ${reason} | No wallet`);
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
    return false;
  }

  log(`🛒 BUY | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);

  try {
    // On-chain mode: try direct wallet trade, fallback to CLOB if not implemented
    if (cfg.tradeMode === "onchain") {
      log(`⛓️ BUY [ONCHAIN] | ${reason} | ${outcome} ${$(sizeUsd)}${priceStr}`);
      const result = await executeOnChainOrder({
        wallet: state.wallet,
        tokenId,
        outcome: outcome as OrderOutcome,
        side: "BUY" as OrderSide,
        sizeUsd,
        maxAcceptablePrice: price ? price * 1.03 : undefined, // 3% slippage
        logger: simpleLogger as any,
      });

      if (result.success) {
        await alertTrade("BUY", reason, outcome, sizeUsd, price, true);
        recordTrade("BUY", outcome, reason, sizeUsd, price || 0, true);
        recordOrderPlaced();
        if (cfg.adaptiveLearning.enabled)
          recordTradeForLearning(conditionId, price || 0.5, sizeUsd);
        invalidate();
        return true;
      }

      // Handle NO_LIQUIDITY: No liquidity to buy from
      // Silently skip these instead of alerting
      if (result.reason === "NO_LIQUIDITY") {
        log(
          `⚠️ BUY | ${reason} | No on-chain liquidity - skipping | ${outcome} ${$(sizeUsd)}`,
        );
        return false;
      }

      // Fallback to CLOB if on-chain not implemented yet
      if (result.reason === "NOT_IMPLEMENTED" && state.clobClient) {
        log(`⚠️ On-chain not ready, falling back to CLOB`);
        // Fall through to CLOB logic below
      } else {
        await alertTrade(
          "BUY",
          reason,
          outcome,
          sizeUsd,
          price,
          false,
          result.reason,
        );
        recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
        return false;
      }
    }

    // CLOB mode: use API
    if (!state.clobClient) {
      log(`❌ BUY | ${reason} | No CLOB client`);
      recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
      return false;
    }

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
      if (cfg.adaptiveLearning.enabled)
        recordTradeForLearning(conditionId, price || 0.5, sizeUsd);
      invalidate();
      return true;
    }
    await alertTrade(
      "BUY",
      reason,
      outcome,
      sizeUsd,
      price,
      false,
      result.reason,
    );
    recordTrade("BUY", outcome, reason, sizeUsd, price || 0, false);
    return false;
  } catch (e: any) {
    await alertTrade(
      "BUY",
      reason,
      outcome,
      sizeUsd,
      price,
      false,
      e.message?.slice(0, 30),
    );
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
        log(
          `🚫 Copy skip | ${$price(signal.price)} < ${$price(cfg.copy.minBuyPrice)} min`,
        );
        state.copied.add(signal.txHash);
        continue;
      }

      let copyUsd = signal.usdSize * cfg.copy.multiplier;
      copyUsd = Math.max(cfg.copy.minUsd, Math.min(cfg.copy.maxUsd, copyUsd));

      // Don't exceed max position size
      const existing = state.positions.find(
        (p) => p.tokenId === signal.tokenId,
      );
      if (existing && existing.value >= cfg.copy.maxUsd) {
        log(
          `🚫 Copy skip | Already at max (${$(existing.value)} >= ${$(cfg.copy.maxUsd)})`,
        );
        state.copied.add(signal.txHash);
        continue;
      }

      // Apply bet scaling when approaching position cap
      const scaledCopyUsd = scaleBetSize(copyUsd, cfg, "Copy");
      if (scaledCopyUsd < cfg.copy.minUsd) {
        log(
          `⏸️ Copy skipped | Scaled ${$(scaledCopyUsd)} < min ${$(cfg.copy.minUsd)}`,
        );
        state.copied.add(signal.txHash);
        continue;
      }

      log(
        `👀 Copy | ${addr.slice(0, 8)}... | ${signal.outcome} ${$(scaledCopyUsd)} @ ${$price(signal.price)}`,
      );
      // Copy trades respect reserves (normal trade)
      await executeBuy(
        signal.tokenId,
        signal.conditionId,
        signal.outcome,
        scaledCopyUsd,
        "Copy",
        cfg,
        false,
        signal.price,
      );
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
  if (
    !cfg.sellSignal.enabled ||
    !cfg.copy.enabled ||
    !cfg.copy.addresses.length
  )
    return;

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
      const ourPosition = state.positions.find(
        (p) => p.tokenId === signal.tokenId,
      );
      if (!ourPosition) continue;

      // Check cooldown
      const lastAction = state.sellSignalCooldown.get(signal.tokenId) || 0;
      if (now - lastAction < cfg.sellSignal.cooldownMs) {
        log(`⏳ Sell signal cooldown | ${signal.tokenId.slice(0, 8)}...`);
        continue;
      }

      // Skip if we're profitable ("knee deep in positive")
      if (ourPosition.pnlPct >= cfg.sellSignal.profitThresholdToSkip) {
        log(
          `✅ Sell signal skip | We're ${pct(ourPosition.pnlPct)} (profitable)`,
        );
        continue;
      }

      // Skip if loss is below threshold
      if (ourPosition.pnlPct > -cfg.sellSignal.minLossPctToAct) {
        log(
          `📊 Sell signal alert | ${signal.tokenId.slice(0, 8)}... | We're ${pct(ourPosition.pnlPct)} (small loss)`,
        );
        await alert(
          "⚠️ SELL SIGNAL",
          `Trader sold | We're ${pct(ourPosition.pnlPct)} | Watching`,
          true,
        );
        continue;
      }

      // Severe loss -> stop-loss (sell immediately)
      if (ourPosition.pnlPct <= -cfg.sellSignal.severeLossPct) {
        log(`🚨 Sell signal STOP-LOSS | ${pct(ourPosition.pnlPct)}`);
        if (
          await executeSell(
            ourPosition.tokenId,
            ourPosition.conditionId,
            ourPosition.outcome,
            ourPosition.value,
            `SellSignal StopLoss (${pct(ourPosition.pnlPct)})`,
            cfg,
            ourPosition.curPrice,
          )
        ) {
          state.sold.add(ourPosition.tokenId);
          state.sellSignalCooldown.set(signal.tokenId, now);
        }
        continue;
      }

      // Moderate loss -> hedge
      if (!state.hedged.has(ourPosition.tokenId)) {
        const opp = ourPosition.outcome === "YES" ? "NO" : "YES";
        log(`🛡️ Sell signal HEDGE | ${pct(ourPosition.pnlPct)}`);
        const hedgeAmt = cfg.hedge.allowExceedMax
          ? cfg.hedge.absoluteMaxUsd
          : cfg.hedge.maxUsd;
        if (
          await executeBuy(
            ourPosition.tokenId,
            ourPosition.conditionId,
            opp,
            hedgeAmt,
            `SellSignal Hedge (${pct(ourPosition.pnlPct)})`,
            cfg,
            true,
            ourPosition.curPrice,
          )
        ) {
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
  if (Date.now() - state.lastRedeem < cfg.redeem.intervalMin * 60 * 1000)
    return;

  state.lastRedeem = Date.now();
  const target = state.proxyAddress || walletAddr;
  const allRedeemable = await fetchRedeemable(target);
  if (!allRedeemable.length) return;

  // Filter by minPositionUsd to avoid wasting gas on tiny/zero-value positions
  const minValue = cfg.redeem.minPositionUsd;
  const filtered = allRedeemable.filter((p) => p.value >= minValue);
  const skipped = allRedeemable.length - filtered.length;

  if (skipped > 0) {
    log(
      `⏭️ Skipping ${skipped} positions below $${minValue.toFixed(2)} threshold`,
    );
  }

  if (!filtered.length) return;

  log(`🎁 ${filtered.length} to redeem`);
  const iface = new Interface(CTF_ABI);

  for (const pos of filtered) {
    try {
      const data = iface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS,
        ZeroHash,
        pos.conditionId,
        INDEX_SETS,
      ]);
      let tx;
      if (state.proxyAddress && state.proxyAddress !== walletAddr) {
        tx = await new Contract(
          state.proxyAddress,
          PROXY_ABI,
          state.wallet,
        ).proxy(CTF_ADDRESS, data);
      } else {
        tx = await new Contract(
          CTF_ADDRESS,
          CTF_ABI,
          state.wallet,
        ).redeemPositions(USDC_ADDRESS, ZeroHash, pos.conditionId, INDEX_SETS);
      }
      log(`⏳ Redeem: ${tx.hash.slice(0, 10)}... | $${pos.value.toFixed(2)} (confirming...)`);
      await tx.wait();
      log(`✅ Redeem confirmed: ${tx.hash.slice(0, 10)}...`);
      // Send Telegram alert for successful redemption after confirmation
      // Note: Redemptions are not recorded as trades to avoid skewing P&L statistics
      await alert(
        "REDEEM ✅",
        `${$(pos.value)} redeemed | Tx: ${tx.hash.slice(0, 10)}...`,
        true,
      );
    } catch (e: any) {
      log(`❌ Redeem: ${e.message?.slice(0, 40)}`);
      await alert(
        "REDEEM ❌",
        `${$(pos.value)} failed | ${e.message?.slice(0, 30) || "Unknown error"}`,
        false,
      );
    }
  }
}

// ============ ARBITRAGE ============

/**
 * Arbitrage scanner - finds markets where YES + NO < 98% (guaranteed profit)
 *
 * V2 IMPROVEMENT: Now scans BOTH current positions AND active markets
 * V1 parity: Scanning active markets is what V1 does to find opportunities
 *
 * @param cfg Configuration
 * @param scanActiveMarkets If true, also scan active markets beyond current positions (default: true)
 */
async function arbitrage(cfg: Config, scanActiveMarkets = true) {
  if (!cfg.arbitrage.enabled) return;

  // Track already-processed condition IDs to avoid duplicates
  const processedConditionIds = new Set<string>();

  // 1. First scan current positions (original behavior)
  const positionConditionIds = [
    ...new Set(state.positions.map((p) => p.conditionId)),
  ];

  for (const cid of positionConditionIds) {
    if (await processArbitrageOpportunity(cid, cfg)) {
      processedConditionIds.add(cid);
    }
  }

  // 2. Optionally scan active markets for additional opportunities (V1 parity)
  if (scanActiveMarkets) {
    try {
      // Configurable market limit (env var or default)
      const activeMarketLimitEnv = process.env.ARBITRAGE_ACTIVE_MARKET_LIMIT;
      const activeMarketLimit =
        activeMarketLimitEnv && !Number.isNaN(Number(activeMarketLimitEnv))
          ? Number(activeMarketLimitEnv)
          : DEFAULT_ARBITRAGE_ACTIVE_MARKET_LIMIT;

      // Fetch active markets from Gamma API (same as V1's endgame-sweep)
      const { data } = await axios.get(
        `${GAMMA_API}/markets?closed=false&limit=${activeMarketLimit}`,
        { timeout: 10000 },
      );

      if (Array.isArray(data)) {
        for (const market of data) {
          // Skip markets we already processed from positions
          const cid = market.condition_id || market.conditionId;
          if (!cid || processedConditionIds.has(cid)) continue;

          // Skip closed or non-accepting markets
          if (market.closed || !market.accepting_orders) continue;

          await processArbitrageOpportunity(cid, cfg);
          processedConditionIds.add(cid);
        }
      }
    } catch {
      /* skip active market scan errors silently */
    }
  }
}

/**
 * Process a single market for arbitrage opportunity
 * Returns true if processed (whether opportunity found or not), false if skipped
 */
async function processArbitrageOpportunity(
  cid: string,
  cfg: Config,
): Promise<boolean> {
  try {
    const { data } = await axios.get(
      `https://clob.polymarket.com/markets/${cid}`,
      { timeout: 5000 },
    );
    if (!data?.tokens?.length) return false;

    const yes = data.tokens.find((t: any) => t.outcome === "Yes");
    const no = data.tokens.find((t: any) => t.outcome === "No");
    if (!yes || !no) return false;

    const yesPrice = Number(yes.price) || 0;
    const noPrice = Number(no.price) || 0;
    const total = yesPrice + noPrice;

    // Check minBuyPrice - skip if either side is below threshold (likely loser)
    if (
      yesPrice < cfg.arbitrage.minBuyPrice ||
      noPrice < cfg.arbitrage.minBuyPrice
    ) {
      return true; // Processed, but no opportunity
    }

    if (total < 0.98 && total > 0.5) {
      const profitPct = (1 - total) * 100;
      // Apply bet scaling when approaching position cap
      const scaledArbUsd = scaleBetSize(cfg.arbitrage.maxUsd / 2, cfg, "Arb");
      if (scaledArbUsd < 1) return true; // Processed, but too small

      log(
        `💎 Arb | YES ${$price(yesPrice)} + NO ${$price(noPrice)} = ${profitPct.toFixed(1)}% profit`,
      );

      // Execute first leg (YES)
      const firstLegSuccess = await executeBuy(
        yes.token_id,
        cid,
        "YES",
        scaledArbUsd,
        "Arb",
        cfg,
        false,
        yesPrice,
      );

      if (firstLegSuccess) {
        // Execute second leg (NO) with retry logic
        let secondLegSuccess = await executeBuy(
          no.token_id,
          cid,
          "NO",
          scaledArbUsd,
          "Arb",
          cfg,
          false,
          noPrice,
        );

        if (!secondLegSuccess) {
          log(
            `⚠️ Arb WARNING | Second leg (NO) failed for market ${cid.slice(0, 8)}... | Retrying...`,
          );
          // Single retry for transient failures
          secondLegSuccess = await executeBuy(
            no.token_id,
            cid,
            "NO",
            scaledArbUsd,
            "Arb",
            cfg,
            false,
            noPrice,
          );

          if (!secondLegSuccess) {
            log(
              `⚠️ Arb WARNING | Retry failed | Position may be unhedged for market ${cid.slice(0, 8)}... | YES filled but NO failed`,
            );
          }
        }
      }
    }
    return true;
  } catch {
    return false;
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

  // Check and rebalance POL if needed (maintains minimum POL for gas)
  await checkAndRebalancePol(cfg);

  // After potential POL rebalance (which may spend USDC), refresh balance again
  await fetchBalance();

  // Log reserve status periodically (every 60 seconds)
  const RESERVE_LOG_INTERVAL_MS = 60_000;
  if (
    cfg.dynamicReserves.enabled &&
    Date.now() - state.lastReserveLog >= RESERVE_LOG_INTERVAL_MS
  ) {
    const breakdown = getReserveBreakdown(cfg);
    const modeEmoji = breakdown.mode === "RISK_ON" ? "✅" : "⚠️";
    const positionValue = state.positions.reduce((sum, p) => sum + p.value, 0);
    log(
      `💰 [DynamicReserves] balance=$${state.balance.toFixed(2)} | positions=$${positionValue.toFixed(2)} | ` +
        `reserves=$${breakdown.effectiveReserve.toFixed(2)} (pct:$${breakdown.pctReserve.toFixed(2)}, risk:$${breakdown.riskReserve.toFixed(2)}) | ` +
        `${modeEmoji} ${breakdown.mode} (${state.positions.length} pos)`,
    );

    // Log top risky positions if in RISK_OFF mode
    if (
      breakdown.mode === "RISK_OFF" &&
      breakdown.topPositionRisks.length > 0
    ) {
      const riskDetails = breakdown.topPositionRisks
        .filter((r) => r.reserveUsd > 0)
        .map(
          (r) =>
            `${r.tokenId.slice(0, 8)}...(${r.tier},$${r.reserveUsd.toFixed(2)})`,
        )
        .join(", ");
      if (riskDetails) {
        log(`   Risk drivers: ${riskDetails}`);
      }
    }
    state.lastReserveLog = Date.now();
  }

  // Copy BUY trades from tracked traders
  await copyTrades(cfg);

  // Process SELL signals from tracked traders (protective actions)
  await processSellSignals(cfg);

  const positions = await fetchPositions(state.proxyAddress || walletAddr);
  if (!positions.length) {
    await redeem(walletAddr, cfg);
    return;
  }

  // Run profitability optimizer analysis and build map for quick lookup
  // This is used in step 8 for positions that don't match rule-based strategies
  const profitRecommendations = analyzePortfolioProfitability(cfg);
  const profitRecMap = new Map<string, OptimizationResult>();
  for (const rec of profitRecommendations) {
    const subject = rec.subject as AnalyzablePosition;
    profitRecMap.set(subject.tokenId, rec);
  }

  // Process each position ONCE based on priority
  // PRIORITY ORDER (matches V1 orchestrator):
  // 1. AutoSell - guaranteed profit near $1
  // 2. Hedge - try to RECOVER losing positions BEFORE giving up
  // 3. Stop-Loss - only if NOT hedged and loss exceeds threshold
  // 4. Scalp - take profits on winners
  // 5. Stack - double down on winners
  // 6. Endgame - ride high-confidence to finish
  // 8. ProfitabilityOptimizer - catch profitable opportunities that don't fit patterns

  for (const p of positions) {
    // Skip if already acted on (sold permanently)
    if (state.sold.has(p.tokenId)) continue;

    // Skip positions with untradeable prices (at or below absolute minimum)
    // These cannot be sold on the market - avoids spammy ZERO_PRICE warnings
    if (p.curPrice <= ABSOLUTE_MIN_TRADEABLE_PRICE) {
      continue;
    }

    // Track position entry time and price history
    trackPositionEntry(p.tokenId);
    trackPriceHistory(p.tokenId, p.curPrice);

    const holdTime = getPositionHoldTime(p.tokenId);

    // 1. AUTO-SELL: Near $1 - guaranteed profit (highest priority)
    if (
      cfg.autoSell.enabled &&
      p.curPrice >= cfg.autoSell.threshold &&
      holdTime >= cfg.autoSell.minHoldSec
    ) {
      if (
        await executeSell(
          p.tokenId,
          p.conditionId,
          p.outcome,
          p.value,
          "AutoSell",
          cfg,
          p.curPrice,
        )
      ) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }

    // 1b. DISPUTE WINDOW EXIT: Exit positions at 99.9¢ to avoid dispute wait
    // Positions near resolution can get stuck in 2-hour dispute windows
    if (
      cfg.autoSell.disputeWindowExitEnabled &&
      p.curPrice >= cfg.autoSell.disputeWindowExitPrice &&
      p.curPrice < 1.0
    ) {
      log(`⚡ Dispute window exit | ${p.outcome} @ ${$price(p.curPrice)}`);
      if (
        await executeSell(
          p.tokenId,
          p.conditionId,
          p.outcome,
          p.value,
          `DisputeExit (${$price(p.curPrice)})`,
          cfg,
          p.curPrice,
        )
      ) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }

    // 1c. QUICK WIN: Big profit in short time
    if (
      cfg.autoSell.quickWinEnabled &&
      holdTime < cfg.autoSell.quickWinMaxHoldMinutes * 60 &&
      p.pnlPct >= cfg.autoSell.quickWinProfitPct
    ) {
      if (
        await executeSell(
          p.tokenId,
          p.conditionId,
          p.outcome,
          p.value,
          `QuickWin (${pct(p.pnlPct)})`,
          cfg,
          p.curPrice,
        )
      ) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }

    // 1d. STALE POSITION: Profitable but held too long
    if (
      cfg.autoSell.stalePositionHours > 0 &&
      p.pnlPct > 0 &&
      holdTime >= cfg.autoSell.stalePositionHours * 3600
    ) {
      if (
        await executeSell(
          p.tokenId,
          p.conditionId,
          p.outcome,
          p.value,
          `Stale (${Math.floor(holdTime / 3600)}h)`,
          cfg,
          p.curPrice,
        )
      ) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }

    // 2. HEDGE-UP: Buy MORE shares when winning and price is high (near resolution)
    // This doubles down on winners approaching $1
    if (
      cfg.hedge.hedgeUpEnabled &&
      p.pnlPct > 0 &&
      p.curPrice >= cfg.hedge.hedgeUpPriceThreshold &&
      p.curPrice <= cfg.hedge.hedgeUpMaxPrice
    ) {
      if (!state.stacked.has(p.tokenId)) {
        // Don't hedge-up if already stacked
        // Apply bet scaling (hedge-up is a normal BUY, not protective)
        const scaledHedgeUpAmt = scaleBetSize(
          cfg.hedge.hedgeUpMaxUsd,
          cfg,
          "HedgeUp",
        );
        if (scaledHedgeUpAmt >= 5) {
          if (
            await executeBuy(
              p.tokenId,
              p.conditionId,
              p.outcome,
              scaledHedgeUpAmt,
              `HedgeUp (${$price(p.curPrice)})`,
              cfg,
              false,
              p.curPrice,
            )
          ) {
            state.stacked.add(p.tokenId); // Mark as stacked to prevent repeat
            cycleActed.add(p.tokenId);
          }
        }
        continue;
      }
    }

    // 3. HEDGE: Losing - try to RECOVER first (before giving up with stop-loss)
    // Only hedge if: losing >= triggerPct AND not already hedged AND held long enough
    // Also check: entry price below maxEntryPrice (only hedge risky positions)
    // Also check: NOT in no-hedge window (too close to market close)

    // Compute no-hedge window using REAL market close time if available
    // This is more accurate than the hold-time-based heuristic (which assumed 24h markets)
    const now = Date.now();
    let inNoHedgeWindow = false;
    let minutesToClose: number | undefined;

    if (p.marketEndTime && p.marketEndTime >= now) {
      // Use real market close time
      minutesToClose = (p.marketEndTime - now) / (60 * 1000);
      inNoHedgeWindow = minutesToClose <= cfg.hedge.noHedgeWindowMinutes;
    }
    // Fallback: If no market close time, use hold-time-based heuristic
    // This preserves backward compatibility for positions without end time data
    if (minutesToClose === undefined) {
      const holdMinutesForHedge = holdTime / 60;
      inNoHedgeWindow =
        holdMinutesForHedge >=
        ASSUMED_MARKET_DURATION_HOURS * 60 - cfg.hedge.noHedgeWindowMinutes;
    }

    if (
      cfg.hedge.enabled &&
      !state.hedged.has(p.tokenId) &&
      p.pnlPct <= -cfg.hedge.triggerPct &&
      holdTime >= cfg.hedge.minHoldSeconds &&
      !inNoHedgeWindow
    ) {
      // Check if entry price qualifies for hedging
      if (p.avgPrice > cfg.hedge.maxEntryPrice) {
        log(
          `⚠️ Skip hedge | Entry ${$price(p.avgPrice)} > max ${$price(cfg.hedge.maxEntryPrice)}`,
        );
        continue;
      }

      // Force liquidation for extreme losses instead of hedge
      if (p.pnlPct <= -cfg.hedge.forceLiquidationPct) {
        // Skip worthless positions - not worth the transaction fees
        if (p.value < cfg.hedge.minHedgeUsd) {
          log(
            `⏭️ Skip force liq | Value ${$(p.value)} too low (${pct(p.pnlPct)})`,
          );
          continue;
        }
        log(
          `🚨 Force liquidation | ${pct(p.pnlPct)} exceeds ${cfg.hedge.forceLiquidationPct}%`,
        );
        if (
          await executeSell(
            p.tokenId,
            p.conditionId,
            p.outcome,
            p.value,
            `ForceLiq (${pct(p.pnlPct)})`,
            cfg,
            p.curPrice,
          )
        ) {
          state.sold.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
        continue;
      }

      const opp = p.outcome === "YES" ? "NO" : "YES";
      // Emergency mode: use absolute max for severe losses
      const isEmergency = p.pnlPct <= -cfg.hedge.emergencyLossPct;
      const hedgeAmt =
        isEmergency || cfg.hedge.allowExceedMax
          ? cfg.hedge.absoluteMaxUsd
          : cfg.hedge.maxUsd;
      const reason = isEmergency
        ? `EmergencyHedge (${pct(p.pnlPct)})`
        : `Hedge (${pct(p.pnlPct)})`;

      if (
        await executeBuy(
          p.tokenId,
          p.conditionId,
          opp,
          hedgeAmt,
          reason,
          cfg,
          true,
          p.curPrice,
        )
      ) {
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
    if (
      cfg.stopLoss.enabled &&
      !cfg.hedge.enabled &&
      p.pnlPct <= -cfg.stopLoss.maxLossPct &&
      holdTime >= cfg.stopLoss.minHoldSec
    ) {
      if (
        await executeSell(
          p.tokenId,
          p.conditionId,
          p.outcome,
          p.value,
          `StopLoss (${pct(p.pnlPct)})`,
          cfg,
          p.curPrice,
        )
      ) {
        state.sold.add(p.tokenId);
        cycleActed.add(p.tokenId);
      }
      continue;
    }

    // 5. SCALP: In profit - take profits
    // Skip if: low price threshold set AND entry below threshold (speculative positions)
    // Skip if: near resolution AND entry was speculative (let $1 winners ride)
    const skipLowPrice =
      cfg.scalp.lowPriceThreshold > 0 &&
      p.avgPrice < cfg.scalp.lowPriceThreshold;
    const skipNearResolution =
      p.avgPrice < 0.6 && p.curPrice >= cfg.scalp.resolutionExclusionPrice;

    // Check hold time for scalping
    const holdMinutes = holdTime / 60;
    const meetsMinHold = holdMinutes >= cfg.scalp.minHoldMinutes;
    const exceedsMaxHold = holdMinutes >= cfg.scalp.maxHoldMinutes;

    // Check for sudden spike (with time window)
    const hasSuddenSpike =
      cfg.scalp.suddenSpikeEnabled &&
      detectPriceSpike(
        p.tokenId,
        p.curPrice,
        cfg.scalp.suddenSpikeThresholdPct,
        cfg.scalp.suddenSpikeWindowMinutes,
      );

    // Check momentum - only scalp when momentum is fading (V1 feature)
    const momentum = getMomentum(p.tokenId);
    const momentumFading = isMomentumFading(p.tokenId);
    const shouldScalpMomentum = momentum < 0.3 || momentumFading; // Low/fading momentum = good time to exit

    // Scalp conditions:
    // 1. Profit thresholds met AND min hold AND (momentum fading OR not strongly positive)
    // 2. Sudden spike (take profit immediately)
    // 3. Max hold exceeded (if profitable)
    const scalpCondition =
      (p.pnlPct >= cfg.scalp.minProfitPct &&
        p.gainCents >= cfg.scalp.minGainCents &&
        meetsMinHold &&
        shouldScalpMomentum) ||
      hasSuddenSpike ||
      (exceedsMaxHold && p.pnlPct > 0);

    if (
      cfg.scalp.enabled &&
      !skipLowPrice &&
      !skipNearResolution &&
      scalpCondition
    ) {
      const profitUsd = p.value * (p.pnlPct / 100);
      if (
        profitUsd >= cfg.scalp.minProfitUsd ||
        hasSuddenSpike ||
        exceedsMaxHold
      ) {
        let reason: string;
        if (hasSuddenSpike) reason = `Spike (${pct(p.pnlPct)})`;
        else if (exceedsMaxHold) reason = `MaxHold (${pct(p.pnlPct)})`;
        else if (momentumFading) reason = `ScalpFade (${pct(p.pnlPct)})`;
        else reason = `Scalp (${pct(p.pnlPct)})`;

        if (
          await executeSell(
            p.tokenId,
            p.conditionId,
            p.outcome,
            p.value,
            reason,
            cfg,
            p.curPrice,
          )
        ) {
          state.sold.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
        continue;
      }
    }

    // 6. STACK: Winning - add to winners (once per position)
    // Also check global max position limit
    const currentPositionValue = getTotalPositionValue(p.tokenId);
    if (
      cfg.stack.enabled &&
      !state.stacked.has(p.tokenId) &&
      p.gainCents >= cfg.stack.minGainCents &&
      p.curPrice <= cfg.stack.maxPrice &&
      currentPositionValue < cfg.maxPositionUsd
    ) {
      const buys = await countBuys(walletAddr, p.tokenId);
      if (buys >= 2) {
        state.stacked.add(p.tokenId);
        continue;
      }
      // Limit stack size to not exceed max position, then apply bet scaling
      const baseStackSize = Math.min(
        cfg.stack.maxUsd,
        cfg.maxPositionUsd - currentPositionValue,
      );
      const scaledStackSize = scaleBetSize(baseStackSize, cfg, "Stack");
      if (scaledStackSize >= 5) {
        if (
          await executeBuy(
            p.tokenId,
            p.conditionId,
            p.outcome,
            scaledStackSize,
            `Stack (${pct(p.pnlPct)})`,
            cfg,
            false,
            p.curPrice,
          )
        ) {
          state.stacked.add(p.tokenId);
          cycleActed.add(p.tokenId);
        }
      }
      continue;
    }

    // 7. ENDGAME: High confidence - ride to finish
    if (
      cfg.endgame.enabled &&
      p.curPrice >= cfg.endgame.minPrice &&
      p.curPrice <= cfg.endgame.maxPrice
    ) {
      if (p.value < cfg.endgame.maxUsd * 2) {
        const baseAddAmt = Math.min(
          cfg.endgame.maxUsd,
          cfg.endgame.maxUsd * 2 - p.value,
        );
        const scaledAddAmt = scaleBetSize(baseAddAmt, cfg, "Endgame");
        if (scaledAddAmt >= 5) {
          await executeBuy(
            p.tokenId,
            p.conditionId,
            p.outcome,
            scaledAddAmt,
            "Endgame",
            cfg,
            false,
            p.curPrice,
          );
          cycleActed.add(p.tokenId);
        }
      }
      continue;
    }
    
    // 8. PROFITABILITY-GUIDED: If no fixed rule matched, check optimizer recommendations
    // This is a final optimization pass that uses EV analysis to find profitable opportunities
    // that don't fit the traditional rule-based patterns
    if (cfg.profitabilityOptimizer.enabled && state.profitabilityOptimizer) {
      const profitRec = profitRecMap.get(p.tokenId);
      if (profitRec && profitRec.recommendedAction !== "HOLD") {
        const bestAction = profitRec.rankedActions[0];
        const minEv = cfg.profitabilityOptimizer.minExpectedValueUsd;
        
        // Only act if EV exceeds minimum threshold
        if (bestAction.expectedValueUsd >= minEv) {
          const recSize = Math.min(profitRec.recommendedSizeUsd, getAvailableBalance(cfg));
          
          if (recSize >= 5) { // Minimum trade size
            switch (profitRec.recommendedAction) {
              case "STACK":
                // Optimizer suggests stacking - use optimizer's recommended size
                if (!state.stacked.has(p.tokenId)) {
                  log(`📊 [ProfitOptimizer] Stack opportunity | EV: ${$(bestAction.expectedValueUsd)} | ${p.outcome} ${$(recSize)}`);
                  if (await executeBuy(p.tokenId, p.conditionId, p.outcome, recSize, `OptStack (EV:${$(bestAction.expectedValueUsd)})`, cfg, false, p.curPrice)) {
                    state.stacked.add(p.tokenId);
                    cycleActed.add(p.tokenId);
                  }
                }
                break;
                
              case "HEDGE_DOWN":
                // Optimizer suggests hedging loss - may be more aggressive than fixed rules
                if (!state.hedged.has(p.tokenId)) {
                  const opp = p.outcome === "YES" ? "NO" : "YES";
                  log(`📊 [ProfitOptimizer] Hedge opportunity | EV: ${$(bestAction.expectedValueUsd)} | ${opp} ${$(recSize)}`);
                  if (await executeBuy(p.tokenId, p.conditionId, opp, recSize, `OptHedge (EV:${$(bestAction.expectedValueUsd)})`, cfg, true, p.curPrice)) {
                    state.hedged.add(p.tokenId);
                    cycleActed.add(p.tokenId);
                  }
                }
                break;
                
              case "HEDGE_UP":
                // Optimizer suggests buying more at high probability
                if (!state.stacked.has(p.tokenId)) {
                  log(`📊 [ProfitOptimizer] Hedge-up opportunity | EV: ${$(bestAction.expectedValueUsd)} | ${p.outcome} ${$(recSize)}`);
                  if (await executeBuy(p.tokenId, p.conditionId, p.outcome, recSize, `OptHedgeUp (EV:${$(bestAction.expectedValueUsd)})`, cfg, false, p.curPrice)) {
                    state.stacked.add(p.tokenId);
                    cycleActed.add(p.tokenId);
                  }
                }
                break;
                
              case "SELL":
                // Optimizer suggests selling - lock in value
                if (!state.sold.has(p.tokenId) && p.value >= 5) {
                  log(`📊 [ProfitOptimizer] Sell opportunity | EV: ${$(bestAction.expectedValueUsd)} | ${p.outcome} ${$(p.value)}`);
                  if (await executeSell(p.tokenId, p.conditionId, p.outcome, p.value, `OptSell (EV:${$(bestAction.expectedValueUsd)})`, cfg, p.curPrice)) {
                    state.sold.add(p.tokenId);
                    cycleActed.add(p.tokenId);
                  }
                }
                break;
            }
          }
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
  const preset = (process.env.STRATEGY_PRESET ||
    process.env.PRESET ||
    "balanced") as Preset;
  if (!PRESETS[preset]) throw new Error(`Invalid PRESET: ${preset}`);

  const cfg: Config = JSON.parse(JSON.stringify(PRESETS[preset]));
  const env = (k: string) => process.env[k];
  const envBool = (k: string) => {
    const val = env(k)?.trim().toLowerCase();
    if (!val) return undefined;
    return val === "true" || val === "1" || val === "yes";
  };
  const envNum = (k: string) => (env(k) ? Number(env(k)) : undefined);

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
  if (envBool("AUTO_SELL_ENABLED") !== undefined)
    cfg.autoSell.enabled = envBool("AUTO_SELL_ENABLED")!;
  if (envNum("AUTO_SELL_THRESHOLD") !== undefined)
    cfg.autoSell.threshold = envNum("AUTO_SELL_THRESHOLD")!;
  if (envNum("AUTO_SELL_MIN_HOLD_SEC") !== undefined)
    cfg.autoSell.minHoldSec = envNum("AUTO_SELL_MIN_HOLD_SEC")!;

  // ========== STOP-LOSS ==========
  // V1: STOP_LOSS_ENABLED, STOP_LOSS_PCT, STOP_LOSS_MIN_HOLD_SECONDS | Also: HEDGING_TRIGGER_LOSS_PCT (alias)
  if (envBool("STOP_LOSS_ENABLED") !== undefined)
    cfg.stopLoss.enabled = envBool("STOP_LOSS_ENABLED")!;
  if (envNum("STOP_LOSS_PCT") !== undefined)
    cfg.stopLoss.maxLossPct = envNum("STOP_LOSS_PCT")!;
  if (envNum("STOP_LOSS_MIN_HOLD_SECONDS") !== undefined)
    cfg.stopLoss.minHoldSec = envNum("STOP_LOSS_MIN_HOLD_SECONDS")!;

  // ========== HEDGING ==========
  // V1: HEDGING_ENABLED, HEDGING_TRIGGER_LOSS_PCT, HEDGING_MAX_HEDGE_USD, HEDGING_ALLOW_EXCEED_MAX, HEDGING_ABSOLUTE_MAX_USD
  // V2: HEDGE_ENABLED, HEDGE_TRIGGER_PCT, HEDGE_MAX_USD
  if (envBool("HEDGING_ENABLED") !== undefined)
    cfg.hedge.enabled = envBool("HEDGING_ENABLED")!;
  if (envBool("HEDGE_ENABLED") !== undefined)
    cfg.hedge.enabled = envBool("HEDGE_ENABLED")!;
  if (envNum("HEDGING_TRIGGER_LOSS_PCT") !== undefined)
    cfg.hedge.triggerPct = envNum("HEDGING_TRIGGER_LOSS_PCT")!;
  if (envNum("HEDGE_TRIGGER_PCT") !== undefined)
    cfg.hedge.triggerPct = envNum("HEDGE_TRIGGER_PCT")!;
  if (envNum("HEDGING_MAX_HEDGE_USD") !== undefined)
    cfg.hedge.maxUsd = envNum("HEDGING_MAX_HEDGE_USD")!;
  if (envNum("HEDGE_MAX_USD") !== undefined)
    cfg.hedge.maxUsd = envNum("HEDGE_MAX_USD")!;
  if (envBool("HEDGING_ALLOW_EXCEED_MAX") !== undefined)
    cfg.hedge.allowExceedMax = envBool("HEDGING_ALLOW_EXCEED_MAX")!;
  if (envNum("HEDGING_ABSOLUTE_MAX_USD") !== undefined)
    cfg.hedge.absoluteMaxUsd = envNum("HEDGING_ABSOLUTE_MAX_USD")!;
  // HEDGING_RESERVE_PCT: % of balance to keep reserved (not spent on normal trades)
  // Hedge actions can dip into reserves, but normal trades cannot
  if (envNum("HEDGING_RESERVE_PCT") !== undefined) {
    cfg.hedge.reservePct = envNum("HEDGING_RESERVE_PCT")!;
    cfg.reservePct = envNum("HEDGING_RESERVE_PCT")!;
  }
  if (envNum("RESERVE_PCT") !== undefined)
    cfg.reservePct = envNum("RESERVE_PCT")!;

  // ========== SCALPING ==========
  // V1: SCALP_TAKE_PROFIT_ENABLED, SCALP_MIN_PROFIT_PCT, SCALP_LOW_PRICE_THRESHOLD, SCALP_MIN_PROFIT_USD
  // V2: SCALP_ENABLED, SCALP_MIN_PROFIT_PCT, SCALP_MIN_GAIN_CENTS
  if (envBool("SCALP_TAKE_PROFIT_ENABLED") !== undefined)
    cfg.scalp.enabled = envBool("SCALP_TAKE_PROFIT_ENABLED")!;
  if (envBool("SCALP_ENABLED") !== undefined)
    cfg.scalp.enabled = envBool("SCALP_ENABLED")!;
  if (envNum("SCALP_MIN_PROFIT_PCT") !== undefined)
    cfg.scalp.minProfitPct = envNum("SCALP_MIN_PROFIT_PCT")!;
  if (envNum("SCALP_TARGET_PROFIT_PCT") !== undefined)
    cfg.scalp.minProfitPct = envNum("SCALP_TARGET_PROFIT_PCT")!;
  if (envNum("SCALP_MIN_GAIN_CENTS") !== undefined)
    cfg.scalp.minGainCents = envNum("SCALP_MIN_GAIN_CENTS")!;
  if (envNum("SCALP_LOW_PRICE_THRESHOLD") !== undefined)
    cfg.scalp.lowPriceThreshold = envNum("SCALP_LOW_PRICE_THRESHOLD")!;
  if (envNum("SCALP_MIN_PROFIT_USD") !== undefined)
    cfg.scalp.minProfitUsd = envNum("SCALP_MIN_PROFIT_USD")!;

  // ========== POSITION STACKING ==========
  // V1: POSITION_STACKING_ENABLED, POSITION_STACKING_MIN_GAIN_CENTS, POSITION_STACKING_MAX_CURRENT_PRICE
  // V2: STACK_ENABLED, STACK_MIN_GAIN_CENTS, STACK_MAX_USD, STACK_MAX_PRICE
  if (envBool("POSITION_STACKING_ENABLED") !== undefined)
    cfg.stack.enabled = envBool("POSITION_STACKING_ENABLED")!;
  if (envBool("STACK_ENABLED") !== undefined)
    cfg.stack.enabled = envBool("STACK_ENABLED")!;
  if (envNum("POSITION_STACKING_MIN_GAIN_CENTS") !== undefined)
    cfg.stack.minGainCents = envNum("POSITION_STACKING_MIN_GAIN_CENTS")!;
  if (envNum("STACK_MIN_GAIN_CENTS") !== undefined)
    cfg.stack.minGainCents = envNum("STACK_MIN_GAIN_CENTS")!;
  if (envNum("STACK_MAX_USD") !== undefined)
    cfg.stack.maxUsd = envNum("STACK_MAX_USD")!;
  if (envNum("POSITION_STACKING_MAX_CURRENT_PRICE") !== undefined)
    cfg.stack.maxPrice = envNum("POSITION_STACKING_MAX_CURRENT_PRICE")!;
  if (envNum("STACK_MAX_PRICE") !== undefined)
    cfg.stack.maxPrice = envNum("STACK_MAX_PRICE")!;

  // ========== ENDGAME ==========
  if (envBool("ENDGAME_ENABLED") !== undefined)
    cfg.endgame.enabled = envBool("ENDGAME_ENABLED")!;
  if (envNum("ENDGAME_MIN_PRICE") !== undefined)
    cfg.endgame.minPrice = envNum("ENDGAME_MIN_PRICE")!;
  if (envNum("ENDGAME_MAX_PRICE") !== undefined)
    cfg.endgame.maxPrice = envNum("ENDGAME_MAX_PRICE")!;
  if (envNum("ENDGAME_MAX_USD") !== undefined)
    cfg.endgame.maxUsd = envNum("ENDGAME_MAX_USD")!;

  // ========== AUTO-REDEEM ==========
  // V1: AUTO_REDEEM_ENABLED, AUTO_REDEEM_MIN_POSITION_USD, AUTO_REDEEM_CHECK_INTERVAL_MS
  // V2: REDEEM_ENABLED, REDEEM_INTERVAL_MIN
  if (envBool("AUTO_REDEEM_ENABLED") !== undefined)
    cfg.redeem.enabled = envBool("AUTO_REDEEM_ENABLED")!;
  if (envBool("REDEEM_ENABLED") !== undefined)
    cfg.redeem.enabled = envBool("REDEEM_ENABLED")!;
  if (envNum("REDEEM_INTERVAL_MIN") !== undefined)
    cfg.redeem.intervalMin = envNum("REDEEM_INTERVAL_MIN")!;
  if (envNum("AUTO_REDEEM_CHECK_INTERVAL_MS") !== undefined)
    cfg.redeem.intervalMin = Math.round(
      envNum("AUTO_REDEEM_CHECK_INTERVAL_MS")! / 60000,
    );
  if (envNum("AUTO_REDEEM_MIN_POSITION_USD") !== undefined)
    cfg.redeem.minPositionUsd = envNum("AUTO_REDEEM_MIN_POSITION_USD")!;

  // ========== COPY TRADING ==========
  // V1: TARGET_ADDRESSES, TRADE_MULTIPLIER, MIN_TRADE_SIZE_USD, MIN_BUY_PRICE
  // V2: COPY_ADDRESSES, COPY_MULTIPLIER, COPY_MIN_USD, COPY_MAX_USD, COPY_MIN_BUY_PRICE
  // Also: MONITOR_ADDRESSES
  const copyAddrs =
    env("COPY_ADDRESSES") ||
    env("TARGET_ADDRESSES") ||
    env("MONITOR_ADDRESSES");
  if (copyAddrs) {
    cfg.copy.enabled = true;
    cfg.copy.addresses = copyAddrs
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
  }
  if (envNum("COPY_MULTIPLIER") !== undefined)
    cfg.copy.multiplier = envNum("COPY_MULTIPLIER")!;
  if (envNum("TRADE_MULTIPLIER") !== undefined)
    cfg.copy.multiplier = envNum("TRADE_MULTIPLIER")!;
  if (envNum("COPY_MIN_USD") !== undefined)
    cfg.copy.minUsd = envNum("COPY_MIN_USD")!;
  if (envNum("MIN_TRADE_SIZE_USD") !== undefined)
    cfg.copy.minUsd = envNum("MIN_TRADE_SIZE_USD")!;
  if (envNum("COPY_MAX_USD") !== undefined)
    cfg.copy.maxUsd = envNum("COPY_MAX_USD")!;
  if (envNum("COPY_MIN_BUY_PRICE") !== undefined)
    cfg.copy.minBuyPrice = envNum("COPY_MIN_BUY_PRICE")!;
  if (envNum("MIN_BUY_PRICE") !== undefined)
    cfg.copy.minBuyPrice = envNum("MIN_BUY_PRICE")!;

  // ========== SELL SIGNAL MONITOR ==========
  // When tracked trader sells, check our position and take protective action
  // V1: SELL_SIGNAL_MIN_LOSS_PCT_TO_ACT, SELL_SIGNAL_PROFIT_THRESHOLD_TO_SKIP, SELL_SIGNAL_SEVERE_LOSS_PCT
  // V2: SELL_SIGNAL_ENABLED, SELL_SIGNAL_MIN_LOSS_PCT, SELL_SIGNAL_PROFIT_SKIP_PCT, SELL_SIGNAL_SEVERE_PCT
  if (envBool("SELL_SIGNAL_ENABLED") !== undefined)
    cfg.sellSignal.enabled = envBool("SELL_SIGNAL_ENABLED")!;
  if (envNum("SELL_SIGNAL_MIN_LOSS_PCT") !== undefined)
    cfg.sellSignal.minLossPctToAct = envNum("SELL_SIGNAL_MIN_LOSS_PCT")!;
  if (envNum("SELL_SIGNAL_MIN_LOSS_PCT_TO_ACT") !== undefined)
    cfg.sellSignal.minLossPctToAct = envNum("SELL_SIGNAL_MIN_LOSS_PCT_TO_ACT")!;
  if (envNum("SELL_SIGNAL_PROFIT_SKIP_PCT") !== undefined)
    cfg.sellSignal.profitThresholdToSkip = envNum(
      "SELL_SIGNAL_PROFIT_SKIP_PCT",
    )!;
  if (envNum("SELL_SIGNAL_PROFIT_THRESHOLD_TO_SKIP") !== undefined)
    cfg.sellSignal.profitThresholdToSkip = envNum(
      "SELL_SIGNAL_PROFIT_THRESHOLD_TO_SKIP",
    )!;
  if (envNum("SELL_SIGNAL_SEVERE_PCT") !== undefined)
    cfg.sellSignal.severeLossPct = envNum("SELL_SIGNAL_SEVERE_PCT")!;
  if (envNum("SELL_SIGNAL_SEVERE_LOSS_PCT") !== undefined)
    cfg.sellSignal.severeLossPct = envNum("SELL_SIGNAL_SEVERE_LOSS_PCT")!;
  if (envNum("SELL_SIGNAL_COOLDOWN_MS") !== undefined)
    cfg.sellSignal.cooldownMs = envNum("SELL_SIGNAL_COOLDOWN_MS")!;

  // ========== RISK MANAGEMENT ==========
  // Control position limits, drawdown, and bet scaling
  if (envNum("MAX_DRAWDOWN_PCT") !== undefined)
    cfg.risk.maxDrawdownPct = envNum("MAX_DRAWDOWN_PCT")!;
  if (envNum("MAX_DAILY_LOSS_USD") !== undefined)
    cfg.risk.maxDailyLossUsd = envNum("MAX_DAILY_LOSS_USD")!;
  if (envNum("MAX_OPEN_POSITIONS") !== undefined)
    cfg.risk.maxOpenPositions = envNum("MAX_OPEN_POSITIONS")!;
  if (envNum("ORDER_COOLDOWN_MS") !== undefined)
    cfg.risk.orderCooldownMs = envNum("ORDER_COOLDOWN_MS")!;
  if (envNum("MAX_ORDERS_PER_HOUR") !== undefined)
    cfg.risk.maxOrdersPerHour = envNum("MAX_ORDERS_PER_HOUR")!;
  // Bet scaling when approaching position cap
  // SCALE_DOWN_THRESHOLD: Start scaling when positions >= this % of max (default: 70%)
  // SCALE_DOWN_MIN_PCT: Minimum scale factor (default: 25% = 0.25x base size)
  if (envNum("SCALE_DOWN_THRESHOLD") !== undefined)
    cfg.risk.scaleDownThreshold = envNum("SCALE_DOWN_THRESHOLD")!;
  if (envNum("SCALE_DOWN_MIN_PCT") !== undefined)
    cfg.risk.scaleDownMinPct = envNum("SCALE_DOWN_MIN_PCT")!;
  // Hedge buffer - reserve slots for protective hedges
  if (envNum("HEDGE_BUFFER") !== undefined)
    cfg.risk.hedgeBuffer = envNum("HEDGE_BUFFER")!;

  // Validate hedge buffer vs max open positions
  if (cfg.risk.hedgeBuffer >= cfg.risk.maxOpenPositions) {
    throw new Error(
      `Invalid risk configuration: HEDGE_BUFFER (${cfg.risk.hedgeBuffer}) must be less than MAX_OPEN_POSITIONS ` +
        `(${cfg.risk.maxOpenPositions}). This would make effectiveMax = maxOpenPositions - hedgeBuffer <= 0 and ` +
        `block all normal trading. Please adjust MAX_OPEN_POSITIONS and/or HEDGE_BUFFER.`,
    );
  }

  // ========== ARBITRAGE ==========
  // V1: ARB_ENABLED, ARB_DRY_RUN, ARB_MIN_EDGE_BPS, ARB_MIN_BUY_PRICE
  if (envBool("ARB_ENABLED") !== undefined)
    cfg.arbitrage.enabled = envBool("ARB_ENABLED")!;
  if (envNum("ARB_MAX_USD") !== undefined)
    cfg.arbitrage.maxUsd = envNum("ARB_MAX_USD")!;
  if (envNum("ARB_MIN_EDGE_BPS") !== undefined)
    cfg.arbitrage.minEdgeBps = envNum("ARB_MIN_EDGE_BPS")!;
  if (envNum("ARB_MIN_BUY_PRICE") !== undefined)
    cfg.arbitrage.minBuyPrice = envNum("ARB_MIN_BUY_PRICE")!;

  // ========== V1 FEATURES ==========
  // Adaptive learning: learns from trade outcomes, avoids bad markets
  if (envBool("ADAPTIVE_LEARNING_ENABLED") !== undefined)
    cfg.adaptiveLearning.enabled = envBool("ADAPTIVE_LEARNING_ENABLED")!;
  // On-chain exit: handles NOT_TRADABLE positions
  if (envBool("ON_CHAIN_EXIT_ENABLED") !== undefined)
    cfg.onChainExit.enabled = envBool("ON_CHAIN_EXIT_ENABLED")!;
  if (envNum("ON_CHAIN_EXIT_PRICE_THRESHOLD") !== undefined)
    cfg.onChainExit.priceThreshold = envNum("ON_CHAIN_EXIT_PRICE_THRESHOLD")!;
  // Trade mode: "onchain" (default) or "clob"
  const tradeModeVal = env("TRADE_MODE");
  if (tradeModeVal === "clob") cfg.tradeMode = "clob";
  if (tradeModeVal === "onchain") cfg.tradeMode = "onchain";

  // ========== POL RESERVE ==========
  // Auto-swap USDC to POL to maintain minimum POL balance for gas
  // POL_RESERVE_ENABLED: Enable/disable the feature (default: true)
  // POL_RESERVE_TARGET: Target POL balance (default: 50)
  // MIN_POL_RESERVE: Legacy alias for POL_RESERVE_TARGET (sets targetPol, not minPol)
  // POL_RESERVE_MIN: Minimum POL before triggering rebalance (default: 10)
  // POL_RESERVE_MAX_SWAP_USD: Max USDC to swap per rebalance (default: 100)
  // POL_RESERVE_CHECK_INTERVAL_MIN: How often to check (default: 5 minutes)
  // POL_RESERVE_SLIPPAGE_PCT: Slippage tolerance (default: 1%)
  if (envBool("POL_RESERVE_ENABLED") !== undefined)
    cfg.polReserve.enabled = envBool("POL_RESERVE_ENABLED")!;
  if (envNum("POL_RESERVE_TARGET") !== undefined)
    cfg.polReserve.targetPol = envNum("POL_RESERVE_TARGET")!;
  // NOTE: MIN_POL_RESERVE is a legacy/V1 compatibility alias for POL_RESERVE_TARGET.
  // Despite the "MIN" prefix, it configures the target POL balance (targetPol), not minPol.
  if (envNum("MIN_POL_RESERVE") !== undefined)
    cfg.polReserve.targetPol = envNum("MIN_POL_RESERVE")!;
  if (envNum("POL_RESERVE_MIN") !== undefined)
    cfg.polReserve.minPol = envNum("POL_RESERVE_MIN")!;
  if (envNum("POL_RESERVE_MAX_SWAP_USD") !== undefined)
    cfg.polReserve.maxSwapUsd = envNum("POL_RESERVE_MAX_SWAP_USD")!;
  if (envNum("POL_RESERVE_CHECK_INTERVAL_MIN") !== undefined)
    cfg.polReserve.checkIntervalMin = envNum("POL_RESERVE_CHECK_INTERVAL_MIN")!;
  if (envNum("POL_RESERVE_SLIPPAGE_PCT") !== undefined)
    cfg.polReserve.slippagePct = envNum("POL_RESERVE_SLIPPAGE_PCT")!;

  // Validate POL reserve configuration: targetPol must be greater than minPol
  if (
    cfg.polReserve.enabled &&
    cfg.polReserve.targetPol !== undefined &&
    cfg.polReserve.minPol !== undefined &&
    cfg.polReserve.targetPol <= cfg.polReserve.minPol
  ) {
    console.warn(
      `[config] Invalid POL reserve configuration: POL_RESERVE_TARGET (${cfg.polReserve.targetPol}) ` +
        `must be greater than POL_RESERVE_MIN (${cfg.polReserve.minPol}). Disabling POL reserve rebalancing.`,
    );
    cfg.polReserve.enabled = false;
  }

  // ========== DYNAMIC RESERVES (Risk-Aware Capital Allocation) ==========
  // DYNAMIC_RESERVES_ENABLED: Enable risk-aware reserve scaling based on position P&L
  // DYNAMIC_RESERVES_BASE_FLOOR_USD: Minimum reserve floor (default: from preset)
  // DYNAMIC_RESERVES_EQUITY_PCT: Reserve as % of equity (default: from preset)
  // DYNAMIC_RESERVES_MAX_USD: Cap on total reserve (default: from preset)
  // DYNAMIC_RESERVES_HEDGE_CAP_USD: Max per-position reserve (default: from preset)
  // DYNAMIC_RESERVES_HEDGE_TRIGGER_PCT: Loss % to trigger hedge-tier reserve (default: from preset)
  // DYNAMIC_RESERVES_CATASTROPHIC_PCT: Loss % for catastrophic-tier reserve (default: from preset)
  // DYNAMIC_RESERVES_HIGH_WIN_PRICE: Price threshold for high win probability (default: from preset)
  if (envBool("DYNAMIC_RESERVES_ENABLED") !== undefined)
    cfg.dynamicReserves.enabled = envBool("DYNAMIC_RESERVES_ENABLED")!;
  if (envNum("DYNAMIC_RESERVES_BASE_FLOOR_USD") !== undefined)
    cfg.dynamicReserves.baseReserveFloorUsd = envNum(
      "DYNAMIC_RESERVES_BASE_FLOOR_USD",
    )!;
  if (envNum("DYNAMIC_RESERVES_EQUITY_PCT") !== undefined)
    cfg.dynamicReserves.baseReserveEquityPct =
      envNum("DYNAMIC_RESERVES_EQUITY_PCT")! / 100;
  if (envNum("DYNAMIC_RESERVES_MAX_USD") !== undefined)
    cfg.dynamicReserves.maxReserveUsd = envNum("DYNAMIC_RESERVES_MAX_USD")!;
  if (envNum("DYNAMIC_RESERVES_HEDGE_CAP_USD") !== undefined)
    cfg.dynamicReserves.hedgeCapUsd = envNum("DYNAMIC_RESERVES_HEDGE_CAP_USD")!;
  if (envNum("DYNAMIC_RESERVES_HEDGE_TRIGGER_PCT") !== undefined)
    cfg.dynamicReserves.hedgeTriggerLossPct = envNum(
      "DYNAMIC_RESERVES_HEDGE_TRIGGER_PCT",
    )!;
  if (envNum("DYNAMIC_RESERVES_CATASTROPHIC_PCT") !== undefined)
    cfg.dynamicReserves.catastrophicLossPct = envNum(
      "DYNAMIC_RESERVES_CATASTROPHIC_PCT",
    )!;
  if (envNum("DYNAMIC_RESERVES_HIGH_WIN_PRICE") !== undefined)
    cfg.dynamicReserves.highWinProbPriceThreshold = envNum(
      "DYNAMIC_RESERVES_HIGH_WIN_PRICE",
    )!;

  // ========== PROFITABILITY OPTIMIZER ==========
  // PROFITABILITY_OPTIMIZER_ENABLED: Enable EV-based decision optimization
  // PROFITABILITY_OPTIMIZER_MIN_EV_USD: Minimum expected value to recommend an action
  // PROFITABILITY_OPTIMIZER_RISK_TOLERANCE: Risk tolerance factor (0-1, higher = more aggressive)
  // PROFITABILITY_OPTIMIZER_LOG_RECOMMENDATIONS: Log optimizer recommendations
  if (envBool("PROFITABILITY_OPTIMIZER_ENABLED") !== undefined) cfg.profitabilityOptimizer.enabled = envBool("PROFITABILITY_OPTIMIZER_ENABLED")!;
  if (envNum("PROFITABILITY_OPTIMIZER_MIN_EV_USD") !== undefined) cfg.profitabilityOptimizer.minExpectedValueUsd = envNum("PROFITABILITY_OPTIMIZER_MIN_EV_USD")!;
  if (envNum("PROFITABILITY_OPTIMIZER_RISK_TOLERANCE") !== undefined) cfg.profitabilityOptimizer.riskTolerance = envNum("PROFITABILITY_OPTIMIZER_RISK_TOLERANCE")!;
  if (envBool("PROFITABILITY_OPTIMIZER_LOG_RECOMMENDATIONS") !== undefined) cfg.profitabilityOptimizer.logRecommendations = envBool("PROFITABILITY_OPTIMIZER_LOG_RECOMMENDATIONS")!;

  // ========== LIVE TRADING ==========
  // V1: ARB_LIVE_TRADING=I_UNDERSTAND_THE_RISKS
  // V2: LIVE_TRADING=I_UNDERSTAND_THE_RISKS or LIVE_TRADING=true
  const liveVal = env("LIVE_TRADING") || env("ARB_LIVE_TRADING");
  const isLive =
    liveVal === "I_UNDERSTAND_THE_RISKS" ||
    liveVal === "true" ||
    liveVal === "1";

  // ========== LEADERBOARD ==========
  // V1: LEADERBOARD_LIMIT
  const leaderboardLimit = envNum("LEADERBOARD_LIMIT") || 20;

  return {
    privateKey,
    rpcUrl,
    preset,
    config: cfg,
    intervalMs:
      envNum("INTERVAL_MS") ||
      (envNum("FETCH_INTERVAL") ? envNum("FETCH_INTERVAL")! * 1000 : 5000),
    liveTrading: isLive,
    leaderboardLimit,
    telegram:
      (env("TELEGRAM_TOKEN") || env("TELEGRAM_BOT_TOKEN")) &&
      (env("TELEGRAM_CHAT") || env("TELEGRAM_CHAT_ID"))
        ? {
            token: (env("TELEGRAM_TOKEN") || env("TELEGRAM_BOT_TOKEN"))!,
            chatId: (env("TELEGRAM_CHAT") || env("TELEGRAM_CHAT_ID"))!,
            silent: !!envBool("TELEGRAM_SILENT"),
          }
        : undefined,
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
      const { capturePreVpnRouting, setupRpcVpnBypass } =
        await import("../utils/vpn-rpc-bypass.util");
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
        await setupRpcVpnBypass(
          logger as any,
          preVpnRouting.gateway,
          preVpnRouting.iface,
        );
        log("✅ RPC VPN bypass configured");
      }

      if (!state.vpnActive) {
        log("⚠️ VPN failed to start - you may be geoblocked!");
        await alertStatus(
          "⚠️ VPN failed to start - trading may fail due to geoblocking",
        );
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
    throw new Error(
      `Cannot proceed without valid credentials: ${authResult.error}`,
    );
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

  // Fetch initial POL balance for display
  await fetchPolBalance();

  // Initialize adaptive learner (V1 feature)
  if (settings.config.adaptiveLearning.enabled) {
    state.adaptiveLearner = getAdaptiveLearner(logger as any);
    log("🧠 Adaptive learning enabled");
  }

  // Initialize INITIAL_INVESTMENT_USD for overall P&L tracking
  const initialInvestmentStr = process.env.INITIAL_INVESTMENT_USD;
  if (initialInvestmentStr) {
    const parsed = parseFloat(initialInvestmentStr);
    if (!isNaN(parsed) && parsed > 0) {
      state.initialInvestment = parsed;
      log(`📈 Initial investment: ${$(parsed)} (tracking overall P&L)`);
    } else {
      log(
        `⚠️ Invalid INITIAL_INVESTMENT_USD: ${initialInvestmentStr} (must be positive number)`,
      );
    }
  }

  // Initialize profitability optimizer (V2 feature)
  if (settings.config.profitabilityOptimizer.enabled) {
    state.profitabilityOptimizer = createProfitabilityOptimizer({
      enabled: true,
      minExpectedValueUsd: settings.config.profitabilityOptimizer.minExpectedValueUsd,
      riskTolerance: settings.config.profitabilityOptimizer.riskTolerance,
    });
    log(`📊 Profitability optimizer enabled (minEV: $${settings.config.profitabilityOptimizer.minExpectedValueUsd}, risk: ${settings.config.profitabilityOptimizer.riskTolerance})`);
  }

  log(`Preset: ${settings.preset}`);
  log(`Wallet: ${addr.slice(0, 10)}...`);
  log(`Balance: ${$(state.balance)} (${settings.config.reservePct}% reserved)`);
  log(
    `POL: ${state.polBalance.toFixed(2)} (target: ${settings.config.polReserve.targetPol}, min: ${settings.config.polReserve.minPol})`,
  );
  log(`Trading: ${state.liveTrading ? "🟢 LIVE" : "🔸 SIMULATED"}`);
  log(
    `Mode: ${settings.config.tradeMode === "onchain" ? "⛓️ ON-CHAIN" : "📡 CLOB API"}`,
  );
  if (state.proxyAddress) log(`Proxy: ${state.proxyAddress.slice(0, 10)}...`);
  if (settings.config.copy.enabled)
    log(`👀 Copying ${settings.config.copy.addresses.length} trader(s)`);
  if (settings.config.polReserve.enabled)
    log(
      `⛽ POL Reserve enabled (target: ${settings.config.polReserve.targetPol} POL)`,
    );
  if (settings.config.dynamicReserves.enabled) {
    const dr = settings.config.dynamicReserves;
    log(
      `💰 Dynamic Reserves enabled (floor: $${dr.baseReserveFloorUsd}, max: $${dr.maxReserveUsd}, hedgeCap: $${dr.hedgeCapUsd})`,
    );
    log(
      `   Risk thresholds: hedgeTrigger: ${dr.hedgeTriggerLossPct}%, catastrophic: ${dr.catastrophicLossPct}%, highWinProb: ${(dr.highWinProbPriceThreshold * 100).toFixed(0)}¢`,
    );
  }

  await alertStatus(
    `Bot Started | ${settings.preset} | ${state.liveTrading ? "LIVE" : "SIM"} | ${$(state.balance)}`,
  );

  // ============ MAIN LOOP WITH IN-FLIGHT GUARD ============
  let cycleRunning = false;
  let skippedLogged = false;

  const runCycle = async () => {
    if (cycleRunning) {
      if (!skippedLogged) {
        log("⏳ Skipping cycle - previous still running");
        skippedLogged = true;
      }
      return;
    }
    cycleRunning = true;
    skippedLogged = false;
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
