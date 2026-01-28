/**
 * V2 Telegram - Notifications
 *
 * Includes rate limiting and exponential backoff to handle 429 errors.
 */

import axios, { AxiosError } from "axios";

interface TelegramConfig {
  token: string;
  chatId: string;
  silent: boolean;
}

let config: TelegramConfig | undefined;

// Rate limiting state
let lastSendTime = 0;
const MIN_INTERVAL_MS = 1000; // Minimum 1 second between messages
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

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
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send message with rate limiting and retry logic
 */
export async function sendTelegram(
  title: string,
  message: string,
): Promise<void> {
  console.log(`[${title}] ${message}`);

  if (!config) return;

  // Rate limiting: ensure minimum interval between messages
  // Reserve the time slot immediately to prevent race conditions with concurrent calls
  const now = Date.now();
  const elapsed = now - lastSendTime;
  const waitTime = elapsed < MIN_INTERVAL_MS ? MIN_INTERVAL_MS - elapsed : 0;
  lastSendTime = now + waitTime; // Reserve the slot for when we'll actually send

  if (waitTime > 0) {
    await sleep(waitTime);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      return; // Success, exit
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;

      // Handle rate limiting (429)
      if (status === 429 && attempt < MAX_RETRIES) {
        // Try to get retry-after from response, otherwise use exponential backoff
        const retryAfter = axiosError.response?.headers?.["retry-after"];
        const parsedRetryAfter = retryAfter
          ? parseInt(String(retryAfter), 10)
          : NaN;

        // Use retry-after header if valid, otherwise exponential backoff
        const delayMs =
          !Number.isNaN(parsedRetryAfter) && parsedRetryAfter > 0
            ? parsedRetryAfter * 1000
            : BASE_RETRY_DELAY_MS * Math.pow(2, attempt);

        console.log(
          `[Telegram] Rate limited (429), retrying in ${delayMs}ms...`,
        );
        lastSendTime = Date.now() + delayMs; // Update reservation during retry
        await sleep(delayMs);
        continue;
      }

      // Max retries exceeded for 429 errors, log and exit
      if (status === 429) {
        console.log(
          `[Telegram] Rate limit exceeded after ${MAX_RETRIES} retries, skipping message`,
        );
      }
      // Other errors are silently ignored to avoid blocking the bot
      return;
    }
  }
  return; // Explicit return after retry loop exhaustion
}

/**
 * Check if enabled
 */
export function isTelegramEnabled(): boolean {
  return config !== undefined;
}
