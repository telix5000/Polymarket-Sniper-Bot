/**
 * On-Chain Event Monitor for Polymarket CTF Exchange
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ IMPORTANT: LIMITED USE CASE - RECONCILIATION ONLY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On-chain monitoring should ONLY be used for:
 * - OrderFilled event backfill
 * - Settlement verification
 * - Debugging discrepancies
 * - Monitoring YOUR OWN position changes
 *
 * On-chain monitoring should NOT be used for:
 * - Primary whale detection (use Data API instead)
 * - Trade execution triggers (use CLOB signals)
 * - Front-running (impossible - CLOB is off-chain)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE - Understanding the Data Flow
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POLYMARKET TRADING HAS THREE LAYERS:
 *
 * 1) DATA API (FAST SIGNAL) - Primary whale detection source
 *    - /trades endpoint shows WHO traded, DIRECTION, SIZE
 *    - This is the SOURCE OF TRUTH for whale activity
 *    - Faster than on-chain because CLOB updates API before settlement
 *
 * 2) CLOB (SCALPING & EXECUTION) - Where scalping happens
 *    - Order book pending LIMIT orders (not blockchain pending txs!)
 *    - Spread, depth, momentum analysis
 *    - clobClient for order placement
 *
 * 3) ON-CHAIN (SETTLEMENT / TRUTH) - This module
 *    - Polygon RPC - sees trades AFTER CLOB settlement
 *    - Used for verification and backfill ONLY
 *    - NOT faster than Data API for whale detection
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Features (for appropriate use cases):
 * - Position monitoring via Transfer events (CTF contract) - USEFUL
 * - OrderFilled events for reconciliation - USEFUL
 * - Whale trade detection - DEPRECATED (use Data API polling instead)
 *
 * Usage:
 *   const monitor = new OnChainMonitor(config);
 *   monitor.onPositionChange((change) => handlePositionUpdate(change)); // ✅ GOOD
 *   // monitor.onWhaleTrade() - DEPRECATED, use BiasAccumulator instead
 *   await monitor.start();
 */

import { ethers } from "ethers";
import { POLYGON } from "./constants";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Signal source indicator - for tracking where a signal originated
 * Note: Data API is the PRIMARY source; on-chain is for reconciliation only
 */
export type SignalSource = "onchain" | "api";

export interface OnChainTradeEvent {
  tokenId: string;
  maker: string;
  taker: string;
  side: "BUY" | "SELL";
  sizeUsd: number;
  price: number;
  timestamp: number;
  txHash: string;
  blockNumber: number;
  /** Signal source tracking (on-chain is secondary to Data API for whale detection) */
  source: SignalSource;
}

/**
 * Position change event from CTF contract Transfer events
 * Allows real-time monitoring of our own positions
 */
export interface PositionChangeEvent {
  tokenId: string;
  from: string;
  to: string;
  amount: bigint;
  amountFormatted: number;
  isIncoming: boolean; // true if we received tokens, false if we sent
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

/**
 * Price update from on-chain OrderFilled events
 * Used for reconciliation and verification (NOT primary price source)
 */
export interface OnChainPriceUpdate {
  tokenId: string;
  price: number; // 0-1 (e.g., 0.65 = 65¢)
  sizeUsd: number;
  timestamp: number;
  blockNumber: number;
  txHash: string;
  source: "onchain";
}

/**
 * Price deviance between on-chain and API prices
 * Positive deviance = on-chain is HIGHER than API (sell opportunity)
 * Negative deviance = on-chain is LOWER than API (buy opportunity)
 */
export interface PriceDeviance {
  tokenId: string;
  onChainPrice: number; // Last seen on-chain price
  apiPrice: number; // Current API/CLOB price
  devianceCents: number; // Difference in cents (onChain - api)
  deviancePct: number; // Percentage difference
  timestamp: number; // When deviance was calculated
  opportunity: "BUY" | "SELL" | "NONE"; // Which side benefits from this deviance
}

/**
 * Infura tier plans with their rate limits
 * Based on Infura's credit-based pricing model (2024):
 * - Core (Free): 500 credits/sec, 3M credits/day
 * - Developer ($50/mo): 4,000 credits/sec, 15M credits/day
 * - Team ($225/mo): 40,000 credits/sec, 75M credits/day
 * - Growth/Enterprise: Custom limits
 *
 * WebSocket subscriptions consume credits on subscribe/unsubscribe.
 * We adjust polling fallback frequency based on tier to avoid rate limits.
 */
export type InfuraTier = "core" | "developer" | "team" | "growth";

/**
 * Infura tier limits - Reference values for documentation
 *
 * NOTE: WebSocket event subscriptions are the primary mechanism and don't
 * consume credits per event (only per subscription). These limits are
 * documented for reference when implementing future polling fallbacks.
 *
 * Current implementation uses WebSocket subscriptions which are very
 * credit-efficient (10 credits per subscription, events are FREE).
 */
export interface InfuraTierLimits {
  creditsPerSecond: number;
  creditsPerDay: number;
}

/**
 * Infura tier reference limits
 *
 * WebSocket subscriptions are CHEAP (10 credits once) - events are FREE!
 * This is why we use WebSocket for monitoring instead of polling.
 */
export const INFURA_TIER_LIMITS: Record<InfuraTier, InfuraTierLimits> = {
  // FREE TIER: 3M credits/day, 500/sec burst
  core: {
    creditsPerSecond: 500,
    creditsPerDay: 3_000_000,
  },
  // DEVELOPER: 15M credits/day, 4,000/sec burst
  developer: {
    creditsPerSecond: 4_000,
    creditsPerDay: 15_000_000,
  },
  // TEAM: 75M credits/day, 40,000/sec burst
  team: {
    creditsPerSecond: 40_000,
    creditsPerDay: 75_000_000,
  },
  // GROWTH/ENTERPRISE: 200M+ credits/day, 100,000/sec burst
  growth: {
    creditsPerSecond: 100_000,
    creditsPerDay: 200_000_000,
  },
};

export interface OnChainMonitorConfig {
  /** WebSocket RPC URL (e.g., wss://polygon-mainnet.infura.io/ws/v3/YOUR_API_KEY) */
  wsRpcUrl?: string;
  /** HTTP RPC URL for fallback */
  httpRpcUrl: string;
  /** Set of whale wallet addresses to track (lowercase) */
  whaleWallets: Set<string>;
  /** Our wallet address to monitor for position changes (lowercase) */
  ourWallet?: string;
  /** Token IDs to watch for price updates (all trades, not just whales) */
  watchedTokens: Set<string>;
  /** Minimum trade size in USD to consider a whale trade */
  minWhaleTradeUsd: number;
  /** Enable/disable on-chain monitoring */
  enabled: boolean;
  /** Reconnect delay in ms after WebSocket disconnect */
  reconnectDelayMs: number;
  /** Max reconnect attempts before giving up */
  maxReconnectAttempts: number;
  /** Infura tier plan for rate limiting */
  infuraTier: InfuraTier;
}

type WhaleTradeCallback = (trade: OnChainTradeEvent) => void;
type PositionChangeCallback = (change: PositionChangeEvent) => void;
type PriceUpdateCallback = (update: OnChainPriceUpdate) => void;

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACT ABIs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OrderFilled event from CTF Exchange contract
 * Event signature: OrderFilled(bytes32 orderHash, address indexed maker, address indexed taker,
 *                              uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled,
 *                              uint256 takerAmountFilled, uint256 fee)
 */
const CTF_EXCHANGE_ABI = [
  "event OrderFilled(bytes32 orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
];

/**
 * CTF (Conditional Token Framework) contract - ERC1155
 * TransferSingle for individual transfers, TransferBatch for batches
 * We watch these to monitor our own position changes in real-time
 */
const CTF_TOKEN_ABI = [
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
];

// ═══════════════════════════════════════════════════════════════════════════
// ON-CHAIN MONITOR
// ═══════════════════════════════════════════════════════════════════════════

export class OnChainMonitor {
  private config: OnChainMonitorConfig;
  private wsProvider: ethers.WebSocketProvider | null = null;
  private exchangeContract: ethers.Contract | null = null;
  private negRiskExchangeContract: ethers.Contract | null = null;
  private ctfContract: ethers.Contract | null = null;
  private whaleTradeCallbacks: WhaleTradeCallback[] = [];
  private positionChangeCallbacks: PositionChangeCallback[] = [];
  private priceUpdateCallbacks: PriceUpdateCallback[] = [];
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // DIAGNOSTICS - Track event reception for debugging
  // ═══════════════════════════════════════════════════════════════════════════
  private eventCount = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // PRICE DEVIANCE TRACKING - Track on-chain prices to compare with API
  // ═══════════════════════════════════════════════════════════════════════════
  /** Last known on-chain prices by tokenId */
  private onChainPrices: Map<
    string,
    { price: number; timestamp: number; sizeUsd: number }
  > = new Map();
  /** Price staleness threshold - on-chain prices older than this are considered stale */
  private readonly PRICE_STALE_MS = 60000; // 1 minute

  constructor(config: OnChainMonitorConfig) {
    this.config = config;
  }

  /**
   * Register callback for whale trade events
   * These fire when tracked whales make trades - FASTER than API!
   */
  onWhaleTrade(callback: WhaleTradeCallback): void {
    this.whaleTradeCallbacks.push(callback);
  }

  /**
   * Register callback for our position changes
   * Fires when our wallet receives or sends position tokens
   */
  onPositionChange(callback: PositionChangeCallback): void {
    this.positionChangeCallbacks.push(callback);
  }

  /**
   * Register callback for real-time price updates on watched tokens
   * Fires for ALL trades on watched tokens - not just whales!
   * This is FASTER than polling Polymarket API for prices
   */
  onPriceUpdate(callback: PriceUpdateCallback): void {
    this.priceUpdateCallbacks.push(callback);
  }

  /**
   * Get last known on-chain price for a token
   * Returns null if no price is known or price is stale
   */
  getOnChainPrice(
    tokenId: string,
  ): { price: number; timestamp: number; sizeUsd: number } | null {
    const data = this.onChainPrices.get(tokenId);
    if (!data) return null;

    // Check if price is stale
    if (Date.now() - data.timestamp > this.PRICE_STALE_MS) {
      return null; // Too old to be useful
    }

    return data;
  }

  /**
   * Calculate price deviance between on-chain and API prices
   *
   * @param tokenId - The token to check
   * @param apiPrice - Current price from Polymarket API/CLOB (0-1 scale)
   * @returns PriceDeviance object or null if no on-chain price available
   *
   * TRADING IMPLICATIONS:
   * - Negative deviance (on-chain < API): BUY opportunity - use on-chain price for GTC
   * - Positive deviance (on-chain > API): SELL opportunity - use on-chain price for GTC
   */
  calculateDeviance(tokenId: string, apiPrice: number): PriceDeviance | null {
    const onChainData = this.getOnChainPrice(tokenId);
    if (!onChainData) return null;

    const onChainPrice = onChainData.price;
    const devianceCents = (onChainPrice - apiPrice) * 100;
    const deviancePct =
      apiPrice > 0 ? ((onChainPrice - apiPrice) / apiPrice) * 100 : 0;

    // Determine opportunity direction
    // If on-chain is lower, it's a buy opportunity (buy at lower on-chain price)
    // If on-chain is higher, it's a sell opportunity (sell at higher on-chain price)
    let opportunity: "BUY" | "SELL" | "NONE" = "NONE";
    if (Math.abs(devianceCents) >= 0.5) {
      // At least 0.5¢ deviance to matter
      opportunity = devianceCents < 0 ? "BUY" : "SELL";
    }

    return {
      tokenId,
      onChainPrice,
      apiPrice,
      devianceCents,
      deviancePct,
      timestamp: Date.now(),
      opportunity,
    };
  }

  /**
   * Get all current price deviances for watched tokens
   * Useful for status reporting
   */
  getAllDeviances(apiPrices: Map<string, number>): PriceDeviance[] {
    const deviances: PriceDeviance[] = [];

    for (const [tokenId, apiPrice] of apiPrices) {
      const deviance = this.calculateDeviance(tokenId, apiPrice);
      if (deviance) {
        deviances.push(deviance);
      }
    }

    return deviances;
  }

  /**
   * Get recommended GTC price based on deviance
   * Returns the better of on-chain or API price for the given side
   *
   * @param tokenId - Token to get price for
   * @param apiPrice - Current API price
   * @param side - "BUY" or "SELL"
   * @returns Recommended price for GTC order (takes the favorable price)
   */
  getRecommendedGtcPrice(
    tokenId: string,
    apiPrice: number,
    side: "BUY" | "SELL",
  ): number {
    const onChainData = this.getOnChainPrice(tokenId);
    if (!onChainData) return apiPrice; // No on-chain data, use API price

    const onChainPrice = onChainData.price;

    if (side === "BUY") {
      // For buys, we want the LOWER price (pay less)
      return Math.min(onChainPrice, apiPrice);
    } else {
      // For sells, we want the HIGHER price (receive more)
      return Math.max(onChainPrice, apiPrice);
    }
  }

  /**
   * Add a token to watch for real-time price updates
   * Call this when you open a position to get instant price monitoring
   */
  watchToken(tokenId: string): void {
    this.config.watchedTokens.add(tokenId);
  }

  /**
   * Stop watching a token for price updates
   * Call this when you close a position
   */
  unwatchToken(tokenId: string): void {
    this.config.watchedTokens.delete(tokenId);
  }

  /**
   * Get currently watched tokens
   */
  getWatchedTokens(): Set<string> {
    return this.config.watchedTokens;
  }

  /**
   * Start monitoring on-chain events - runs in PARALLEL
   */
  async start(): Promise<boolean> {
    if (!this.config.enabled) {
      console.log("📡 On-chain monitoring disabled");
      return false;
    }

    if (!this.config.wsRpcUrl) {
      console.log(
        "📡 On-chain monitoring: No WebSocket URL configured, skipping",
      );
      return false;
    }

    if (this.running) {
      console.log("📡 On-chain monitoring already running");
      return true;
    }

    try {
      await this.connect();
      this.running = true;
      const tierLimits = INFURA_TIER_LIMITS[this.config.infuraTier];
      console.log(
        `📡 On-chain monitoring started (Infura tier: ${this.config.infuraTier}, ${tierLimits.creditsPerSecond} credits/sec)`,
      );
      return true;
    } catch (err) {
      console.error(
        `📡 On-chain monitoring failed to start: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    this.running = false;
    this.cleanup();
    console.log("📡 On-chain monitoring stopped");
  }

  /**
   * Check if monitoring is active
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Update whale wallets to track
   */
  updateWhaleWallets(wallets: Set<string>): void {
    this.config.whaleWallets = wallets;
  }

  /**
   * Get the tier limits for the configured Infura plan
   */
  getTierLimits(): InfuraTierLimits {
    return INFURA_TIER_LIMITS[this.config.infuraTier];
  }

  /**
   * Get stats about the monitor
   */
  getStats(): {
    running: boolean;
    connected: boolean;
    eventsReceived: number;
    reconnectAttempts: number;
    trackedWallets: number;
    monitoringOwnPositions: boolean;
    infuraTier: InfuraTier;
    tierLimits: InfuraTierLimits;
  } {
    return {
      running: this.running,
      connected: this.wsProvider !== null,
      eventsReceived: this.eventCount,
      reconnectAttempts: this.reconnectAttempts,
      trackedWallets: this.config.whaleWallets.size,
      monitoringOwnPositions: !!this.config.ourWallet,
      infuraTier: this.config.infuraTier,
      tierLimits: this.getTierLimits(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  private async connect(): Promise<void> {
    this.cleanup();

    const wsUrl = this.config.wsRpcUrl;
    if (!wsUrl) {
      throw new Error("WebSocket RPC URL not configured");
    }

    console.log(
      `📡 [WS] Connecting to WebSocket: ${wsUrl.replace(/\/[a-f0-9]{32}/i, "/[API_KEY]")}`,
    );

    // Create WebSocket provider
    this.wsProvider = new ethers.WebSocketProvider(wsUrl);

    // In ethers v6, we use provider events for connection state
    // The provider emits "error" events on connection issues
    this.wsProvider.on("error", (err: Error) => {
      console.error(`📡 [WS] WebSocket error: ${err.message}`);
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    // Wait for the provider to be ready
    console.log(`📡 [WS] Waiting for provider ready...`);
    await this.wsProvider.ready;
    console.log(`📡 [WS] Provider ready! WebSocket connected.`);

    // ═══════════════════════════════════════════════════════════════════════
    // SUBSCRIBE TO CTF EXCHANGE - Whale trade detection
    // Monitor BOTH standard and negative risk exchanges to catch ALL trades
    // ═══════════════════════════════════════════════════════════════════════
    this.exchangeContract = new ethers.Contract(
      POLYGON.CTF_EXCHANGE,
      CTF_EXCHANGE_ABI,
      this.wsProvider,
    );
    this.exchangeContract.on("OrderFilled", this.handleOrderFilled.bind(this));
    console.log(
      `📡 [WS] Subscribed to OrderFilled on CTF Exchange at ${POLYGON.CTF_EXCHANGE}`,
    );

    // Also subscribe to NEG_RISK_CTF_EXCHANGE for negative risk markets
    this.negRiskExchangeContract = new ethers.Contract(
      POLYGON.NEG_RISK_CTF_EXCHANGE,
      CTF_EXCHANGE_ABI,
      this.wsProvider,
    );
    this.negRiskExchangeContract.on(
      "OrderFilled",
      this.handleOrderFilled.bind(this),
    );
    console.log(
      `📡 [WS] Subscribed to OrderFilled on NEG_RISK Exchange at ${POLYGON.NEG_RISK_CTF_EXCHANGE}`,
    );

    // Log whale tracking status
    console.log(
      `📡 [WS] Tracking ${this.config.whaleWallets.size} whale wallets | Min trade: $${this.config.minWhaleTradeUsd}`,
    );
    console.log(
      `📡 [WS] ⚡ On-chain monitoring ACTIVE - will log first 5 events then every 100th`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // SUBSCRIBE TO CTF TOKEN - Our position monitoring (if wallet configured)
    // Use filtered subscriptions to only receive events for our wallet
    // ═══════════════════════════════════════════════════════════════════════
    if (this.config.ourWallet) {
      this.ctfContract = new ethers.Contract(
        POLYGON.CTF_ADDRESS,
        CTF_TOKEN_ABI,
        this.wsProvider,
      );

      const wallet = this.config.ourWallet;

      // Subscribe to TransferSingle events involving our wallet
      // Incoming transfers: to == wallet
      const transferSingleIncomingFilter =
        this.ctfContract.filters.TransferSingle(null, null, wallet);
      this.ctfContract.on(
        transferSingleIncomingFilter,
        this.handleTransferSingle.bind(this),
      );

      // Outgoing transfers: from == wallet
      const transferSingleOutgoingFilter =
        this.ctfContract.filters.TransferSingle(null, wallet, null);
      this.ctfContract.on(
        transferSingleOutgoingFilter,
        this.handleTransferSingle.bind(this),
      );

      // Subscribe to TransferBatch events involving our wallet
      // Incoming transfers: to == wallet
      const transferBatchIncomingFilter =
        this.ctfContract.filters.TransferBatch(null, null, wallet);
      this.ctfContract.on(
        transferBatchIncomingFilter,
        this.handleTransferBatch.bind(this),
      );

      // Outgoing transfers: from == wallet
      const transferBatchOutgoingFilter =
        this.ctfContract.filters.TransferBatch(null, wallet, null);
      this.ctfContract.on(
        transferBatchOutgoingFilter,
        this.handleTransferBatch.bind(this),
      );

      console.log(
        `📡 Position monitoring enabled for ${this.config.ourWallet.slice(0, 8)}...`,
      );
    }

    // Reset reconnect attempts on successful connection
    this.reconnectAttempts = 0;

    console.log(`📡 Connected to CTF Exchange at ${POLYGON.CTF_EXCHANGE}`);
    console.log(
      `📡 Connected to NEG_RISK Exchange at ${POLYGON.NEG_RISK_CTF_EXCHANGE}`,
    );
  }

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.exchangeContract) {
      this.exchangeContract.removeAllListeners();
      this.exchangeContract = null;
    }

    if (this.negRiskExchangeContract) {
      this.negRiskExchangeContract.removeAllListeners();
      this.negRiskExchangeContract = null;
    }

    if (this.ctfContract) {
      this.ctfContract.removeAllListeners();
      this.ctfContract = null;
    }

    if (this.wsProvider) {
      this.wsProvider.destroy();
      this.wsProvider = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(
        `📡 Max reconnect attempts (${this.config.maxReconnectAttempts}) reached, giving up`,
      );
      this.cleanup(); // Ensure timer is cleared
      this.running = false;
      return;
    }

    this.reconnectAttempts++;
    const delay =
      this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    console.log(
      `📡 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.log("📡 Reconnected successfully");
      } catch (err) {
        console.error(
          `📡 Reconnect failed: ${err instanceof Error ? err.message : err}`,
        );
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async handleOrderFilled(
    orderHash: string,
    maker: string,
    taker: string,
    makerAssetId: bigint,
    takerAssetId: bigint,
    makerAmountFilled: bigint,
    takerAmountFilled: bigint,
    fee: bigint,
    event: ethers.EventLog,
  ): Promise<void> {
    // ═══════════════════════════════════════════════════════════════════════════
    // DIAGNOSTIC: Count ALL events received to verify WebSocket is working
    // ═══════════════════════════════════════════════════════════════════════════
    this.eventCount++;
    if (this.eventCount <= 5 || this.eventCount % 100 === 0) {
      console.log(
        `📡 [EVENT #${this.eventCount}] OrderFilled received | Block: ${event.blockNumber} | TxHash: ${event.transactionHash.slice(0, 16)}...`,
      );
    }

    try {
      // CTF Exchange: one asset is the outcome token, the other is USDC collateral.
      // Protocol invariant: USDC collateral has asset ID 0n, outcome tokens are non-zero.
      const USDC_ASSET_ID = 0n;
      const isMakerUsdc = makerAssetId === USDC_ASSET_ID;
      const isTakerUsdc = takerAssetId === USDC_ASSET_ID;

      if (!isMakerUsdc && !isTakerUsdc) {
        // Neither side is USDC – skip (might be a different trade type)
        return;
      }

      if (isMakerUsdc && isTakerUsdc) {
        // Both sides look like USDC – cannot determine outcome token
        return;
      }

      const isOutcomeTokenMakerSide = !isMakerUsdc;
      const tokenId = isOutcomeTokenMakerSide
        ? makerAssetId.toString()
        : takerAssetId.toString();

      // Calculate trade size in USD (USDC has 6 decimals)
      const usdAmount = isOutcomeTokenMakerSide
        ? takerAmountFilled
        : makerAmountFilled;
      const sizeUsd = Number(usdAmount) / 1e6;

      // Calculate price (outcome tokens have same decimals as USDC)
      const outcomeAmount = isOutcomeTokenMakerSide
        ? makerAmountFilled
        : takerAmountFilled;
      const price =
        outcomeAmount > 0n ? Number(usdAmount) / Number(outcomeAmount) : 0;

      const timestamp = Date.now();

      // ═══════════════════════════════════════════════════════════════════════
      // ALWAYS track on-chain price for deviance calculation
      // This is the SOURCE OF TRUTH - what actually traded on-chain
      // Use this to scope GTC orders ahead of the market!
      // ═══════════════════════════════════════════════════════════════════════
      if (price > 0 && sizeUsd >= 10) {
        // Only track meaningful trades ($10+)
        this.onChainPrices.set(tokenId, {
          price,
          timestamp,
          sizeUsd,
        });
      }

      // Check if this is a whale trade
      const makerLower = maker.toLowerCase();
      const takerLower = taker.toLowerCase();

      const isMakerWhale = this.config.whaleWallets.has(makerLower);
      const isTakerWhale = this.config.whaleWallets.has(takerLower);

      // DEBUG: Log all trades $50+ to help diagnose if whale detection is working
      // This helps identify if whales ARE trading but being filtered
      if (sizeUsd >= 50) {
        const whaleStatus =
          isMakerWhale || isTakerWhale
            ? `🐋 WHALE (${isMakerWhale ? "maker" : "taker"})`
            : `👤 non-whale`;
        const thresholdStatus =
          sizeUsd >= this.config.minWhaleTradeUsd
            ? "✓ meets threshold"
            : `✗ below $${this.config.minWhaleTradeUsd}`;
        console.log(
          `📡 Trade $${sizeUsd.toFixed(0)} | ${whaleStatus} | ${thresholdStatus} | ` +
            `maker:${makerLower.slice(0, 8)}... taker:${takerLower.slice(0, 8)}...`,
        );
      }

      // Skip whale callbacks if not a whale trade or too small
      if (!isMakerWhale && !isTakerWhale) {
        return;
      }

      if (sizeUsd < this.config.minWhaleTradeUsd) {
        return;
      }

      // Determine side from whale's perspective
      // If whale is maker and selling outcome tokens → SELL
      // If whale is taker and buying outcome tokens → BUY
      // NOTE: If both are whales, we record from maker's perspective only
      // to avoid double-counting. Whale-to-whale trades are counted once.
      let side: "BUY" | "SELL";
      let whaleWallet: string;

      if (isMakerWhale) {
        side = isOutcomeTokenMakerSide ? "SELL" : "BUY";
        whaleWallet = maker;
      } else {
        side = isOutcomeTokenMakerSide ? "BUY" : "SELL";
        whaleWallet = taker;
      }

      const tradeEvent: OnChainTradeEvent = {
        tokenId,
        maker,
        taker,
        side,
        sizeUsd,
        price,
        timestamp,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        source: "onchain",
      };

      console.log(
        `📡 Whale ${side} | ${whaleWallet.slice(0, 8)}... | ` +
          `$${sizeUsd.toFixed(0)} @ ${(price * 100).toFixed(1)}¢ | ` +
          `token:${tokenId.slice(0, 8)}...`,
      );

      // Fire callbacks - these are NON-BLOCKING
      for (const callback of this.whaleTradeCallbacks) {
        try {
          callback(tradeEvent);
        } catch (err) {
          console.error(
            `📡 Callback error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `📡 Error processing OrderFilled: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Handle ERC1155 TransferSingle event for position monitoring
   * Fires when a single token type is transferred
   */
  private async handleTransferSingle(
    operator: string | undefined,
    from: string | undefined,
    to: string | undefined,
    id: bigint,
    value: bigint,
    event: ethers.EventLog,
  ): Promise<void> {
    await this.processPositionTransfer(from, to, id, value, event);
  }

  /**
   * Handle ERC1155 TransferBatch event for position monitoring
   * Fires when multiple token types are transferred at once
   */
  private async handleTransferBatch(
    operator: string | undefined,
    from: string | undefined,
    to: string | undefined,
    ids: bigint[],
    values: bigint[],
    event: ethers.EventLog,
  ): Promise<void> {
    // Process each transfer in the batch in parallel
    await Promise.all(
      ids.map((id, index) =>
        this.processPositionTransfer(from, to, id, values[index], event),
      ),
    );
  }

  /**
   * Process a position transfer and fire callbacks if it involves our wallet
   */
  private async processPositionTransfer(
    from: string | undefined,
    to: string | undefined,
    tokenId: bigint,
    amount: bigint,
    event: ethers.EventLog,
  ): Promise<void> {
    // Note: With filtered subscriptions, we only receive events for our wallet
    // The filter ensures from==wallet OR to==wallet, so no additional check needed
    if (!this.config.ourWallet) return;

    // Defensive check: skip if from or to is undefined (malformed event)
    if (!from || !to) {
      console.warn(
        `📡 Skipping malformed transfer event: from=${from}, to=${to}, ` +
          `txHash=${event.transactionHash}, block=${event.blockNumber}, tokenId=${tokenId}`,
      );
      return;
    }

    const ourWalletLower = this.config.ourWallet.toLowerCase();
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    const isIncoming = toLower === ourWalletLower;
    const isOutgoing = fromLower === ourWalletLower;

    // Defensive check (should be guaranteed by filter)
    if (!isIncoming && !isOutgoing) return;

    try {
      // Use Date.now() to avoid RPC call latency from getBlock()
      const timestamp = Date.now();

      const positionChange: PositionChangeEvent = {
        tokenId: tokenId.toString(),
        from,
        to,
        amount,
        amountFormatted: Number(amount) / 1e6, // CTF tokens have 6 decimals
        isIncoming,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        timestamp,
      };

      const direction = isIncoming ? "RECEIVED" : "SENT";
      console.log(
        `📡 Position ${direction} | ${positionChange.amountFormatted.toFixed(2)} tokens | ` +
          `token:${tokenId.toString().slice(0, 8)}... | block:${event.blockNumber}`,
      );

      // Fire callbacks - NON-BLOCKING
      for (const callback of this.positionChangeCallbacks) {
        try {
          callback(positionChange);
        } catch (err) {
          console.error(
            `📡 Position callback error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `📡 Error processing position transfer: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract WebSocket URL from HTTP RPC URL
 * Converts https://...infura.io/v3/KEY to wss://...infura.io/ws/v3/KEY
 */
export function httpToWsUrl(httpUrl: string): string | null {
  try {
    const url = new URL(httpUrl);

    // Only support Infura for WebSocket - strict hostname check
    // Must end with .infura.io to prevent subdomain attacks
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith(".infura.io") && hostname !== "infura.io") {
      return null;
    }

    // Convert https to wss and add /ws/ path segment
    url.protocol = "wss:";
    url.pathname = url.pathname.replace("/v3/", "/ws/v3/");

    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Parse Infura tier from environment variable
 */
export function parseInfuraTier(tierStr?: string): InfuraTier {
  const normalized = (tierStr || "").toLowerCase().trim();
  if (normalized === "developer" || normalized === "dev") return "developer";
  if (normalized === "team") return "team";
  if (normalized === "growth" || normalized === "enterprise") return "growth";
  return "core"; // Default to free tier
}

/**
 * Create default on-chain monitor config from environment
 *
 * @param httpRpcUrl - HTTP RPC URL (will auto-convert to WebSocket for Infura)
 * @param whaleWallets - Set of whale wallet addresses to track
 * @param ourWallet - Our wallet address to monitor position changes (optional)
 * @param options - Additional config overrides
 */
export function createOnChainMonitorConfig(
  httpRpcUrl: string,
  whaleWallets: Set<string> = new Set(),
  ourWallet?: string,
  options: Partial<OnChainMonitorConfig> = {},
): OnChainMonitorConfig {
  const wsRpcUrl = process.env.WS_RPC_URL || httpToWsUrl(httpRpcUrl);
  const enabled = process.env.ONCHAIN_MONITOR_ENABLED !== "false" && !!wsRpcUrl;
  const infuraTier = parseInfuraTier(process.env.INFURA_TIER);

  return {
    wsRpcUrl: wsRpcUrl || undefined,
    httpRpcUrl,
    whaleWallets,
    ourWallet: ourWallet?.toLowerCase(),
    watchedTokens: new Set(), // Start empty, tokens added when positions opened
    // Support both WHALE_TRADE_USD (simpler) and ONCHAIN_MIN_WHALE_TRADE_USD (legacy)
    minWhaleTradeUsd: Number(
      process.env.WHALE_TRADE_USD ??
        process.env.ONCHAIN_MIN_WHALE_TRADE_USD ??
        500,
    ),
    enabled,
    reconnectDelayMs: Number(process.env.ONCHAIN_RECONNECT_DELAY_MS) || 1000,
    maxReconnectAttempts:
      Number(process.env.ONCHAIN_MAX_RECONNECT_ATTEMPTS) || 10,
    infuraTier,
    ...options,
  };
}
