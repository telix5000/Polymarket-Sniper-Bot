/**
 * V2 Error Handling - Utilities for detecting and handling common errors
 *
 * Error Taxonomy:
 * - CLOUDFLARE_BLOCKED: Cloudflare challenge/block response (403 with CF headers)
 * - HTTP_4XX: Client errors (400-499, excluding auth/rate limit)
 * - HTTP_5XX: Server errors (500-599)
 * - TIMEOUT: Request timeout
 * - INVALID_ORDERBOOK: Orderbook data is invalid or missing
 * - SPREAD_TOO_WIDE: Bid/ask spread exceeds threshold
 * - PRICE_OUT_OF_RANGE: Price outside acceptable bounds
 * - INSUFFICIENT_BALANCE: Not enough USDC balance
 * - INSUFFICIENT_ALLOWANCE: Token allowance too low
 * - AUTH_FAILED: Authentication/authorization failed
 * - RATE_LIMITED: Rate limit exceeded
 * - NETWORK_ERROR: Network connectivity issues
 * - API_ERROR: Generic API error
 * - VPN_WRITE_NOT_ROUTED: Write traffic not going through VPN
 * - UNKNOWN: Unclassified error
 */

/**
 * Error codes for common failure scenarios
 */
export enum ErrorCode {
  // Cloudflare specific
  CLOUDFLARE_BLOCKED = "CLOUDFLARE_BLOCKED",

  // HTTP status categories
  HTTP_4XX = "HTTP_4XX",
  HTTP_5XX = "HTTP_5XX",
  TIMEOUT = "TIMEOUT",

  // Orderbook/market errors
  INVALID_ORDERBOOK = "INVALID_ORDERBOOK",
  SPREAD_TOO_WIDE = "SPREAD_TOO_WIDE",
  PRICE_OUT_OF_RANGE = "PRICE_OUT_OF_RANGE",

  // Balance/allowance errors
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  INSUFFICIENT_ALLOWANCE = "INSUFFICIENT_ALLOWANCE",

  // Auth/rate limiting
  RATE_LIMITED = "RATE_LIMITED",
  AUTH_FAILED = "AUTH_FAILED",

  // Network errors
  NETWORK_ERROR = "NETWORK_ERROR",

  // VPN routing errors
  VPN_WRITE_NOT_ROUTED = "VPN_WRITE_NOT_ROUTED",

  // Generic
  API_ERROR = "API_ERROR",
  UNKNOWN = "UNKNOWN",

  // Legacy alias for backward compatibility
  CLOUDFLARE_BLOCK = "CLOUDFLARE_BLOCKED",
}

/**
 * Parsed error information
 */
export interface ParsedError {
  code: ErrorCode;
  message: string;
  recoverable: boolean;
  retryAfterMs?: number;
}

/**
 * Internal set of keys that may contain sensitive information and should be redacted.
 * Keys are compared case-insensitively.
 */
const SENSITIVE_KEYS = new Set<string>([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "signature",
  "x-signature",
  "poly_signature",
  "poly_api_key",
  "poly_passphrase",
  "private-key",
]);

/**
 * Safely convert an unknown error to a string, handling circular refs and Error instances.
 * Never throws.
 */
function safeErrorToString(error: unknown): string {
  if (!error) return "";

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    // Circular reference or other JSON.stringify failure
    return String(error);
  }
}

/**
 * Recursively redacts values of known sensitive keys in an arbitrary data structure.
 */
function redactSensitiveData(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;

  if (seen.has(obj)) {
    return "[Circular]";
  }
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isExplicitSensitive = SENSITIVE_KEYS.has(lowerKey);
    const isHeuristicallySensitive =
      lowerKey.includes("token") ||
      lowerKey.includes("key") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("pass") ||
      lowerKey.includes("auth") ||
      lowerKey.includes("signature");

    if (isExplicitSensitive || isHeuristicallySensitive) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactSensitiveData(val, seen);
    }
  }

  return redacted;
}

/**
 * Redact obvious credentials in plain text strings (best-effort).
 */
function redactSensitiveInString(message: string): string {
  let result = message;

  // Patterns like "Authorization: Bearer abc123", "api_key=abc123", "token: abc123"
  const patterns: RegExp[] = [
    /(Authorization)\s*:\s*([^\r\n]+)/gi,
    /(Proxy-Authorization)\s*:\s*([^\r\n]+)/gi,
    /\b(api[-_\s]*key)\s*[:=]\s*([^\s&"']+)/gi,
    /\b(token|access_token|refresh_token)\s*[:=]\s*([^\s&"']+)/gi,
    /\b(password|passwd)\s*[:=]\s*([^\s&"']+)/gi,
    /\b(POLY_SIGNATURE)\s*[:=]\s*([^\s&"']+)/gi,
    /\b(POLY_API_KEY)\s*[:=]\s*([^\s&"']+)/gi,
    /\b(POLY_PASSPHRASE)\s*[:=]\s*([^\s&"']+)/gi,
    /"(signature)"\s*:\s*"([^"]+)"/gi,
  ];

  for (const pattern of patterns) {
    result = result.replace(pattern, (_match, p1) => `${p1}: [REDACTED]`);
  }

  return result;
}

/**
 * Cloudflare detection result with extracted metadata
 */
export interface CloudflareBlockInfo {
  isBlocked: boolean;
  rayId?: string;
  statusCode?: number;
  server?: string;
}

/**
 * Check if an error response indicates a Cloudflare block.
 * Returns detailed info about the block including Ray ID for debugging.
 */
export function detectCloudflareBlock(error: unknown): CloudflareBlockInfo {
  if (!error) return { isBlocked: false };

  const errorStr = safeErrorToString(error);
  const lowerErrorStr = errorStr.toLowerCase();

  // Common Cloudflare block indicators in response body
  const cloudflareBodyIndicators = [
    "sorry, you have been blocked",
    "attention required! | cloudflare",
    "cf-error",
    "cf-wrapper",
    "you are unable to access",
    "checking your browser before accessing",
    "enable javascript and cookies to continue",
  ];

  // Check for Cloudflare indicators in body
  const hasBodyIndicator = cloudflareBodyIndicators.some((indicator) =>
    lowerErrorStr.includes(indicator),
  );

  // Check for Cloudflare headers (server: cloudflare, cf-ray header)
  const hasCloudflareServer =
    lowerErrorStr.includes("server: cloudflare") ||
    lowerErrorStr.includes('"server":"cloudflare"');
  const hasCfRay =
    lowerErrorStr.includes("cf-ray") || lowerErrorStr.includes("ray id");

  // Check for 403 status with Cloudflare context
  const has403 =
    errorStr.includes("403") ||
    errorStr.includes("Forbidden") ||
    lowerErrorStr.includes("status code 403");

  // It's a Cloudflare block if we see body indicators OR (403 + cloudflare headers)
  const isBlocked =
    hasBodyIndicator || (has403 && (hasCloudflareServer || hasCfRay));

  if (!isBlocked) return { isBlocked: false };

  // Extract Ray ID for debugging
  const rayIdPatterns = [
    /cf-ray[:\s]*([a-f0-9-]+)/i,
    /Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/i,
    /Ray ID:\s*<[^>]*>([^<]+)/i,
    /Ray ID:\s*([a-f0-9-]+)/i,
    /"cf-ray":\s*"([^"]+)"/i,
  ];

  let rayId: string | undefined;
  for (const pattern of rayIdPatterns) {
    const match = errorStr.match(pattern);
    if (match) {
      rayId = match[1].trim();
      break;
    }
  }

  return {
    isBlocked: true,
    rayId,
    statusCode: has403 ? 403 : undefined,
    server: hasCloudflareServer ? "cloudflare" : undefined,
  };
}

/**
 * Check if an error response indicates a Cloudflare block (simple boolean version)
 */
export function isCloudflareBlock(error: unknown): boolean {
  return detectCloudflareBlock(error).isBlocked;
}

/**
 * Check if an error indicates rate limiting
 */
export function isRateLimited(error: unknown): boolean {
  if (!error) return false;

  const errorStr = safeErrorToString(error);
  const lowerErrorStr = errorStr.toLowerCase();

  return (
    lowerErrorStr.includes("rate limit") ||
    lowerErrorStr.includes("too many requests") ||
    errorStr.includes("429") ||
    errorStr.includes('"status":429')
  );
}

/**
 * Parse an error and return structured information
 */
export function parseError(error: unknown): ParsedError {
  const errorStr = safeErrorToString(error);
  const lowerErrorStr = errorStr.toLowerCase();

  // Check for Cloudflare block first (highest priority)
  if (isCloudflareBlock(error)) {
    const cfInfo = detectCloudflareBlock(error);
    return {
      code: ErrorCode.CLOUDFLARE_BLOCKED,
      message: `Request blocked by Cloudflare (403). Your IP may be geo-blocked or flagged. ${cfInfo.rayId ? `Ray ID: ${cfInfo.rayId}. ` : ""}Consider using a VPN.`,
      recoverable: false,
    };
  }

  // Rate limiting
  if (isRateLimited(error)) {
    return {
      code: ErrorCode.RATE_LIMITED,
      message: "Rate limited by API. Waiting before retry.",
      recoverable: true,
      retryAfterMs: 60000, // Default 1 minute
    };
  }

  // Authentication errors
  if (
    errorStr.includes("401") ||
    lowerErrorStr.includes("unauthorized") ||
    lowerErrorStr.includes("invalid api key") ||
    lowerErrorStr.includes("authentication failed")
  ) {
    return {
      code: ErrorCode.AUTH_FAILED,
      message: "Authentication failed. Check your API credentials.",
      recoverable: false,
    };
  }

  // Balance/allowance errors
  if (
    lowerErrorStr.includes("not enough balance") ||
    lowerErrorStr.includes("insufficient balance") ||
    lowerErrorStr.includes("balance too low")
  ) {
    return {
      code: ErrorCode.INSUFFICIENT_BALANCE,
      message: "Insufficient USDC balance to execute order.",
      recoverable: false,
    };
  }

  if (
    lowerErrorStr.includes("not enough allowance") ||
    lowerErrorStr.includes("insufficient allowance")
  ) {
    return {
      code: ErrorCode.INSUFFICIENT_ALLOWANCE,
      message: "Token allowance too low. Approve more tokens.",
      recoverable: false,
    };
  }

  // Timeout errors
  if (
    lowerErrorStr.includes("timeout") ||
    lowerErrorStr.includes("etimedout") ||
    lowerErrorStr.includes("timed out")
  ) {
    return {
      code: ErrorCode.TIMEOUT,
      message: "Request timed out. Check network connectivity.",
      recoverable: true,
      retryAfterMs: 5000,
    };
  }

  // Network errors
  if (
    lowerErrorStr.includes("econnrefused") ||
    lowerErrorStr.includes("enotfound") ||
    lowerErrorStr.includes("network error") ||
    lowerErrorStr.includes("fetch failed")
  ) {
    return {
      code: ErrorCode.NETWORK_ERROR,
      message: "Network connection error. Check your internet connection.",
      recoverable: true,
      retryAfterMs: 5000,
    };
  }

  // Orderbook/market errors
  if (
    lowerErrorStr.includes("no orderbook") ||
    lowerErrorStr.includes("orderbook not found") ||
    lowerErrorStr.includes("invalid orderbook")
  ) {
    return {
      code: ErrorCode.INVALID_ORDERBOOK,
      message: "Orderbook unavailable or invalid.",
      recoverable: false,
    };
  }

  // Price/spread errors
  if (
    lowerErrorStr.includes("spread too wide") ||
    lowerErrorStr.includes("spread exceeds")
  ) {
    return {
      code: ErrorCode.SPREAD_TOO_WIDE,
      message: "Market spread is too wide for safe trading.",
      recoverable: false,
    };
  }

  if (
    lowerErrorStr.includes("price out of range") ||
    lowerErrorStr.includes("price too high") ||
    lowerErrorStr.includes("price too low") ||
    lowerErrorStr.includes("outside price bounds")
  ) {
    return {
      code: ErrorCode.PRICE_OUT_OF_RANGE,
      message: "Price is outside acceptable bounds.",
      recoverable: false,
    };
  }

  // HTTP 5xx errors
  if (
    errorStr.includes("500") ||
    errorStr.includes("502") ||
    errorStr.includes("503") ||
    errorStr.includes("504") ||
    lowerErrorStr.includes("internal server error") ||
    lowerErrorStr.includes("bad gateway") ||
    lowerErrorStr.includes("service unavailable")
  ) {
    return {
      code: ErrorCode.HTTP_5XX,
      message: "Server error. The API may be temporarily unavailable.",
      recoverable: true,
      retryAfterMs: 10000,
    };
  }

  // HTTP 4xx errors (generic, after specific ones)
  if (
    errorStr.includes("400") ||
    errorStr.includes("404") ||
    lowerErrorStr.includes("bad request") ||
    lowerErrorStr.includes("not found")
  ) {
    return {
      code: ErrorCode.HTTP_4XX,
      message: "API request failed. The request may be malformed or the resource not found.",
      recoverable: false,
    };
  }

  // VPN routing errors
  if (
    lowerErrorStr.includes("vpn write not routed") ||
    lowerErrorStr.includes("write traffic not routed")
  ) {
    return {
      code: ErrorCode.VPN_WRITE_NOT_ROUTED,
      message: "Write traffic not routed through VPN. Check VPN configuration.",
      recoverable: false,
    };
  }

  return {
    code: ErrorCode.UNKNOWN,
    message: typeof error === "string" ? error : "Unknown error occurred",
    recoverable: false,
  };
}

/**
 * Format error for logging (strips sensitive data, limits length)
 */
export function formatErrorForLog(error: unknown, maxLength = 500): string {
  if (!error) return "Unknown error";

  let errorStr: string;

  if (typeof error === "string") {
    errorStr = redactSensitiveInString(error);
  } else {
    // Always redact sensitive data from objects first
    try {
      const redacted = redactSensitiveData(error);
      errorStr = JSON.stringify(redacted);
    } catch {
      // Fallback to best-effort string conversion if JSON serialization fails
      errorStr = redactSensitiveInString(String(error));
    }

    errorStr = redactSensitiveInString(errorStr);
  }

  // If it's a Cloudflare block, provide a clean message instead of the HTML
  if (isCloudflareBlock(errorStr)) {
    // Extract Ray ID if present - handles multiple HTML formats:
    // - <strong class="font-semibold">abc123</strong>
    // - <strong>abc123</strong>
    // - Ray ID: abc123
    const rayIdPatterns = [
      /Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/i,
      /Ray ID:\s*<[^>]*>([^<]+)/i,
      /Ray ID:\s*([a-f0-9]+)/i,
    ];

    let rayId: string | null = null;
    for (const pattern of rayIdPatterns) {
      const match = errorStr.match(pattern);
      if (match) {
        rayId = match[1].trim();
        break;
      }
    }

    return `Cloudflare block (403 Forbidden)${rayId ? ` - Ray ID: ${rayId}` : ""}`;
  }

  // Truncate long messages
  if (errorStr.length > maxLength) {
    errorStr = errorStr.substring(0, maxLength) + "... (truncated)";
  }

  return errorStr;
}

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB ACTIONS ANNOTATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if running in GitHub Actions environment (for error-handling module)
 */
function isInGitHubActions(): boolean {
  return process.env.GITHUB_ACTIONS === "true";
}

/**
 * Emit a GitHub Actions error annotation
 * @param message Error message
 * @param file Optional file path
 * @param line Optional line number
 */
export function ghErrorAnnotation(
  message: string,
  file?: string,
  line?: number,
): void {
  if (isInGitHubActions()) {
    const location = file ? `,file=${file}${line ? `,line=${line}` : ""}` : "";
    console.log(`::error${location}::${message}`);
  } else {
    console.error(`❌ ERROR: ${message}`);
  }
}

/**
 * Emit a GitHub Actions warning annotation
 * @param message Warning message
 */
export function ghWarningAnnotation(message: string): void {
  if (isInGitHubActions()) {
    console.log(`::warning::${message}`);
  } else {
    console.warn(`⚠️ WARNING: ${message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURED CLOUDFLARE BLOCK LOGGING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structured log event for Cloudflare blocks
 */
export interface CloudflareBlockEvent {
  event: "CLOUDFLARE_BLOCKED";
  traceId: string;
  timestamp: string;
  host: string;
  statusCode: number;
  rayId?: string;
  server?: string;
  remediation: string[];
}

/**
 * Emit a structured Cloudflare block event with GitHub Actions annotation
 *
 * @param traceId - Trace ID for correlation
 * @param host - The host that was blocked (sanitized, no path/query)
 * @param error - The original error
 */
export function emitCloudflareBlockEvent(
  traceId: string,
  host: string,
  error: unknown,
): CloudflareBlockEvent {
  const cfInfo = detectCloudflareBlock(error);

  const event: CloudflareBlockEvent = {
    event: "CLOUDFLARE_BLOCKED",
    traceId,
    timestamp: new Date().toISOString(),
    host,
    statusCode: cfInfo.statusCode ?? 403,
    rayId: cfInfo.rayId,
    server: cfInfo.server,
    remediation: [
      "Ensure WRITE host (clob.polymarket.com) routes through VPN",
      "Check VPN is active and properly configured",
      "Try a different VPN server/region",
      "Verify no bypass routes exist for the WRITE host",
    ],
  };

  // Emit structured JSON log
  console.log(JSON.stringify(event));

  // Emit GitHub Actions annotation with concise message
  const message =
    `Cloudflare blocked request to ${host} (403).` +
    (cfInfo.rayId ? ` Ray ID: ${cfInfo.rayId}.` : "") +
    ` Consider using a VPN or checking VPN configuration.`;

  ghErrorAnnotation(message);

  return event;
}

/**
 * Map error to a DiagReason (for diagnostic workflow integration)
 * Returns a standardized reason code based on the error
 */
export function mapErrorToDiagReason(
  error: unknown,
): "cloudflare_blocked" | "api_error" | "timeout" | "network_error" | "unknown_error" {
  const parsed = parseError(error);

  switch (parsed.code) {
    case ErrorCode.CLOUDFLARE_BLOCKED:
    case ErrorCode.CLOUDFLARE_BLOCK:
      return "cloudflare_blocked";
    case ErrorCode.TIMEOUT:
      return "timeout";
    case ErrorCode.NETWORK_ERROR:
      return "network_error";
    case ErrorCode.API_ERROR:
    case ErrorCode.HTTP_4XX:
    case ErrorCode.HTTP_5XX:
    case ErrorCode.AUTH_FAILED:
    case ErrorCode.RATE_LIMITED:
      return "api_error";
    default:
      return "unknown_error";
  }
}
