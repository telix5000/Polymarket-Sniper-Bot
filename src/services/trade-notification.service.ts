/**
 * Trade Notification Service
 *
 * Centralized service for sending trade notifications to Telegram.
 * This service acts as a singleton bridge between strategy execution
 * and the Telegram notification service.
 *
 * Usage:
 * 1. Initialize once at startup with initTradeNotificationService()
 * 2. Optionally set P&L callback with setTradeNotificationPnLCallback()
 * 3. Call notifyTrade() from any strategy when a trade executes
 *
 * The service handles:
 * - Notification formatting based on trade type
 * - P&L snapshot inclusion with each notification
 * - Error handling for failed notifications
 * - Graceful degradation when notifications are disabled
 */

import type {
  TelegramService,
  TradeNotification,
  PnLSnapshot,
} from "./telegram.service";
import type { LedgerSummary, Trade } from "../strategies/pnl-ledger";
import type { Logger } from "../utils/logger.util";
import type { StrategyId } from "../strategies/risk-types";

/**
 * Trade notification input from strategies
 */
export interface TradeNotificationInput {
  /** Type of trade (BUY, SELL, HEDGE, etc.) */
  type: TradeNotification["type"];
  /** Polymarket market identifier (market ID) */
  marketId: string;
  /** Token ID */
  tokenId: string;
  /** Number of shares traded */
  size: number;
  /** Price per share (0-1 scale) */
  price: number;
  /** Total USD value of the trade */
  sizeUsd: number;
  /** Optional: Outcome name (Yes/No) */
  outcome?: string;
  /** Optional: Market question text */
  marketQuestion?: string;
  /** Optional: Strategy that triggered the trade */
  strategy?: string;
  /** Optional: Entry price (for calculating gain on sells) */
  entryPrice?: number;
  /** Optional: P&L for this specific trade */
  pnl?: number;
  /** Optional: Transaction hash */
  txHash?: string;
}

// Singleton instance
let telegramService: TelegramService | null = null;
let getPnLSummary: (() => LedgerSummary | Promise<LedgerSummary>) | null = null;
let recordTradeCallback: ((trade: Trade) => void) | null = null;
let logger: Logger | null = null;

/**
 * Initialize the trade notification service with a Telegram service instance.
 * This should be called once during application startup.
 */
export function initTradeNotificationService(
  telegram: TelegramService,
  log?: Logger,
): void {
  telegramService = telegram;
  if (log) {
    logger = log;
    logger.debug("[TradeNotification] Service initialized");
  }
}

/**
 * Set the P&L callback for including P&L snapshots with notifications.
 * This should be called after the PnL ledger is initialized.
 * Supports both sync and async callbacks for balance enrichment.
 */
export function setTradeNotificationPnLCallback(
  callback: () => LedgerSummary | Promise<LedgerSummary>,
): void {
  getPnLSummary = callback;
  logger?.debug("[TradeNotification] P&L callback set");
}

/**
 * Set the trade recording callback for tracking P&L.
 * This should be called after the PnL ledger is initialized.
 * When set, all trades (BUY and SELL) will be automatically recorded to the ledger.
 * BUY trades establish cost basis, SELL trades realize P&L.
 */
export function setTradeRecordCallback(callback: (trade: Trade) => void): void {
  recordTradeCallback = callback;
  logger?.debug("[TradeNotification] Trade recording callback set");
}

/**
 * Check if the notification service is enabled
 */
export function isTradeNotificationEnabled(): boolean {
  return telegramService?.isEnabled() ?? false;
}

/**
 * Convert LedgerSummary to PnLSnapshot for notifications
 */
function toPnLSnapshot(summary: LedgerSummary): PnLSnapshot {
  return {
    netPnl: summary.netPnl,
    totalRealizedPnl: summary.totalRealizedPnl,
    totalUnrealizedPnl: summary.totalUnrealizedPnl,
    winRate: summary.winRate,
    winningTrades: summary.winningTrades,
    losingTrades: summary.losingTrades,
    // Include balance info if available from orchestrator
    usdcBalance: summary.usdcBalance,
    holdingsValue: summary.holdingsValue,
    totalValue: summary.totalValue,
  };
}

/**
 * Map notification type to strategy ID for trade recording
 * Uses valid StrategyId values from risk-types.ts
 */
function mapTypeToStrategyId(
  type: TradeNotification["type"],
  strategy?: string,
): StrategyId {
  // Use explicit strategy if provided
  if (strategy) {
    const strategyMap: Record<string, StrategyId> = {
      AutoSell: "QUICK_FLIP", // AutoSell is similar to quick flip
      "AutoSell (Stale)": "QUICK_FLIP",
      "AutoSell (Dispute)": "QUICK_FLIP",
      SellEarly: "QUICK_FLIP", // SellEarly is capital efficiency
      AutoRedeem: "MANUAL", // Redemption - closest match
      SmartHedging: "SMART_HEDGE", // Smart hedging strategy
      ScalpTrade: "QUICK_FLIP", // Scalp is profit-taking
      StopLoss: "STOP_LOSS", // Direct match
      PositionStacking: "ENDGAME", // Stacking builds positions like endgame
      EndgameSweep: "ENDGAME", // Direct match
      Frontrun: "FF", // FF = Frontrun/Flashfill
    };
    return strategyMap[strategy] ?? "MANUAL";
  }

  // Fall back to type-based mapping
  const typeMap: Record<TradeNotification["type"], StrategyId> = {
    BUY: "ENDGAME",
    SELL: "QUICK_FLIP",
    REDEEM: "MANUAL",
    HEDGE: "HEDGE",
    HEDGE_EXIT: "SMART_HEDGE",
    STACK: "ENDGAME",
    STOP_LOSS: "STOP_LOSS",
    SCALP: "QUICK_FLIP",
    FRONTRUN: "FF",
  };
  return typeMap[type] ?? "MANUAL";
}

/**
 * Record a trade to the PnL ledger if callback is set.
 * This is called automatically when sending trade notifications.
 */
function recordTradeToLedger(input: TradeNotificationInput): void {
  if (!recordTradeCallback) {
    return;
  }

  try {
    const strategyId = mapTypeToStrategyId(input.type, input.strategy);
    const side = isSellType(input.type) ? "SELL" : "BUY";

    const trade: Trade = {
      timestamp: Date.now(),
      strategyId,
      marketId: input.marketId,
      tokenId: input.tokenId,
      side,
      size: input.size,
      price: input.price,
      // Fees are set to 0 because:
      // 1. Polymarket fees are deducted from the execution price, not charged separately
      // 2. The P&L passed from strategies already accounts for any fees in the price difference
      // 3. When pnlRealized is provided, it's the actual profit/loss after all costs
      fees: 0,
      pnlRealized: input.pnl,
    };

    recordTradeCallback(trade);
    logger?.debug(
      `[TradeNotification] Recorded ${side} trade: ${input.size.toFixed(2)} @ ${(input.price * 100).toFixed(1)}¢ (${strategyId})`,
    );
  } catch (err) {
    logger?.warn(
      `[TradeNotification] Failed to record trade: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Check if a trade type is a SELL (closes a position and realizes P&L)
 */
function isSellType(type: TradeNotification["type"]): boolean {
  return ["SELL", "REDEEM", "HEDGE_EXIT", "STOP_LOSS", "SCALP"].includes(type);
}

/**
 * Send a trade notification to Telegram.
 *
 * This function should be called after a trade is executed.
 * It will include a P&L snapshot if the P&L callback is set.
 * For SELL-type trades, it will also record the trade to the PnL ledger.
 *
 * @param input Trade notification details
 * @returns Promise<boolean> - true if notification was sent successfully
 */
export async function notifyTrade(
  input: TradeNotificationInput,
): Promise<boolean> {
  // Record trade to PnL ledger FIRST (before notification)
  // This ensures realized P&L is updated before we fetch the snapshot
  recordTradeToLedger(input);

  if (!telegramService) {
    logger?.warn(
      `[TradeNotification] Cannot send ${input.type} notification - telegramService not initialized`,
    );
    return false;
  }

  if (!telegramService.isEnabled()) {
    logger?.debug(
      `[TradeNotification] Cannot send ${input.type} notification - Telegram not enabled`,
    );
    return false;
  }

  // Log that we're attempting to send a notification
  logger?.info(
    `[TradeNotification] Sending ${input.type} notification for market ${input.marketId.slice(0, 12)}...`,
  );

  const trade: TradeNotification = {
    type: input.type,
    marketId: input.marketId,
    tokenId: input.tokenId,
    size: input.size,
    price: input.price,
    sizeUsd: input.sizeUsd,
    outcome: input.outcome,
    marketQuestion: input.marketQuestion,
    strategy: input.strategy,
    entryPrice: input.entryPrice,
    pnl: input.pnl,
    txHash: input.txHash,
  };

  try {
    // Get P&L snapshot if callback is available
    let pnlSnapshot: PnLSnapshot | undefined;
    if (getPnLSummary) {
      try {
        const summary = await Promise.resolve(getPnLSummary());
        pnlSnapshot = toPnLSnapshot(summary);
      } catch (err) {
        logger?.warn(
          `[TradeNotification] Failed to get P&L summary: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Send notification with P&L if available
    const success = await telegramService.sendTradeNotificationWithPnL(
      trade,
      pnlSnapshot,
    );

    if (success) {
      logger?.debug(
        `[TradeNotification] Sent ${input.type} notification for ${input.marketId.slice(0, 8)}...`,
      );
    } else {
      logger?.warn(
        `[TradeNotification] Failed to send ${input.type} notification`,
      );
    }

    return success;
  } catch (err) {
    logger?.error(
      `[TradeNotification] Error sending notification: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Convenience function to notify a BUY trade
 */
export async function notifyBuy(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "BUY",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    ...options,
  });
}

/**
 * Convenience function to notify a SELL trade
 */
export async function notifySell(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "SELL",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    ...options,
  });
}

/**
 * Convenience function to notify a HEDGE trade
 */
export async function notifyHedge(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "HEDGE",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "SmartHedging",
    ...options,
  });
}

/**
 * Convenience function to notify a HEDGE_EXIT trade
 */
export async function notifyHedgeExit(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "HEDGE_EXIT",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "SmartHedging",
    ...options,
  });
}

/**
 * Convenience function to notify a REDEEM trade
 */
export async function notifyRedeem(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "REDEEM",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "AutoRedeem",
    ...options,
  });
}

/**
 * Convenience function to notify a STACK (position stacking) trade
 */
export async function notifyStack(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "STACK",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "PositionStacking",
    ...options,
  });
}

/**
 * Convenience function to notify a STOP_LOSS trade
 */
export async function notifyStopLoss(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "STOP_LOSS",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "StopLoss",
    ...options,
  });
}

/**
 * Convenience function to notify a SCALP take-profit trade
 */
export async function notifyScalp(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "SCALP",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "ScalpTrade",
    ...options,
  });
}

/**
 * Convenience function to notify a FRONTRUN (copy trade) execution
 */
export async function notifyFrontrun(
  marketId: string,
  tokenId: string,
  size: number,
  price: number,
  sizeUsd: number,
  options?: Partial<TradeNotificationInput>,
): Promise<boolean> {
  return notifyTrade({
    type: "FRONTRUN",
    marketId,
    tokenId,
    size,
    price,
    sizeUsd,
    strategy: "Frontrun",
    ...options,
  });
}
