/**
 * Diagnostic Mode (DIAG_MODE) - One-shot workflow for auth/execution verification
 *
 * When DIAG_MODE=true, runs a deterministic workflow:
 * 1. WHALE_BUY: Wait for first whale signal, attempt BUY of 1 share
 * 2. WHALE_SELL: Attempt SELL of 1 share (same market/outcome)
 * 3. WHALE_HEDGE: If BUY executed, simulate adverse move and verify hedge logic
 * 4. SCAN_BUY: Run market scan once, attempt BUY of 1 share
 * 5. SCAN_SELL: Attempt SELL of 1 share (same market/outcome)
 * 6. SCAN_HEDGE: If BUY executed, simulate adverse move and verify hedge logic
 *
 * Then EXIT (do not resume normal operations).
 * Exit code 0 = workflow completed (even if actions rejected/skipped)
 * Exit code 1 = unexpected crash/uncaught exception
 *
 * TRACE LOGGING:
 * Each step emits structured trace events with traceId for correlation.
 * GitHub Actions integration emits ::group:: and ::endgroup:: for step grouping.
 */

import { randomUUID } from "crypto";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Diagnostic workflow steps */
export type DiagStep =
  | "WHALE_BUY"
  | "WHALE_SELL"
  | "WHALE_HEDGE"
  | "SCAN_BUY"
  | "SCAN_SELL"
  | "SCAN_HEDGE";

/** Result of a diagnostic action */
export type DiagResult = "OK" | "REJECTED" | "SKIPPED" | "ERROR";

/**
 * Rejection reasons - enum-style for consistency
 * These reasons explain why an action was REJECTED or SKIPPED
 */
export type DiagReason =
  // Market schema issues
  | "unsupported_market_schema"
  | "not_binary_market"
  | "cannot_resolve_outcome_token"
  // Orderbook issues
  | "orderbook_unavailable"
  | "insufficient_liquidity"
  | "price_out_of_range"
  | "spread_too_wide"
  | "invalid_orderbook"
  // Price formation
  | "price_clamped"
  | "price_too_high"
  | "price_too_low"
  // Trading limits
  | "cooldown_active"
  | "risk_limits_blocked"
  // Auth/connectivity issues
  | "no_wallet_credentials"
  | "ws_disconnected"
  | "api_error"
  | "cloudflare_blocked"
  | "network_error"
  | "timeout"
  | "auth_failed"
  | "rate_limited"
  // Balance/allowance
  | "insufficient_balance"
  | "insufficient_allowance"
  // Sell-specific
  | "no_position_to_sell"
  | "sell_skipped_no_buy"
  // Timeouts
  | "timeout_waiting_for_whale"
  | "order_timeout"
  // VPN routing
  | "vpn_write_not_routed"
  // Hedge-specific
  | "hedge_not_triggered"
  | "hedge_order_rejected"
  | "hard_stop_triggered"
  // Other
  | "unknown_error";

/**
 * Trace event emitted during diagnostic workflow
 */
export interface DiagTraceEvent {
  diag: true;
  traceId: string;
  step: DiagStep;
  marketId?: string;
  tokenId?: string;
  outcomeLabel?: string;
  action: string;
  result: DiagResult;
  reason?: DiagReason;
  /** Additional detail (MUST BE SAFE - no secrets) */
  detail?: Record<string, unknown>;
  timestamp: string;
}

/**
 * Diagnostic mode configuration
 */
export interface DiagModeConfig {
  /** Enable diagnostic mode */
  enabled: boolean;
  /** Timeout in seconds waiting for whale signal (default: 60) */
  whaleTimeoutSec: number;
  /** Timeout in seconds for order execution (default: 30) */
  orderTimeoutSec: number;
  /** Force exactly 1 share for all orders */
  forceShares: number;
}

/**
 * Result of a single diagnostic step
 */
export interface DiagStepResult {
  step: DiagStep;
  result: DiagResult;
  reason?: DiagReason;
  marketId?: string;
  tokenId?: string;
  outcomeLabel?: string;
  detail?: Record<string, unknown>;
  traceEvents: DiagTraceEvent[];
}

/**
 * Complete diagnostic workflow result
 */
export interface DiagWorkflowResult {
  traceId: string;
  startTime: Date;
  endTime: Date;
  steps: DiagStepResult[];
  exitCode: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// ENVIRONMENT DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if running in GitHub Actions environment
 */
export function isGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB ACTIONS LOG HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start a GitHub Actions log group
 * @param title Group title
 */
export function ghGroup(title: string): void {
  if (isGitHubActions()) {
    console.log(`::group::${title}`);
  } else {
    console.log(`\n═══ ${title} ═══`);
  }
}

/**
 * End a GitHub Actions log group
 */
export function ghEndGroup(): void {
  if (isGitHubActions()) {
    console.log("::endgroup::");
  } else {
    console.log("═══════════════════════════════════════════════════════════");
  }
}

/**
 * Emit a GitHub Actions error annotation
 * @param message Error message
 */
export function ghError(message: string): void {
  if (isGitHubActions()) {
    console.log(`::error::${message}`);
  } else {
    console.error(`❌ ERROR: ${message}`);
  }
}

/**
 * Emit a GitHub Actions warning annotation
 * @param message Warning message
 */
export function ghWarning(message: string): void {
  if (isGitHubActions()) {
    console.log(`::warning::${message}`);
  } else {
    console.warn(`⚠️ WARNING: ${message}`);
  }
}

/**
 * Emit a GitHub Actions notice annotation
 * @param message Notice message
 */
export function ghNotice(message: string): void {
  if (isGitHubActions()) {
    console.log(`::notice::${message}`);
  } else {
    console.log(`ℹ️ NOTICE: ${message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRACE HELPER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DiagTracer - Manages trace events for a diagnostic workflow
 */
export class DiagTracer {
  private readonly traceId: string;
  private events: DiagTraceEvent[] = [];

  constructor(traceId?: string) {
    this.traceId = traceId ?? randomUUID();
  }

  /**
   * Get the trace ID
   */
  getTraceId(): string {
    return this.traceId;
  }

  /**
   * Emit a trace event
   */
  trace(params: {
    step: DiagStep;
    action: string;
    result: DiagResult;
    marketId?: string;
    tokenId?: string;
    outcomeLabel?: string;
    reason?: DiagReason;
    detail?: Record<string, unknown>;
  }): DiagTraceEvent {
    const event: DiagTraceEvent = {
      diag: true,
      traceId: this.traceId,
      step: params.step,
      action: params.action,
      result: params.result,
      timestamp: new Date().toISOString(),
    };

    if (params.marketId) event.marketId = params.marketId;
    if (params.tokenId) event.tokenId = params.tokenId;
    if (params.outcomeLabel) event.outcomeLabel = params.outcomeLabel;
    if (params.reason) event.reason = params.reason;
    if (params.detail) event.detail = sanitizeDetail(params.detail);

    this.events.push(event);
    this.logEvent(event);

    return event;
  }

  /**
   * Log a trace event in structured format
   */
  private logEvent(event: DiagTraceEvent): void {
    // Log as JSON for structured logging
    console.log(JSON.stringify(event));
  }

  /**
   * Get all trace events
   */
  getEvents(): DiagTraceEvent[] {
    return [...this.events];
  }

  /**
   * Get events for a specific step
   */
  getStepEvents(step: DiagStep): DiagTraceEvent[] {
    return this.events.filter((e) => e.step === step);
  }

  /**
   * Clear all events
   */
  clear(): void {
    this.events = [];
  }
}

/**
 * Sanitize detail object to remove sensitive data
 */
/**
 * Check if a key name is sensitive and should be redacted.
 * Uses specific patterns to avoid false positives like "tokenId", "marketKey", etc.
 */
function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();

  // Specific sensitive key patterns (exact matches or specific suffixes/prefixes)
  const sensitivePatterns = [
    /^(private)?key$/i, // "key", "privateKey"
    /^api[_-]?key$/i, // "apiKey", "api_key", "api-key"
    /^secret[_-]?key$/i, // "secretKey", "secret_key"
    /secret$/i, // ends with "secret"
    /^password$/i,
    /^passwd$/i,
    /^credential[s]?$/i,
    /^auth[_-]?token$/i, // "authToken", "auth_token"
    /^access[_-]?token$/i, // "accessToken", "access_token"
    /^bearer[_-]?token$/i, // "bearerToken", "bearer_token"
    /^refresh[_-]?token$/i, // "refreshToken", "refresh_token"
    /^jwt$/i,
    /^api[_-]?secret$/i,
    /^private[_-]?key$/i,
  ];

  return sensitivePatterns.some((pattern) => pattern.test(lowerKey));
}

export function sanitizeDetail(
  detail: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(detail)) {
    // Skip sensitive keys using specific pattern matching
    if (isSensitiveKey(key)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }

    // Handle string values that might contain sensitive data
    if (typeof value === "string") {
      // Redact potential private keys (0x followed by 64 hex chars)
      if (/^0x[a-fA-F0-9]{64}$/.test(value)) {
        sanitized[key] = "[REDACTED_KEY]";
        continue;
      }
      // Redact long hex strings that might be secrets
      if (/^[a-fA-F0-9]{32,}$/.test(value)) {
        sanitized[key] = "[REDACTED_HEX]";
        continue;
      }
    }

    // Recursively sanitize nested objects
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeDetail(value as Record<string, unknown>);
      continue;
    }

    // Recursively sanitize arrays containing objects
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          return sanitizeDetail(item as Record<string, unknown>);
        }
        return item;
      });
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse diagnostic mode configuration from environment
 */
export function parseDiagModeConfig(): DiagModeConfig {
  const enabled =
    process.env.DIAG_MODE === "true" || process.env.DIAG_MODE === "1";

  const whaleTimeoutSec = parseInt(
    process.env.DIAG_WHALE_TIMEOUT_SEC ?? "60",
    10,
  );
  const orderTimeoutSec = parseInt(
    process.env.DIAG_ORDER_TIMEOUT_SEC ?? "30",
    10,
  );
  const forceShares = parseInt(process.env.DIAG_FORCE_SHARES ?? "1", 10);

  return {
    enabled,
    whaleTimeoutSec: isNaN(whaleTimeoutSec) ? 60 : whaleTimeoutSec,
    orderTimeoutSec: isNaN(orderTimeoutSec) ? 30 : orderTimeoutSec,
    forceShares: isNaN(forceShares) || forceShares < 1 ? 1 : forceShares,
  };
}

/**
 * Check if diagnostic mode is enabled
 */
export function isDiagModeEnabled(): boolean {
  return process.env.DIAG_MODE === "true" || process.env.DIAG_MODE === "1";
}

// ═══════════════════════════════════════════════════════════════════════════
// TIMEOUT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a promise that rejects after a timeout
 */
export function createTimeout<T>(
  ms: number,
  reason: DiagReason,
): { promise: Promise<T>; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new DiagTimeoutError(reason, ms));
    }, ms);
  });

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return { promise, cancel };
}

/**
 * Timeout error with reason
 */
export class DiagTimeoutError extends Error {
  public readonly reason: DiagReason;
  public readonly timeoutMs: number;

  constructor(reason: DiagReason, timeoutMs: number) {
    super(`Diagnostic timeout: ${reason} (${timeoutMs}ms)`);
    this.name = "DiagTimeoutError";
    this.reason = reason;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run an async operation with timeout
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  reason: DiagReason,
): Promise<T> {
  const timeout = createTimeout<T>(timeoutMs, reason);

  try {
    const result = await Promise.race([operation, timeout.promise]);
    timeout.cancel();
    return result;
  } catch (err) {
    timeout.cancel();
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// REASON MAPPING HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Map common error messages to enum-style rejection reasons
 */
export function mapErrorToReason(error: unknown): DiagReason {
  if (error instanceof DiagTimeoutError) {
    return error.reason;
  }

  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  // Auth/connectivity
  if (message.includes("private_key") || message.includes("wallet")) {
    return "no_wallet_credentials";
  }
  if (
    message.includes("websocket") ||
    message.includes("ws ") ||
    message.includes("disconnected")
  ) {
    return "ws_disconnected";
  }

  // Market schema
  if (message.includes("schema") || message.includes("unsupported")) {
    return "unsupported_market_schema";
  }
  if (message.includes("binary") || message.includes("not binary")) {
    return "not_binary_market";
  }
  // More specific pattern for outcome token resolution errors
  if (
    message.includes("outcome token") ||
    (message.includes("outcome") && message.includes("token")) ||
    message.includes("resolve outcome token") ||
    message.includes("cannot resolve outcome")
  ) {
    return "cannot_resolve_outcome_token";
  }

  // Orderbook
  if (message.includes("orderbook") || message.includes("order book")) {
    return "orderbook_unavailable";
  }
  if (message.includes("liquidity") || message.includes("depth")) {
    return "insufficient_liquidity";
  }
  if (
    message.includes("price") &&
    (message.includes("range") || message.includes("bound"))
  ) {
    return "price_out_of_range";
  }

  // Trading limits
  if (message.includes("cooldown")) {
    return "cooldown_active";
  }
  if (message.includes("risk") || message.includes("limit")) {
    return "risk_limits_blocked";
  }

  // API
  if (
    message.includes("api") ||
    message.includes("request failed") ||
    message.includes("fetch")
  ) {
    return "api_error";
  }

  // Timeout
  if (message.includes("timeout")) {
    return "order_timeout";
  }

  return "unknown_error";
}
