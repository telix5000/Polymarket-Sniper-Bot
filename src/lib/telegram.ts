/**
 * V2 Telegram Notifications
 * Simple alerting utility
 */

import axios from "axios";

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  silent?: boolean;
}

let telegramConfig: TelegramConfig | undefined;

/**
 * Initialize Telegram notifications
 */
export function initTelegram(config?: TelegramConfig): void {
  if (config?.botToken && config?.chatId) {
    telegramConfig = config;
  }
}

/**
 * Initialize from environment variables
 */
export function initTelegramFromEnv(): void {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT;
  const silent = process.env.TELEGRAM_SILENT === "true";

  if (botToken && chatId) {
    telegramConfig = { botToken, chatId, silent };
  }
}

/**
 * Send a Telegram message
 */
export async function sendTelegram(title: string, message: string): Promise<void> {
  // Always log to console
  console.log(`[${title}] ${message}`);

  if (!telegramConfig) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`,
      {
        chat_id: telegramConfig.chatId,
        text: `*${title}*\n${message}`,
        parse_mode: "Markdown",
        disable_notification: telegramConfig.silent,
      },
      { timeout: 5000 },
    );
  } catch {
    // Silently fail - don't let Telegram issues stop trading
  }
}

/**
 * Check if Telegram is configured
 */
export function isTelegramEnabled(): boolean {
  return telegramConfig !== undefined;
}
