/**
 * Trade Notification Service
 *
 * Centralized service for sending trade notifications to Telegram.
 * This service acts as a singleton bridge between strategy execution
 * and the Telegram notification service.
 *
 * Usage:
 * 1. Initialize once at startup with setTelegramService()
 * 2. Optionally set P&L callback with setPnLCallback()
 * 3. Call notify() from any strategy when a trade executes
 *
 * The service handles:
 * - Notification formatting based on trade type
 * - P&L snapshot inclusion with each notification
 * - Error handling for failed notifications
 * - Graceful degradation when notifications are disabled
 */

import type { TelegramService, TradeNotification, PnLSnapshot } from "./telegram.service";
import type { LedgerSummary } from "../strategies/pnl-ledger";
import type { Logger } from "../utils/logger.util";

/**
 * Trade notification input from strategies
 */
export interface TradeNotificationInput {
  /** Type of trade (BUY, SELL, HEDGE, etc.) */
  type: TradeNotification["type"];
  /** Market condition ID */
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
let getPnLSummary: (() => LedgerSummary) | null = null;
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
 */
export function setTradeNotificationPnLCallback(
  callback: () => LedgerSummary,
): void {
  getPnLSummary = callback;
  logger?.debug("[TradeNotification] P&L callback set");
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
  };
}

/**
 * Send a trade notification to Telegram.
 *
 * This function should be called after a trade is executed.
 * It will include a P&L snapshot if the P&L callback is set.
 *
 * @param input Trade notification details
 * @returns Promise<boolean> - true if notification was sent successfully
 */
export async function notifyTrade(
  input: TradeNotificationInput,
): Promise<boolean> {
  if (!telegramService || !telegramService.isEnabled()) {
    return false;
  }

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
        const summary = getPnLSummary();
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
    strategy: "UniversalStopLoss",
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
    strategy: "ScalpTakeProfit",
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
