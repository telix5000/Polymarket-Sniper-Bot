/**
 * Rate Limit and Retry Utilities
 *
 * Centralized rate limiting, retry logic, and error handling for Polymarket API calls.
 * This module provides reusable utilities that can be used by both REST and WebSocket clients.
 *
 * Features:
 * - Exponential backoff with jitter
 * - Rate limiting with configurable windows
 * - Retry logic with configurable attempts
 * - Error classification (retryable vs non-retryable)
 */

// ============================================================================
// Configuration
// ============================================================================

/** Default configuration for retry behavior */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in ms for exponential backoff */
  baseDelayMs: number;
  /** Maximum delay in ms */
  maxDelayMs: number;
  /** Jitter factor (0-1) for randomization */
  jitterFactor: number;
}

/** Default retry configuration */
export const DEFAULT_RETRY_CONFIG: Readonly<RetryConfig> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.3,
};

/** Rate limit configuration */
export interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in ms */
  windowMs: number;
}

/** Default rate limit configuration (conservative for Polymarket API) */
export const DEFAULT_RATE_LIMIT_CONFIG: Readonly<RateLimitConfig> = {
  maxRequests: 10,
  windowMs: 1000,
};

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Error codes that indicate a retryable error
 */
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ENETUNREACH",
  "EPIPE",
  "EAI_AGAIN",
]);

/**
 * HTTP status codes that indicate a retryable error
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  // Check for network error codes
  const errorCode = (error as NodeJS.ErrnoException)?.code;
  if (errorCode && RETRYABLE_ERROR_CODES.has(errorCode)) {
    return true;
  }

  // Check for HTTP status codes
  const statusCode =
    (error as { response?: { status?: number } })?.response?.status ||
    (error as { statusCode?: number })?.statusCode ||
    (error as { status?: number })?.status;

  if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true;
  }

  // Check for timeout messages
  const message =
    (error as Error)?.message?.toLowerCase() || String(error).toLowerCase();
  if (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("network")
  ) {
    return true;
  }

  return false;
}

/**
 * Check if error is a rate limit error (429)
 */
export function isRateLimitError(error: unknown): boolean {
  const statusCode =
    (error as { response?: { status?: number } })?.response?.status ||
    (error as { statusCode?: number })?.statusCode ||
    (error as { status?: number })?.status;

  return statusCode === 429;
}

/**
 * Check if error is a Cloudflare block
 */
export function isCloudflareBlockError(error: unknown): boolean {
  const message = (error as Error)?.message || String(error);
  const statusCode =
    (error as { response?: { status?: number } })?.response?.status ||
    (error as { statusCode?: number })?.statusCode;

  return (
    statusCode === 403 &&
    (message.toLowerCase().includes("cloudflare") ||
      message.includes("cf-ray") ||
      message.includes("<!DOCTYPE html>"))
  );
}

// ============================================================================
// Retry Utilities
// ============================================================================

/**
 * Calculate delay for exponential backoff with jitter
 */
export function calculateBackoff(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): number {
  const { baseDelayMs, maxDelayMs, jitterFactor } = config;

  // Exponential backoff: base * 2^attempt
  const exponentialDelay = Math.min(
    baseDelayMs * Math.pow(2, attempt),
    maxDelayMs,
  );

  // Add jitter (random factor)
  const jitter = exponentialDelay * jitterFactor * Math.random();

  return Math.round(exponentialDelay + jitter);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
}

/**
 * Execute a function with retry logic
 *
 * @param fn - The async function to execute
 * @param config - Retry configuration
 * @param onRetry - Optional callback on each retry
 * @returns The result of the operation
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<RetryResult<T>> {
  const fullConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  const { maxRetries } = fullConfig;

  let lastError: Error | undefined;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;

    try {
      const data = await fn();
      return { success: true, data, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry if it's not a retryable error
      if (!isRetryableError(err)) {
        return { success: false, error: lastError, attempts };
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) {
        break;
      }

      // Calculate delay and wait
      const delayMs = calculateBackoff(attempt, fullConfig);
      onRetry?.(attempt + 1, lastError, delayMs);
      await sleep(delayMs);
    }
  }

  return { success: false, error: lastError, attempts };
}

// ============================================================================
// Rate Limiter
// ============================================================================

/**
 * Simple sliding window rate limiter with concurrency-safe waitAndRecord
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];
  // Internal promise queue for serializing waitAndRecord calls
  private waitQueue: Promise<void> = Promise.resolve();

  constructor(config: Partial<RateLimitConfig> = {}) {
    const fullConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
    this.maxRequests = fullConfig.maxRequests;
    this.windowMs = fullConfig.windowMs;
  }

  /**
   * Check if a request can be made (without recording it)
   */
  canMakeRequest(): boolean {
    this.pruneOldTimestamps();
    return this.timestamps.length < this.maxRequests;
  }

  /**
   * Record a request (call this after making a successful request)
   */
  recordRequest(): void {
    this.pruneOldTimestamps();
    this.timestamps.push(Date.now());
  }

  /**
   * Wait until a request can be made, then record it.
   * Serialized to prevent concurrent callers from exceeding the limit.
   */
  async waitAndRecord(): Promise<void> {
    const run = async () => {
      this.pruneOldTimestamps();

      if (this.timestamps.length >= this.maxRequests) {
        // Calculate how long to wait
        const oldestTimestamp = this.timestamps[0];
        const waitTime = oldestTimestamp + this.windowMs - Date.now();

        if (waitTime > 0) {
          await sleep(waitTime);
          this.pruneOldTimestamps();
        }
      }

      this.recordRequest();
    };

    // Chain this invocation onto the existing queue so that only one
    // waiter runs the critical section at a time per RateLimiter instance.
    const previous = this.waitQueue;
    const next = previous.then(run, run);

    // Ensure the queue is not permanently rejected; future calls should proceed.
    this.waitQueue = next.catch(() => {});

    return next;
  }

  /**
   * Get current request count in window
   */
  getCurrentCount(): number {
    this.pruneOldTimestamps();
    return this.timestamps.length;
  }

  /**
   * Get time until next request can be made (0 if can make request now)
   */
  getWaitTime(): number {
    this.pruneOldTimestamps();

    if (this.timestamps.length < this.maxRequests) {
      return 0;
    }

    const oldestTimestamp = this.timestamps[0];
    return Math.max(0, oldestTimestamp + this.windowMs - Date.now());
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.timestamps = [];
  }

  private pruneOldTimestamps(): void {
    const cutoff = Date.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }
}

// ============================================================================
// Endpoint-specific Rate Limiters
// ============================================================================

/**
 * Pre-configured rate limiters for different Polymarket API endpoints
 */
export const rateLimiters = {
  /** CLOB API rate limiter (conservative: 10 req/s) */
  clob: new RateLimiter({ maxRequests: 10, windowMs: 1000 }),

  /** Data API rate limiter (more lenient: 20 req/s) */
  data: new RateLimiter({ maxRequests: 20, windowMs: 1000 }),

  /** Gamma API rate limiter (conservative: 5 req/s) */
  gamma: new RateLimiter({ maxRequests: 5, windowMs: 1000 }),

  /** Order posting rate limiter (very conservative: 2 req/s per token) */
  orders: new RateLimiter({ maxRequests: 2, windowMs: 1000 }),
};

/**
 * Get rate limiter for a specific endpoint
 */
export function getRateLimiter(
  endpoint: keyof typeof rateLimiters,
): RateLimiter {
  return rateLimiters[endpoint];
}

// ============================================================================
// Combined Retry + Rate Limit Helper
// ============================================================================

/**
 * Execute a function with both rate limiting and retry logic.
 * Rate limiting is applied per-attempt (including retries) to prevent burst
 * of rapid failures from exceeding the intended request rate.
 *
 * @param fn - The async function to execute
 * @param rateLimiter - Rate limiter to use (or key for pre-configured limiter)
 * @param retryConfig - Retry configuration
 * @param onRetry - Optional callback on each retry
 */
export async function withRateLimitAndRetry<T>(
  fn: () => Promise<T>,
  rateLimiter: RateLimiter | keyof typeof rateLimiters,
  retryConfig: Partial<RetryConfig> = {},
  onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<RetryResult<T>> {
  const limiter =
    typeof rateLimiter === "string" ? getRateLimiter(rateLimiter) : rateLimiter;

  // Wrap the function so every attempt (including retries) is rate-limited
  const wrappedFn = async (): Promise<T> => {
    await limiter.waitAndRecord();
    return fn();
  };

  // Execute with retry logic, applying rate limiting per attempt
  return withRetry(wrappedFn, retryConfig, onRetry);
}
