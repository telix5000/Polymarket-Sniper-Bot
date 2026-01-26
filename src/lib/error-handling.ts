/**
 * V2 Error Handling - Utilities for detecting and handling common errors
 */

/**
 * Error codes for common failure scenarios
 */
export enum ErrorCode {
  CLOUDFLARE_BLOCK = "CLOUDFLARE_BLOCK",
  RATE_LIMITED = "RATE_LIMITED",
  AUTH_FAILED = "AUTH_FAILED",
  NETWORK_ERROR = "NETWORK_ERROR",
  API_ERROR = "API_ERROR",
  UNKNOWN = "UNKNOWN",
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
 * Check if an error response indicates a Cloudflare block
 */
export function isCloudflareBlock(error: unknown): boolean {
  if (!error) return false;

  const errorStr = safeErrorToString(error);

  // Common Cloudflare block indicators
  const cloudflareIndicators = [
    "sorry, you have been blocked",
    "attention required! | cloudflare",
    "cloudflare",
    "cf-error",
    "cf-wrapper",
    "you are unable to access",
    "ray id:",
  ];

  const lowerErrorStr = errorStr.toLowerCase();
  return cloudflareIndicators.some((indicator) =>
    lowerErrorStr.includes(indicator),
  );
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
  if (isCloudflareBlock(error)) {
    return {
      code: ErrorCode.CLOUDFLARE_BLOCK,
      message:
        "Request blocked by Cloudflare. Your IP may be geo-blocked or flagged. Consider using a VPN.",
      recoverable: false,
    };
  }

  if (isRateLimited(error)) {
    return {
      code: ErrorCode.RATE_LIMITED,
      message: "Rate limited by API. Waiting before retry.",
      recoverable: true,
      retryAfterMs: 60000, // Default 1 minute
    };
  }

  // Check for common auth errors
  const errorStr = safeErrorToString(error);
  if (
    errorStr.includes("401") ||
    errorStr.includes("Unauthorized") ||
    errorStr.includes("Invalid api key")
  ) {
    return {
      code: ErrorCode.AUTH_FAILED,
      message: "Authentication failed. Check your API credentials.",
      recoverable: false,
    };
  }

  // Network errors
  if (
    errorStr.includes("ECONNREFUSED") ||
    errorStr.includes("ETIMEDOUT") ||
    errorStr.includes("network")
  ) {
    return {
      code: ErrorCode.NETWORK_ERROR,
      message: "Network connection error. Check your internet connection.",
      recoverable: true,
      retryAfterMs: 5000,
    };
  }

  // Generic API error
  if (errorStr.includes("400") || errorStr.includes("Bad Request")) {
    return {
      code: ErrorCode.API_ERROR,
      message: "API request failed. The request may be malformed.",
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
 * Extract Cloudflare Ray ID from error message or response.
 * Returns the Ray ID string if found, otherwise null.
 */
export function extractCloudflareRayId(error: unknown): string | null {
  if (!error) return null;

  const errorStr = safeErrorToString(error);

  // Handles multiple HTML/text formats:
  // - <strong class="font-semibold">abc123</strong>
  // - <strong>abc123</strong>
  // - Ray ID: abc123
  // - "ray_id":"abc123"
  const rayIdPatterns = [
    /Ray ID:\s*<strong[^>]*>([^<]+)<\/strong>/i,
    /Ray ID:\s*<[^>]*>([^<]+)/i,
    /Ray ID:\s*([a-f0-9]+)/i,
    /"ray[_-]?id"\s*:\s*"([^"]+)"/i,
  ];

  for (const pattern of rayIdPatterns) {
    const match = errorStr.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Extract HTTP status code from error or response object.
 * Returns the status code if found, otherwise "unknown".
 */
export function extractStatusCode(
  error: unknown,
): number | "unknown" {
  if (!error || typeof error !== "object") return "unknown";

  const obj = error as any;

  // Try multiple common locations for status code
  return (
    obj.response?.status ||
    obj.response?.statusCode ||
    obj.status ||
    obj.statusCode ||
    "unknown"
  );
}

/**
 * Extract Cloudflare headers from error response.
 * Returns an object with cf-ray and cf-cache-status headers if available.
 */
export function extractCloudflareHeaders(error: unknown): {
  cfRay?: string;
  cfCacheStatus?: string;
} {
  if (!error || typeof error !== "object") return {};

  const obj = error as any;
  const headers = obj.response?.headers || obj.headers || {};

  return {
    cfRay: headers["cf-ray"],
    cfCacheStatus: headers["cf-cache-status"],
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
    try {
      const redacted = redactSensitiveData(error);
      errorStr = JSON.stringify(redacted);
    } catch {
      // Fallback to best-effort string conversion if JSON serialization fails
      errorStr = redactSensitiveInString(String(error));
    }
  }

  // If it's a Cloudflare block, provide a clean message instead of the HTML
  if (isCloudflareBlock(errorStr)) {
    const rayId = extractCloudflareRayId(errorStr);
    return `Cloudflare block (403 Forbidden)${rayId ? ` - Ray ID: ${rayId}` : ""}`;
  }

  // Truncate long messages
  if (errorStr.length > maxLength) {
    errorStr = errorStr.substring(0, maxLength) + "... (truncated)";
  }

  return errorStr;
}
