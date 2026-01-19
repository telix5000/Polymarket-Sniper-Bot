/**
 * Secret Encoding Normalization Utility
 *
 * The Polymarket CLOB API may return secrets in base64url format,
 * but the HMAC signing function expects standard base64 format.
 *
 * This utility handles normalization between these formats.
 *
 * @see https://github.com/Polymarket/clob-client/blob/main/src/signing/hmac.ts
 */

/**
 * Normalize a secret to standard base64 format.
 *
 * This function converts base64url to base64:
 * - Replaces '-' with '+'
 * - Replaces '_' with '/'
 *
 * This matches the normalization done in the official clob-client hmac.ts.
 *
 * @param secret - The secret string (may be base64 or base64url)
 * @returns The secret in standard base64 format
 */
export function normalizeBase64Secret(secret: string): string {
  if (!secret) {
    return secret;
  }

  // Replace base64url characters with base64 equivalents
  // This matches the official clob-client implementation in hmac.ts
  return secret.replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Check if a secret appears to be in base64url format.
 *
 * @param secret - The secret string to check
 * @returns True if the secret contains base64url-specific characters
 */
export function isBase64UrlEncoded(secret: string): boolean {
  if (!secret) {
    return false;
  }
  return secret.includes("-") || secret.includes("_");
}

/**
 * Check if a secret appears to be in standard base64 format.
 *
 * @param secret - The secret string to check
 * @returns True if the secret contains base64-specific characters
 */
export function isBase64Encoded(secret: string): boolean {
  if (!secret) {
    return false;
  }
  return secret.includes("+") || secret.includes("/");
}

/**
 * Detect the encoding format of a secret.
 *
 * @param secret - The secret string to analyze
 * @returns The detected encoding format
 */
export function detectSecretEncoding(
  secret: string,
): "base64" | "base64url" | "unknown" {
  if (!secret) {
    return "unknown";
  }

  const hasBase64Chars = secret.includes("+") || secret.includes("/");
  const hasBase64UrlChars = secret.includes("-") || secret.includes("_");

  if (hasBase64Chars && !hasBase64UrlChars) {
    return "base64";
  }

  if (hasBase64UrlChars && !hasBase64Chars) {
    return "base64url";
  }

  // Mixed or no special characters - assume unknown
  return "unknown";
}

/**
 * Validate that a secret is properly formatted.
 *
 * @param secret - The secret string to validate
 * @returns Validation result with error message if invalid
 */
export function validateSecret(secret: string | undefined): {
  valid: boolean;
  error?: string;
} {
  if (!secret) {
    return { valid: false, error: "Secret is empty or undefined" };
  }

  if (secret.length < 8) {
    return { valid: false, error: "Secret is too short (min 8 characters)" };
  }

  // Check for invalid characters (not base64 or base64url)
  const validChars = /^[A-Za-z0-9+/=_-]+$/;
  if (!validChars.test(secret)) {
    return { valid: false, error: "Secret contains invalid characters" };
  }

  return { valid: true };
}
