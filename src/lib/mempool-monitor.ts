/**
 * Mempool Monitor - DEPRECATED
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ DEPRECATION NOTICE - DO NOT USE FOR WHALE DETECTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module was based on incorrect assumptions about Polymarket architecture.
 *
 * POLYMARKET DOES NOT WORK VIA BLOCKCHAIN MEMPOOL:
 * - Polymarket trades happen on the CLOB (Central Limit Order Book)
 * - The CLOB is an off-chain order matching system
 * - Blockchain (Polygon) is only used for SETTLEMENT, not trade execution
 * - By the time a trade hits the mempool, it's already been matched on the CLOB
 *
 * CORRECT WHALE DETECTION:
 * - Use Polymarket DATA API (/trades endpoint) for whale activity
 * - Track proxyWallets (not EOAs) from the leaderboard
 * - Mempool monitoring provides NO speed advantage for Polymarket
 *
 * This module is kept for backward compatibility but:
 * - start() returns false immediately (no-op)
 * - No WebSocket connections are made
 * - No events are emitted
 *
 * For whale detection, use BiasAccumulator with Data API polling instead.
 */

import { ethers } from "ethers";
import { POLYGON } from "./constants";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PendingTradeSignal {
  /** Transaction hash of the pending transaction */
  txHash: string;
  /** Whale wallet address */
  whaleWallet: string;
  /** Token ID being traded */
  tokenId: string;
  /** BUY or SELL */
  side: "BUY" | "SELL";
  /** Estimated trade size in USD */
  estimatedSizeUsd: number;
  /** Price from the order */
  price: number;
  /** Gas price of the pending tx (we need to beat this) */
  gasPriceGwei: number;
  /** Timestamp when we detected this */
  detectedAt: number;
  /** The raw transaction for analysis */
  rawTx: ethers.TransactionResponse;
}

export interface MempoolMonitorConfig {
  /** WebSocket RPC URL that supports pending tx subscription */
  wsRpcUrl: string;
  /** Set of whale wallet addresses to track (lowercase) */
  whaleWallets: Set<string>;
  /** Minimum trade size to signal (USD) */
  minTradeSizeUsd: number;
  /** Gas price multiplier for priority execution (e.g., 1.2 = 20% higher) */
  gasPriceMultiplier: number;
  /** Enable/disable mempool monitoring */
  enabled: boolean;
}

type PendingTradeCallback = (signal: PendingTradeSignal) => void;

// ═══════════════════════════════════════════════════════════════════════════
// POLYMARKET CONTRACT INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

// Function signatures we're looking for in pending transactions
const EXCHANGE_METHODS = {
  // fillOrder(Order order, uint256 fillAmount)
  FILL_ORDER: "0x64a3bc15",
  // fillOrders(Order[] orders, uint256[] fillAmounts)  
  FILL_ORDERS: "0x5a9f5e0c",
  // matchOrders(Order leftOrder, Order rightOrder)
  MATCH_ORDERS: "0x88ec79fb",
};

// ABI for decoding order data
const ORDER_ABI = [
  "function fillOrder((uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) order, uint256 fillAmount)",
];

// ═══════════════════════════════════════════════════════════════════════════
// MEMPOOL MONITOR
// ═══════════════════════════════════════════════════════════════════════════

export class MempoolMonitor {
  private config: MempoolMonitorConfig;
  private wsProvider: ethers.WebSocketProvider | null = null;
  private callbacks: PendingTradeCallback[] = [];
  private running = false;
  private iface: ethers.Interface;
  
  // Track seen transactions to avoid duplicates
  private seenTxHashes: Set<string> = new Set();
  private readonly MAX_SEEN_CACHE = 10000;

  constructor(config: MempoolMonitorConfig) {
    this.config = config;
    this.iface = new ethers.Interface(ORDER_ABI);
  }

  /**
   * Register callback for pending whale trade signals
   */
  onPendingTrade(callback: PendingTradeCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Start monitoring the mempool
   * 
   * ⚠️ DEPRECATED: This method now returns false immediately.
   * Mempool monitoring does not provide value for Polymarket because:
   * - Trades happen on CLOB (off-chain), not blockchain
   * - Blockchain is only for settlement (already matched)
   * 
   * Use Data API polling for whale detection instead.
   */
  async start(): Promise<boolean> {
    // DEPRECATED: Mempool monitoring is not useful for Polymarket
    // The CLOB is off-chain, so blockchain mempool has no signal value
    console.log("⚠️ Mempool monitoring DISABLED - not useful for Polymarket CLOB architecture");
    console.log("   ℹ️ Use Data API polling for whale detection (BiasAccumulator)");
    return false;
  }

  /**
   * Stop monitoring
   * 
   * ⚠️ DEPRECATED: Since start() is now a no-op, stop() is also effectively a no-op.
   * Kept for API compatibility.
   */
  stop(): void {
    // Only cleanup if monitor was actually running (which it won't be anymore)
    if (this.running) {
      this.running = false;
      if (this.wsProvider) {
        this.wsProvider.removeAllListeners();
        this.wsProvider.destroy();
        this.wsProvider = null;
      }
    }
  }

  /**
   * Handle a pending transaction
   */
  private async handlePendingTx(txHash: string): Promise<void> {
    // Skip if we've already seen this tx
    if (this.seenTxHashes.has(txHash)) {
      return;
    }
    this.seenTxHashes.add(txHash);
    
    // Cleanup old entries
    if (this.seenTxHashes.size > this.MAX_SEEN_CACHE) {
      const entries = Array.from(this.seenTxHashes);
      entries.slice(0, this.MAX_SEEN_CACHE / 2).forEach(h => this.seenTxHashes.delete(h));
    }

    try {
      // Get the full transaction
      const tx = await this.wsProvider?.getTransaction(txHash);
      if (!tx) return;

      // Check if it's to one of the Polymarket exchange contracts
      const toAddress = tx.to?.toLowerCase();
      if (
        toAddress !== POLYGON.CTF_EXCHANGE.toLowerCase() &&
        toAddress !== POLYGON.NEG_RISK_CTF_EXCHANGE.toLowerCase()
      ) {
        return; // Not a Polymarket trade
      }

      // Check if it's from a tracked whale
      const fromAddress = tx.from.toLowerCase();
      if (!this.config.whaleWallets.has(fromAddress)) {
        return; // Not from a whale we're tracking
      }

      // Try to decode the transaction
      const signal = this.decodePendingTrade(tx);
      if (!signal) return;

      // Check minimum size
      if (signal.estimatedSizeUsd < this.config.minTradeSizeUsd) {
        return;
      }

      console.log(`🔮 PENDING WHALE TX DETECTED!`);
      console.log(`   Whale: ${signal.whaleWallet.slice(0, 10)}...`);
      console.log(`   Side: ${signal.side} | Size: ~$${signal.estimatedSizeUsd.toFixed(0)} | Gas: ${signal.gasPriceGwei.toFixed(1)} gwei`);
      console.log(`   TxHash: ${signal.txHash}`);
      console.log(`   ⚡ COPY NOW with gas > ${(signal.gasPriceGwei * this.config.gasPriceMultiplier).toFixed(1)} gwei!`);

      // Fire callbacks
      for (const callback of this.callbacks) {
        try {
          callback(signal);
        } catch (err) {
          console.error(`📡 Callback error: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch {
      // Silently ignore - many pending txs will fail to decode
    }
  }

  /**
   * Decode a pending transaction to extract trade details
   */
  private decodePendingTrade(tx: ethers.TransactionResponse): PendingTradeSignal | null {
    try {
      const data = tx.data;
      const methodId = data.slice(0, 10);

      // Check if it's a method we care about
      if (!Object.values(EXCHANGE_METHODS).includes(methodId)) {
        return null;
      }

      // Try to decode the order
      // This is a simplified decode - real implementation would need full ABI
      let tokenId = "unknown";
      let side: "BUY" | "SELL" = "BUY";
      let estimatedSizeUsd = 0;
      let price = 0;

      try {
        // Attempt to decode fillOrder
        if (methodId === EXCHANGE_METHODS.FILL_ORDER) {
          const decoded = this.iface.decodeFunctionData("fillOrder", data);
          const order = decoded[0];
          tokenId = order.tokenId.toString();
          side = order.side === 0 ? "BUY" : "SELL";
          
          // Calculate size from amounts (simplified)
          const makerAmount = Number(order.makerAmount) / 1e6;
          const takerAmount = Number(order.takerAmount) / 1e6;
          estimatedSizeUsd = Math.max(makerAmount, takerAmount);
          
          if (makerAmount > 0 && takerAmount > 0) {
            price = takerAmount / makerAmount;
          }
        }
      } catch {
        // Decoding failed - use estimates from tx value/gas
        // This is a fallback for when we can't fully decode
        estimatedSizeUsd = 100; // Assume minimum threshold
      }

      const gasPriceGwei = tx.gasPrice ? Number(tx.gasPrice) / 1e9 : 0;

      return {
        txHash: tx.hash,
        whaleWallet: tx.from,
        tokenId,
        side,
        estimatedSizeUsd,
        price,
        gasPriceGwei,
        detectedAt: Date.now(),
        rawTx: tx,
      };
    } catch {
      return null;
    }
  }

  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error("📡 Max mempool reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(`📡 Mempool reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.start();
        this.reconnectAttempts = 0;
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Update the whale wallets being tracked
   */
  updateWhaleWallets(wallets: Set<string>): void {
    this.config.whaleWallets = wallets;
  }

  /**
   * Get current stats
   */
  getStats(): { running: boolean; whalesTracked: number; txsSeen: number } {
    return {
      running: this.running,
      whalesTracked: this.config.whaleWallets.size,
      txsSeen: this.seenTxHashes.size,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create mempool monitor config from environment
 */
export function createMempoolMonitorConfig(
  wsRpcUrl: string,
  whaleWallets: Set<string>,
  options: {
    enabled?: boolean;
    minTradeSizeUsd?: number;
    gasPriceMultiplier?: number;
  } = {}
): MempoolMonitorConfig {
  return {
    wsRpcUrl,
    whaleWallets,
    enabled: options.enabled ?? true,
    minTradeSizeUsd: options.minTradeSizeUsd ?? 100,
    gasPriceMultiplier: options.gasPriceMultiplier ?? 1.2,
  };
}
