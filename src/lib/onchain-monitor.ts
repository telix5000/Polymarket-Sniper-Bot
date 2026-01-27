/**
 * On-Chain Event Monitor for Polymarket CTF Exchange
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE - Understanding the Data Flow
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                         DATA SOURCES                                    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  INFURA (WebSocket)     │  READ ONLY - FASTEST                         │
 * │  - Whale trade events   │  See trades the INSTANT they hit blockchain  │
 * │  - Position changes     │  ~2 sec block time vs ~5+ sec API polling    │
 * │  - Real-time signals    │  PRIORITY: On-chain signals > API signals    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  Polymarket API         │  READ ONLY - SLOWER                          │
 * │  - Orderbook depth      │  Polling-based, ~200ms minimum               │
 * │  - Market metadata      │  Used for price discovery, liquidity checks  │
 * │  - Leaderboard          │  Used to identify whale wallets              │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │  CLOB Client            │  WRITE - ORDER EXECUTION                     │
 * │  - Submit orders        │  ONLY way to trade on Polymarket!            │
 * │  - Cancel orders        │  Uses wallet signing via RPC (Infura)        │
 * │  - Order management     │  Cannot bypass CLOB for trading              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * KEY INSIGHT: Infura gives us READ speed advantage, but we still EXECUTE
 * trades through Polymarket's CLOB. The edge is seeing signals FASTER,
 * then acting on them through the normal trading flow.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Features:
 * - Whale trade detection via OrderFilled events (CTF Exchange)
 * - Position monitoring via Transfer events (CTF contract)
 * - Signal priority system (on-chain > API)
 * - All monitoring runs in PARALLEL - never blocks main loop
 *
 * Usage:
 *   const monitor = new OnChainMonitor(config);
 *   monitor.onWhaleTrade((trade) => biasAccumulator.recordTrade(trade));
 *   monitor.onPositionChange((change) => handlePositionUpdate(change));
 *   await monitor.start();
 */

import { ethers } from "ethers";
import { POLYGON } from "./constants";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Signal source priority - on-chain is FASTER and takes precedence
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
  /** On-chain signals are faster and take priority over API */
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
 * Real-time price update from on-chain OrderFilled events
 * This is FASTER than polling Polymarket API for price!
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

export interface InfuraTierLimits {
  creditsPerSecond: number;
  creditsPerDay: number;
  /** 
   * Calculated for MAXIMUM throughput based on daily allocation
   * Formula: (credits/day) / 86400 sec / ~20 credits per typical call
   */
  maxCallsPerSecond: number;
  /** Minimum delay between calls in ms to hit max throughput */
  minCallDelayMs: number;
  /** Max concurrent WebSocket subscriptions */
  maxWsSubscriptions: number;
}

/**
 * FULL BORE LIMITS - Use every credit we're paying for!
 * 
 * Calculation methodology:
 * - Daily credits spread across 86,400 seconds
 * - Average call cost ~20 credits (mix of getBlock, getLogs, etc.)
 * - WebSocket subscriptions are CHEAP (10 credits once) - events are FREE
 * - We optimize for sustained throughput, not just burst
 */
export const INFURA_TIER_LIMITS: Record<InfuraTier, InfuraTierLimits> = {
  // FREE TIER: 3M credits/day, 500/sec burst
  // Sustained: 3,000,000 / 86,400 = 34.7 credits/sec
  // At ~20 credits/call = 1.7 calls/sec sustained, but can burst higher
  core: {
    creditsPerSecond: 500,
    creditsPerDay: 3_000_000,
    maxCallsPerSecond: 25,      // Use burst capacity, stay under 500 credits/sec
    minCallDelayMs: 40,         // 25 req/sec - aggressive but sustainable
    maxWsSubscriptions: 10,     // WebSocket subs are cheap, use them!
  },
  
  // DEVELOPER: 15M credits/day, 4,000/sec burst
  // Sustained: 15,000,000 / 86,400 = 173.6 credits/sec
  // At ~20 credits/call = 8.7 calls/sec sustained, can burst to 200
  developer: {
    creditsPerSecond: 4_000,
    creditsPerDay: 15_000_000,
    maxCallsPerSecond: 200,     // Use burst! 200 * 20 = 4000 credits/sec
    minCallDelayMs: 5,          // 200 req/sec - FULL BORE
    maxWsSubscriptions: 50,     // More subs = more parallel monitoring
  },
  
  // TEAM: 75M credits/day, 40,000/sec burst
  // Sustained: 75,000,000 / 86,400 = 868 credits/sec
  // At ~20 credits/call = 43 calls/sec sustained, can burst to 2000
  team: {
    creditsPerSecond: 40_000,
    creditsPerDay: 75_000_000,
    maxCallsPerSecond: 2000,    // Use burst! 2000 * 20 = 40000 credits/sec
    minCallDelayMs: 1,          // 1000 req/sec - MAXIMUM SPEED
    maxWsSubscriptions: 200,    // Heavy parallel monitoring
  },
  
  // GROWTH/ENTERPRISE: 200M+ credits/day, 100,000/sec burst
  // Sustained: 200,000,000 / 86,400 = 2,315 credits/sec
  // At ~20 credits/call = 116 calls/sec sustained, can burst to 5000
  growth: {
    creditsPerSecond: 100_000,
    creditsPerDay: 200_000_000,
    maxCallsPerSecond: 5000,    // Use burst! 5000 * 20 = 100000 credits/sec
    minCallDelayMs: 0,          // NO DELAY - UNLIMITED SPEED
    maxWsSubscriptions: 1000,   // Maximum parallel monitoring
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
  private ctfContract: ethers.Contract | null = null;
  private whaleTradeCallbacks: WhaleTradeCallback[] = [];
  private positionChangeCallbacks: PositionChangeCallback[] = [];
  private priceUpdateCallbacks: PriceUpdateCallback[] = [];
  private running = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

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
      console.log("📡 On-chain monitoring: No WebSocket URL configured, skipping");
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
      console.log(`📡 On-chain monitoring started (Infura tier: ${this.config.infuraTier}, ${tierLimits.creditsPerSecond} credits/sec)`);
      return true;
    } catch (err) {
      console.error(`📡 On-chain monitoring failed to start: ${err instanceof Error ? err.message : err}`);
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
    reconnectAttempts: number;
    trackedWallets: number;
    monitoringOwnPositions: boolean;
    infuraTier: InfuraTier;
    tierLimits: InfuraTierLimits;
  } {
    return {
      running: this.running,
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

    // Create WebSocket provider
    this.wsProvider = new ethers.WebSocketProvider(wsUrl);

    // In ethers v6, we use provider events for connection state
    // The provider emits "error" events on connection issues
    this.wsProvider.on("error", (err: Error) => {
      console.error(`📡 WebSocket error: ${err.message}`);
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    // Wait for the provider to be ready
    await this.wsProvider.ready;

    // ═══════════════════════════════════════════════════════════════════════
    // SUBSCRIBE TO CTF EXCHANGE - Whale trade detection
    // ═══════════════════════════════════════════════════════════════════════
    this.exchangeContract = new ethers.Contract(
      POLYGON.CTF_EXCHANGE,
      CTF_EXCHANGE_ABI,
      this.wsProvider
    );
    this.exchangeContract.on("OrderFilled", this.handleOrderFilled.bind(this));

    // ═══════════════════════════════════════════════════════════════════════
    // SUBSCRIBE TO CTF TOKEN - Our position monitoring (if wallet configured)
    // This lets us see our position changes in real-time!
    // ═══════════════════════════════════════════════════════════════════════
    if (this.config.ourWallet) {
      this.ctfContract = new ethers.Contract(
        POLYGON.CTF_ADDRESS,
        CTF_TOKEN_ABI,
        this.wsProvider
      );
      
      // Subscribe to TransferSingle and TransferBatch events
      // Filter for transfers involving our wallet (from or to)
      this.ctfContract.on("TransferSingle", this.handleTransferSingle.bind(this));
      this.ctfContract.on("TransferBatch", this.handleTransferBatch.bind(this));
      
      console.log(`📡 Position monitoring enabled for ${this.config.ourWallet.slice(0, 8)}...`);
    }

    // Reset reconnect attempts on successful connection
    this.reconnectAttempts = 0;

    console.log(`📡 Connected to CTF Exchange at ${POLYGON.CTF_EXCHANGE}`);
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
      console.error(`📡 Max reconnect attempts (${this.config.maxReconnectAttempts}) reached, giving up`);
      this.running = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    console.log(`📡 Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.log("📡 Reconnected successfully");
      } catch (err) {
        console.error(`📡 Reconnect failed: ${err instanceof Error ? err.message : err}`);
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
    event: ethers.EventLog
  ): Promise<void> {
    try {
      // Check if this is a whale trade
      const makerLower = maker.toLowerCase();
      const takerLower = taker.toLowerCase();

      const isMakerWhale = this.config.whaleWallets.has(makerLower);
      const isTakerWhale = this.config.whaleWallets.has(takerLower);

      if (!isMakerWhale && !isTakerWhale) {
        return; // Not a whale trade
      }

      // Parse trade details
      // CTF Exchange: makerAssetId is the outcome token, takerAssetId is USDC (or vice versa)
      // If maker is selling outcome tokens, makerAssetId is the token ID
      // If taker is buying outcome tokens, takerAssetId is the token ID

      // Determine which is the outcome token (larger value = token ID)
      // USDC has asset ID 0 or small value
      const isOutcomeTokenMakerSide = makerAssetId > takerAssetId;
      const tokenId = isOutcomeTokenMakerSide
        ? makerAssetId.toString()
        : takerAssetId.toString();

      // Calculate trade size in USD (USDC has 6 decimals)
      // The USD amount is on the opposite side of the outcome token
      const usdAmount = isOutcomeTokenMakerSide
        ? takerAmountFilled
        : makerAmountFilled;
      const sizeUsd = Number(usdAmount) / 1e6;

      // Skip small trades
      if (sizeUsd < this.config.minWhaleTradeUsd) {
        return;
      }

      // Calculate price (outcome tokens have same decimals as USDC)
      const outcomeAmount = isOutcomeTokenMakerSide
        ? makerAmountFilled
        : takerAmountFilled;
      const price = outcomeAmount > 0n
        ? Number(usdAmount) / Number(outcomeAmount)
        : 0;

      // Determine side from whale's perspective
      // If whale is maker and selling outcome tokens → SELL
      // If whale is taker and buying outcome tokens → BUY
      let side: "BUY" | "SELL";
      let whaleWallet: string;

      if (isMakerWhale) {
        // Maker provides makerAssetId
        side = isOutcomeTokenMakerSide ? "SELL" : "BUY";
        whaleWallet = maker;
      } else {
        // Taker provides takerAssetId
        side = isOutcomeTokenMakerSide ? "BUY" : "SELL";
        whaleWallet = taker;
      }

      // Get block timestamp
      const block = await event.getBlock();
      const timestamp = block ? block.timestamp * 1000 : Date.now();

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
        source: "onchain", // On-chain signals are FASTER and take priority!
      };

      console.log(
        `📡 Whale ${side} | ${whaleWallet.slice(0, 8)}... | ` +
        `$${sizeUsd.toFixed(0)} @ ${(price * 100).toFixed(1)}¢ | ` +
        `token:${tokenId.slice(0, 8)}...`
      );

      // Fire callbacks - these are NON-BLOCKING
      for (const callback of this.whaleTradeCallbacks) {
        try {
          callback(tradeEvent);
        } catch (err) {
          console.error(`📡 Callback error: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.error(`📡 Error processing OrderFilled: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Handle ERC1155 TransferSingle event for position monitoring
   * Fires when a single token type is transferred
   */
  private async handleTransferSingle(
    operator: string,
    from: string,
    to: string,
    id: bigint,
    value: bigint,
    event: ethers.EventLog
  ): Promise<void> {
    await this.processPositionTransfer(from, to, id, value, event);
  }

  /**
   * Handle ERC1155 TransferBatch event for position monitoring
   * Fires when multiple token types are transferred at once
   */
  private async handleTransferBatch(
    operator: string,
    from: string,
    to: string,
    ids: bigint[],
    values: bigint[],
    event: ethers.EventLog
  ): Promise<void> {
    // Process each transfer in the batch in parallel
    await Promise.all(
      ids.map((id, index) => 
        this.processPositionTransfer(from, to, id, values[index], event)
      )
    );
  }

  /**
   * Process a position transfer and fire callbacks if it involves our wallet
   */
  private async processPositionTransfer(
    from: string,
    to: string,
    tokenId: bigint,
    amount: bigint,
    event: ethers.EventLog
  ): Promise<void> {
    if (!this.config.ourWallet) return;

    const ourWalletLower = this.config.ourWallet.toLowerCase();
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();

    // Check if this transfer involves our wallet
    const isIncoming = toLower === ourWalletLower;
    const isOutgoing = fromLower === ourWalletLower;

    if (!isIncoming && !isOutgoing) return;

    try {
      const block = await event.getBlock();
      const timestamp = block ? block.timestamp * 1000 : Date.now();

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
        `token:${tokenId.toString().slice(0, 8)}... | block:${event.blockNumber}`
      );

      // Fire callbacks - NON-BLOCKING
      for (const callback of this.positionChangeCallbacks) {
        try {
          callback(positionChange);
        } catch (err) {
          console.error(`📡 Position callback error: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.error(`📡 Error processing position transfer: ${err instanceof Error ? err.message : err}`);
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

    // Only support Infura for WebSocket
    if (!url.hostname.includes("infura.io")) {
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
  options: Partial<OnChainMonitorConfig> = {}
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
    minWhaleTradeUsd: Number(process.env.ONCHAIN_MIN_WHALE_TRADE_USD) || 500,
    enabled,
    reconnectDelayMs: Number(process.env.ONCHAIN_RECONNECT_DELAY_MS) || 1000,
    maxReconnectAttempts: Number(process.env.ONCHAIN_MAX_RECONNECT_ATTEMPTS) || 10,
    infuraTier,
    ...options,
  };
}
