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
 * Check if an error response indicates a Cloudflare block
 */
export function isCloudflareBlock(error: unknown): boolean {
  if (!error) return false;

  const errorStr = typeof error === "string" ? error : JSON.stringify(error);

  // Common Cloudflare block indicators
  const cloudflareIndicators = [
    "Sorry, you have been blocked",
    "Attention Required! | Cloudflare",
    "cloudflare",
    "cf-error",
    "cf-wrapper",
    "You are unable to access",
    "Ray ID:",
  ];

  const lowerErrorStr = errorStr.toLowerCase();
  return cloudflareIndicators.some(
    (indicator) =>
      lowerErrorStr.includes(indicator.toLowerCase()) ||
      errorStr.includes(indicator),
  );
}

/**
 * Check if an error indicates rate limiting
 */
export function isRateLimited(error: unknown): boolean {
  if (!error) return false;

  const errorStr = typeof error === "string" ? error : JSON.stringify(error);
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
  const errorStr = typeof error === "string" ? error : JSON.stringify(error);
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
 * Format error for logging (strips sensitive data, limits length)
 */
export function formatErrorForLog(error: unknown, maxLength = 500): string {
  if (!error) return "Unknown error";

  let errorStr = typeof error === "string" ? error : JSON.stringify(error);

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
