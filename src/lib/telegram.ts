/**
 * V2 Telegram - Notifications
 */

import axios from "axios";

interface TelegramConfig {
  token: string;
  chatId: string;
  silent: boolean;
}

let config: TelegramConfig | undefined;

/**
 * Initialize from environment
 */
export function initTelegram(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT;
  const silent = process.env.TELEGRAM_SILENT === "true";

  if (token && chatId) {
    config = { token, chatId, silent };
  }
}

/**
 * Send message
 */
export async function sendTelegram(title: string, message: string): Promise<void> {
  console.log(`[${title}] ${message}`);

  if (!config) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        chat_id: config.chatId,
        text: `*${title}*\n${message}`,
        parse_mode: "Markdown",
        disable_notification: config.silent,
      },
      { timeout: 5000 },
    );
  } catch {
    // Silent fail
  }
}

/**
 * Check if enabled
 */
export function isTelegramEnabled(): boolean {
  return config !== undefined;
}
