/**
 * Telegram Notification Service
 *
 * Sends notifications to a Telegram chat/topic when:
 * - Positions are bought
 * - Positions are sold
 * - Positions are redeemed
 * - Periodic P&L updates
 *
 * Configuration via environment variables:
 * - TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 * - TELEGRAM_CHAT_ID: Chat ID (can be a group or user)
 * - TELEGRAM_TOPIC_ID: Optional topic ID for forum-style groups
 * - TELEGRAM_NOTIFICATION_NAME: Custom notification name (default: "Polymarket Alert")
 * - TELEGRAM_PNL_INTERVAL_MINUTES: Interval for P&L updates (default: 60)
 * - TELEGRAM_SILENT: Send notifications silently without sound (default: false)
 */

import type { Logger } from "../utils/logger.util";
import type { LedgerSummary } from "../strategies/pnl-ledger";

/**
 * Telegram configuration
 */
export interface TelegramConfig {
  /** Bot token from @BotFather */
  botToken: string;
  /** Chat ID (user or group) */
  chatId: string;
  /** Topic ID for forum-style groups (optional) */
  topicId?: string;
  /** Custom notification name (default: "Polymarket Alert") */
  notificationName: string;
  /** Interval for P&L updates in minutes (default: 60, set to 0 to disable) */
  pnlIntervalMinutes: number;
  /** Send notifications silently without sound (default: false) */
  silent: boolean;
  /** Enable/disable notifications */
  enabled: boolean;
}

/**
 * Default Telegram configuration
 */
export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: "",
  chatId: "",
  topicId: undefined,
  notificationName: "Polymarket Alert",
  pnlIntervalMinutes: 60,
  silent: false,
  enabled: false,
};

/**
 * Trade notification types
 *
 * Extended to cover all financial transaction types:
 * - BUY: Copy trade or endgame sweep buy
 * - SELL: General sell (auto-sell handles capital efficiency)
 * - REDEEM: Position redemption after market resolution
 * - HEDGE: Hedge order placed to protect losing position
 * - HEDGE_EXIT: Hedge position sold (profitable or not)
 * - STACK: Position stacking (doubling down on winner)
 * - STOP_LOSS: Stop-loss triggered to limit losses
 * - SCALP: Scalp take-profit triggered
 * - FRONTRUN: Frontrun/copy trade executed
 */
export type TradeNotificationType =
  | "BUY"
  | "SELL"
  | "REDEEM"
  | "HEDGE"
  | "HEDGE_EXIT"
  | "STACK"
  | "STOP_LOSS"
  | "SCALP"
  | "FRONTRUN";

/**
 * Trade notification data
 */
export interface TradeNotification {
  type: TradeNotificationType;
  marketId: string;
  tokenId: string;
  outcome?: string;
  size: number;
  price: number;
  sizeUsd: number;
  pnl?: number;
  marketQuestion?: string;
  /** Strategy that triggered this trade */
  strategy?: string;
  /** Entry price for position (used to calculate gain) */
  entryPrice?: number;
  /** Transaction hash if available */
  txHash?: string;
}

/**
 * P&L snapshot to include with transaction notifications
 */
export interface PnLSnapshot {
  netPnl: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  winRate: number;
  winningTrades: number;
  losingTrades: number;

  // === BALANCE INFORMATION (optional) ===
  /** USDC cash balance (reserves) */
  usdcBalance?: number;
  /** Total value of all holdings at current prices */
  holdingsValue?: number;
  /** Grand total (USDC + holdings value) */
  totalValue?: number;

  // === INITIAL INVESTMENT TRACKING (optional) ===
  /** Initial investment amount for calculating overall return */
  initialInvestment?: number;
  /** Overall return: (totalValue - initialInvestment) / initialInvestment * 100 */
  overallReturnPct?: number;
  /** Absolute gain/loss: totalValue - initialInvestment */
  overallGainLoss?: number;
}

/**
 * Strategy status for startup notification
 */
export interface StartupStrategyStatus {
  endgameSweep?: boolean;
  positionStacking?: boolean;
  // sellEarly removed - consolidated into autoSell
  autoSell?: boolean;
  scalpTakeProfit?: boolean;
  hedging?: boolean;
  stopLoss?: boolean;
  autoRedeem?: boolean;
  frontrun?: boolean;
}

/**
 * Telegram Notification Service
 */
export class TelegramService {
  private readonly config: TelegramConfig;
  private readonly logger: Logger;
  private pnlTimer?: NodeJS.Timeout;
  private lastPnlUpdateTime: number = 0;
  private getPnlSummary?: () => LedgerSummary | Promise<LedgerSummary>;

  constructor(config: Partial<TelegramConfig>, logger: Logger) {
    this.config = {
      ...DEFAULT_TELEGRAM_CONFIG,
      ...config,
      enabled: Boolean(config.botToken && config.chatId),
    };
    this.logger = logger;

    if (this.config.enabled) {
      const silentMode = this.config.silent ? ", silent mode" : "";
      this.logger.info(
        `[Telegram] ✅ Notifications enabled (name: "${this.config.notificationName}"${silentMode})`,
      );
    } else {
      this.logger.debug(
        "[Telegram] Notifications disabled (missing bot token or chat ID)",
      );
    }
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Start periodic P&L updates
   */
  startPnlUpdates(
    getPnlSummary: () => LedgerSummary | Promise<LedgerSummary>,
  ): void {
    if (!this.config.enabled || this.config.pnlIntervalMinutes <= 0) {
      return;
    }

    // Clear any existing timer before creating a new one
    if (this.pnlTimer) {
      clearInterval(this.pnlTimer);
      this.pnlTimer = undefined;
    }

    this.getPnlSummary = getPnlSummary;
    const intervalMs = this.config.pnlIntervalMinutes * 60 * 1000;

    this.pnlTimer = setInterval(() => {
      this.sendPnlUpdate().catch((err) => {
        this.logger.error(
          `[Telegram] Failed to send P&L update: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, intervalMs);

    this.logger.info(
      `[Telegram] P&L updates scheduled every ${this.config.pnlIntervalMinutes} minutes`,
    );
  }

  /**
   * Stop periodic P&L updates
   */
  stopPnlUpdates(): void {
    if (this.pnlTimer) {
      clearInterval(this.pnlTimer);
      this.pnlTimer = undefined;
    }
  }

  /**
   * Send a trade notification
   */
  async sendTradeNotification(trade: TradeNotification): Promise<boolean> {
    if (!this.config.enabled) return false;

    const emoji = this.getTradeEmoji(trade.type);
    const action = this.getTradeAction(trade.type);

    let message = `${emoji} <b>${this.escapeHtml(this.config.notificationName)}</b>\n\n`;
    message += `📍 <b>${action}</b>\n`;

    if (trade.strategy) {
      message += `🎯 Strategy: ${this.escapeHtml(trade.strategy)}\n`;
    }

    if (trade.marketQuestion) {
      message += `📊 Market: ${this.escapeHtml(trade.marketQuestion)}\n`;
    }

    if (trade.outcome) {
      message += `🎲 Outcome: ${this.escapeHtml(trade.outcome)}\n`;
    }

    message += `💵 Size: ${trade.size.toFixed(2)} shares\n`;
    message += `💰 Price: ${this.formatPrice(trade.price)}\n`;
    message += `📊 Value: $${trade.sizeUsd.toFixed(2)}\n`;

    // Show entry price and gain for sells
    if (trade.entryPrice !== undefined && trade.entryPrice > 0) {
      const gainDollars = trade.price - trade.entryPrice;
      const gainEmoji = gainDollars >= 0 ? "📈" : "📉";
      message += `${gainEmoji} Entry: ${this.formatPrice(trade.entryPrice)} → ${this.formatPrice(trade.price)} (${gainDollars >= 0 ? "+" : ""}$${gainDollars.toFixed(2)})\n`;
    }

    if (trade.pnl !== undefined) {
      const pnlEmoji = trade.pnl >= 0 ? "💰" : "💸";
      message += `${pnlEmoji} Trade P&L: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}\n`;
    }

    if (trade.txHash) {
      message += `\n🔗 Tx: <code>${trade.txHash.slice(0, 16)}...</code>`;
    } else {
      message += `\n🔗 Market: <code>${trade.marketId.slice(0, 16)}...</code>`;
    }

    return this.sendMessage(message);
  }

  /**
   * Send a trade notification with updated P&L snapshot
   *
   * This method sends a trade notification along with the current P&L summary,
   * allowing users to track their portfolio movement with each trade.
   */
  async sendTradeNotificationWithPnL(
    trade: TradeNotification,
    pnlSnapshot?: PnLSnapshot,
  ): Promise<boolean> {
    if (!this.config.enabled) return false;

    const emoji = this.getTradeEmoji(trade.type);
    const action = this.getTradeAction(trade.type);

    let message = `${emoji} <b>${this.escapeHtml(this.config.notificationName)}</b>\n\n`;
    message += `📍 <b>${action}</b>\n`;

    if (trade.strategy) {
      message += `🎯 Strategy: ${this.escapeHtml(trade.strategy)}\n`;
    }

    if (trade.marketQuestion) {
      message += `📊 Market: ${this.escapeHtml(trade.marketQuestion)}\n`;
    }

    if (trade.outcome) {
      message += `🎲 Outcome: ${this.escapeHtml(trade.outcome)}\n`;
    }

    message += `💵 Size: ${trade.size.toFixed(2)} shares\n`;
    message += `💰 Price: ${this.formatPrice(trade.price)}\n`;
    message += `📊 Value: $${trade.sizeUsd.toFixed(2)}\n`;

    // Show entry price and gain for sells
    if (trade.entryPrice !== undefined && trade.entryPrice > 0) {
      const gainDollars = trade.price - trade.entryPrice;
      const gainEmoji = gainDollars >= 0 ? "📈" : "📉";
      message += `${gainEmoji} Entry: ${this.formatPrice(trade.entryPrice)} → ${this.formatPrice(trade.price)} (${gainDollars >= 0 ? "+" : ""}$${gainDollars.toFixed(2)})\n`;
    }

    if (trade.pnl !== undefined) {
      const pnlEmoji = trade.pnl >= 0 ? "💰" : "💸";
      message += `${pnlEmoji} Trade P&L: ${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}\n`;
    }

    // Add P&L snapshot if available
    if (pnlSnapshot) {
      const netEmoji = pnlSnapshot.netPnl >= 0 ? "🟢" : "🔴";
      message += `\n━━━ Portfolio Update ━━━\n`;
      message += `${netEmoji} Net P&L: ${pnlSnapshot.netPnl >= 0 ? "+" : ""}$${pnlSnapshot.netPnl.toFixed(2)}\n`;
      message += `💰 Realized: ${pnlSnapshot.totalRealizedPnl >= 0 ? "+" : ""}$${pnlSnapshot.totalRealizedPnl.toFixed(2)}\n`;
      message += `📈 Unrealized: ${pnlSnapshot.totalUnrealizedPnl >= 0 ? "+" : ""}$${pnlSnapshot.totalUnrealizedPnl.toFixed(2)}\n`;
      if (pnlSnapshot.winningTrades + pnlSnapshot.losingTrades > 0) {
        message += `📉 Win Rate: ${(pnlSnapshot.winRate * 100).toFixed(1)}% (${pnlSnapshot.winningTrades}W/${pnlSnapshot.losingTrades}L)\n`;
      }

      // Add balance breakdown if available
      if (
        pnlSnapshot.usdcBalance !== undefined &&
        pnlSnapshot.holdingsValue !== undefined &&
        pnlSnapshot.totalValue !== undefined
      ) {
        message += `\n━━━ Balance ━━━\n`;
        message += `🏦 USDC: $${pnlSnapshot.usdcBalance.toFixed(2)}\n`;
        message += `📊 Holdings: $${pnlSnapshot.holdingsValue.toFixed(2)}\n`;
        message += `💎 Total: $${pnlSnapshot.totalValue.toFixed(2)}\n`;

        // Add overall return if initial investment is set
        if (
          pnlSnapshot.initialInvestment !== undefined &&
          pnlSnapshot.overallReturnPct !== undefined &&
          pnlSnapshot.overallGainLoss !== undefined
        ) {
          const returnEmoji = pnlSnapshot.overallGainLoss >= 0 ? "📈" : "📉";
          message += `${returnEmoji} Overall: ${pnlSnapshot.overallGainLoss >= 0 ? "+" : ""}$${pnlSnapshot.overallGainLoss.toFixed(2)} (${pnlSnapshot.overallReturnPct >= 0 ? "+" : ""}${pnlSnapshot.overallReturnPct.toFixed(1)}%)\n`;
        }
      }
    }

    if (trade.txHash) {
      message += `\n🔗 Tx: <code>${trade.txHash.slice(0, 16)}...</code>`;
    } else {
      message += `\n🔗 Market: <code>${trade.marketId.slice(0, 16)}...</code>`;
    }

    return this.sendMessage(message);
  }

  /**
   * Send a P&L update
   */
  async sendPnlUpdate(): Promise<boolean> {
    if (!this.config.enabled || !this.getPnlSummary) return false;

    // Track performance of P&L summary generation
    const startTime = Date.now();
    const summary = await Promise.resolve(this.getPnlSummary());
    const summaryDurationMs = Date.now() - startTime;

    // Log slow summary generation for performance monitoring
    if (summaryDurationMs > 1000) {
      this.logger.warn(
        `[Telegram] P&L summary generation took ${summaryDurationMs}ms (>1s) - consider optimizing if this persists`,
      );
    } else if (summaryDurationMs > 500) {
      this.logger.debug(
        `[Telegram] P&L summary generation took ${summaryDurationMs}ms`,
      );
    }

    // Skip sending if there's no meaningful data to report
    // (no trades, no P&L, no fees - all zeros)
    const totalTrades = summary.winningTrades + summary.losingTrades;
    const hasActivity =
      totalTrades > 0 ||
      summary.netPnl !== 0 ||
      summary.totalRealizedPnl !== 0 ||
      summary.totalUnrealizedPnl !== 0 ||
      summary.totalFees !== 0;

    if (!hasActivity) {
      this.logger.debug(
        "[Telegram] Skipping P&L update - no trading activity to report",
      );
      return false;
    }

    const netEmoji = summary.netPnl >= 0 ? "🟢" : "🔴";

    let message = `📊 <b>${this.escapeHtml(this.config.notificationName)} - P&amp;L Update</b>\n\n`;
    message += `${netEmoji} <b>Net P&L: ${summary.netPnl >= 0 ? "+" : ""}$${summary.netPnl.toFixed(2)}</b>\n\n`;
    message += `💰 Realized: ${summary.totalRealizedPnl >= 0 ? "+" : ""}$${summary.totalRealizedPnl.toFixed(2)}\n`;
    message += `📈 Unrealized: ${summary.totalUnrealizedPnl >= 0 ? "+" : ""}$${summary.totalUnrealizedPnl.toFixed(2)}\n`;
    message += `💸 Fees: $${summary.totalFees.toFixed(2)}\n\n`;

    if (totalTrades > 0) {
      message += `📉 Win Rate: ${(summary.winRate * 100).toFixed(1)}% (${summary.winningTrades}W / ${summary.losingTrades}L)\n`;
      message += `✅ Avg Win: $${summary.avgWin.toFixed(2)}\n`;
      message += `❌ Avg Loss: $${Math.abs(summary.avgLoss).toFixed(2)}\n`;

      if (summary.largestWin > 0) {
        message += `🏆 Best: +$${summary.largestWin.toFixed(2)}\n`;
      }
      if (summary.largestLoss < 0) {
        message += `💔 Worst: $${summary.largestLoss.toFixed(2)}\n`;
      }
    }

    // Add balance breakdown if available
    if (
      summary.usdcBalance !== undefined &&
      summary.holdingsValue !== undefined &&
      summary.totalValue !== undefined
    ) {
      message += `\n━━━ Balance ━━━\n`;
      message += `🏦 USDC: $${summary.usdcBalance.toFixed(2)}\n`;
      message += `📊 Holdings: $${summary.holdingsValue.toFixed(2)}\n`;
      message += `💎 Total: $${summary.totalValue.toFixed(2)}\n`;

      // Add overall return if initial investment is set
      if (
        summary.initialInvestment !== undefined &&
        summary.overallReturnPct !== undefined &&
        summary.overallGainLoss !== undefined
      ) {
        const returnEmoji = summary.overallGainLoss >= 0 ? "📈" : "📉";
        message += `${returnEmoji} Overall: ${summary.overallGainLoss >= 0 ? "+" : ""}$${summary.overallGainLoss.toFixed(2)} (${summary.overallReturnPct >= 0 ? "+" : ""}${summary.overallReturnPct.toFixed(1)}%)\n`;
        message += `💵 Initial: $${summary.initialInvestment.toFixed(2)}\n`;
      }
    }

    this.lastPnlUpdateTime = Date.now();
    return this.sendMessage(message);
  }

  /**
   * Send a custom message
   */
  async sendCustomMessage(text: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    const message = `📢 <b>${this.escapeHtml(this.config.notificationName)}</b>\n\n${this.escapeHtml(text)}`;
    return this.sendMessage(message);
  }

  /**
   * Send a startup notification showing which strategies are enabled.
   * This helps users verify Telegram is working and understand what to expect.
   */
  async sendStartupNotification(
    enabledStrategies: StartupStrategyStatus,
  ): Promise<boolean> {
    if (!this.config.enabled) return false;

    let message = `🚀 <b>${this.escapeHtml(this.config.notificationName)} - Bot Started</b>\n\n`;
    message += `📊 <b>Enabled Strategies:</b>\n`;

    // Core trading strategies
    if (enabledStrategies.endgameSweep) {
      message += `✅ Endgame Sweep (BUY high-confidence)\n`;
    }
    if (enabledStrategies.positionStacking) {
      message += `✅ Position Stacking (double down on winners)\n`;
    }

    // Exit strategies
    // sellEarly removed - consolidated into autoSell
    if (enabledStrategies.autoSell) {
      message += `✅ Auto-Sell ($0.99+ exits, stale positions, quick wins)\n`;
    }
    if (enabledStrategies.scalpTakeProfit) {
      message += `✅ Scalp Take-Profit (time-based exits)\n`;
    }

    // Risk management
    if (enabledStrategies.hedging) {
      message += `✅ Hedging (loss protection)\n`;
    }
    if (enabledStrategies.stopLoss) {
      message += `✅ Stop-Loss\n`;
    }

    // Redemption
    if (enabledStrategies.autoRedeem) {
      message += `✅ Auto-Redeem (claim resolved positions)\n`;
    }

    // Frontrun/Copy trading (if applicable)
    if (enabledStrategies.frontrun) {
      message += `✅ Copy Trading (frontrun whale trades)\n`;
    }

    message += `\n💡 You'll receive alerts for: BUY, SELL, HEDGE, REDEEM, and P&L updates.`;
    message += `\n⏰ P&L updates every ${this.config.pnlIntervalMinutes} minutes.`;

    return this.sendMessage(message);
  }

  /**
   * Send a message to Telegram
   */
  private async sendMessage(text: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    try {
      const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
      const body: Record<string, string | number | boolean> = {
        chat_id: this.config.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        disable_notification: this.config.silent,
      };

      // Add topic ID if specified (for forum-style groups)
      if (this.config.topicId) {
        const topicIdNum = Number.parseInt(this.config.topicId, 10);
        if (Number.isNaN(topicIdNum)) {
          this.logger.warn(
            `[Telegram] Invalid TELEGRAM_TOPIC_ID value "${this.config.topicId}" - skipping message_thread_id`,
          );
        } else {
          body.message_thread_id = topicIdNum;
        }
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let safeErrorMessage = "Unknown error";
        try {
          const parsed = JSON.parse(errorText) as {
            error_code?: number;
            description?: string;
          } | null;
          if (parsed && typeof parsed === "object") {
            const parts: string[] = [];
            if (typeof parsed.error_code === "number") {
              parts.push(`error_code=${parsed.error_code}`);
            }
            if (typeof parsed.description === "string") {
              parts.push(`description=${parsed.description}`);
            }
            if (parts.length > 0) {
              safeErrorMessage = parts.join(", ");
            } else {
              // Fallback: use a truncated version of the raw error text
              safeErrorMessage = errorText.slice(0, 200);
            }
          } else {
            safeErrorMessage = errorText.slice(0, 200);
          }
        } catch {
          // If the response is not valid JSON, log a truncated version
          safeErrorMessage = errorText.slice(0, 200);
        }
        this.logger.error(
          `[Telegram] API error (${response.status}): ${safeErrorMessage}`,
        );
        return false;
      }

      const data = (await response.json()) as { ok: boolean };
      if (!data.ok) {
        this.logger.error(`[Telegram] API returned ok=false`);
        return false;
      }

      this.logger.debug("[Telegram] Message sent successfully");
      return true;
    } catch (err) {
      this.logger.error(
        `[Telegram] Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Get emoji for trade type (uses exported helper)
   */
  private getTradeEmoji(type: TradeNotificationType): string {
    return getTradeEmoji(type);
  }

  /**
   * Get action text for trade type (uses exported helper)
   */
  private getTradeAction(type: TradeNotificationType): string {
    return getTradeAction(type);
  }

  /**
   * Escape HTML entities for Telegram message (uses exported helper)
   */
  private escapeHtml(text: string): string {
    return escapeHtml(text);
  }

  /**
   * Format price for display - always shows $X.XX format for consistency
   */
  private formatPrice(price: number): string {
    return formatPrice(price);
  }
}

/**
 * Format price for display - always shows $X.XX format for consistency
 * Returns "Unknown" for negative prices (sentinel value -1 indicates unknown payout)
 */
export function formatPrice(price: number): string {
  // Return "Unknown" for negative prices (sentinel value for undetermined payout)
  // or for special numeric values like NaN/Infinity that indicate calculation errors
  if (price < 0 || !Number.isFinite(price) || Number.isNaN(price)) {
    return "Unknown";
  }
  // Always show as dollars for consistency with balance displays
  return `$${price.toFixed(2)}`;
}

/**
 * Escape HTML entities for Telegram message
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Get emoji for trade notification type
 */
export function getTradeEmoji(type: TradeNotificationType): string {
  switch (type) {
    case "BUY":
      return "🛒";
    case "SELL":
      return "💵";
    case "REDEEM":
      return "🏦";
    case "HEDGE":
      return "🛡️";
    case "HEDGE_EXIT":
      return "🔓";
    case "STACK":
      return "📦";
    case "STOP_LOSS":
      return "🛑";
    case "SCALP":
      return "⚡";
    case "FRONTRUN":
      return "🏃";
    default:
      return "📌";
  }
}

/**
 * Get action text for trade notification type
 */
export function getTradeAction(type: TradeNotificationType): string {
  switch (type) {
    case "BUY":
      return "Position Bought";
    case "SELL":
      return "Position Sold";
    case "REDEEM":
      return "Position Redeemed";
    case "HEDGE":
      return "Hedge Placed";
    case "HEDGE_EXIT":
      return "Hedge Exited";
    case "STACK":
      return "Position Stacked";
    case "STOP_LOSS":
      return "Stop-Loss Triggered";
    case "SCALP":
      return "Scalp Profit Taken";
    case "FRONTRUN":
      return "Copy Trade Executed";
    default:
      return "Trade Executed";
  }
}

/**
 * Load Telegram configuration from environment variables
 */
export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  const topicId = process.env.TELEGRAM_TOPIC_ID || undefined;
  const notificationName =
    process.env.TELEGRAM_NOTIFICATION_NAME ||
    DEFAULT_TELEGRAM_CONFIG.notificationName;
  const pnlIntervalMinutes = parseInt(
    process.env.TELEGRAM_PNL_INTERVAL_MINUTES ?? "60",
    10,
  );
  const silent = (process.env.TELEGRAM_SILENT ?? "").toLowerCase() === "true";

  return {
    botToken,
    chatId,
    topicId,
    notificationName,
    pnlIntervalMinutes: Number.isFinite(pnlIntervalMinutes)
      ? pnlIntervalMinutes
      : 60,
    silent,
    enabled: Boolean(botToken && chatId),
  };
}

/**
 * Create a Telegram service instance
 */
export function createTelegramService(logger: Logger): TelegramService {
  const config = loadTelegramConfig();
  return new TelegramService(config, logger);
}
