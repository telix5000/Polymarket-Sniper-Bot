/**
 * Single-Flight Credential Derivation
 *
 * Ensures credential derivation is single-flight:
 * - If a derivation is already in progress, other callers await it
 * - If derivation failed recently, do not retry until backoff timer elapsed
 * - Implements exponential backoff for retry scheduling (30s, 60s, 2m, 5m, 10m max)
 */

import type { ApiKeyCreds } from "@polymarket/clob-client";
import type { Logger } from "./logger.util";
import type { StructuredLogger } from "./structured-logger";

export interface DerivationResult {
  success: boolean;
  creds?: ApiKeyCreds;
  signatureType?: number;
  usedEffectiveForL1?: boolean;
  error?: string;
}

export interface SingleFlightConfig {
  /** Initial backoff delay in milliseconds (default: 30 seconds) */
  initialBackoffMs?: number;
  /** Maximum backoff delay in milliseconds (default: 10 minutes) */
  maxBackoffMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
}

const DEFAULT_CONFIG: Required<SingleFlightConfig> = {
  initialBackoffMs: 30 * 1000, // 30 seconds
  maxBackoffMs: 10 * 60 * 1000, // 10 minutes
  backoffMultiplier: 2,
};

interface DerivationState {
  /** Currently in-flight promise (if any) */
  inFlight: Promise<DerivationResult> | null;
  /** Last failure timestamp */
  lastFailureAt: number | null;
  /** Current backoff delay */
  currentBackoffMs: number;
  /** Number of consecutive failures */
  failureCount: number;
  /** Last successful result (cached) */
  cachedResult: DerivationResult | null;
}

/**
 * Single-flight coordinator for credential derivation
 */
export class SingleFlightDerivation {
  private state: DerivationState;
  private config: Required<SingleFlightConfig>;
  private logger?: Logger;
  private structuredLogger?: StructuredLogger;

  constructor(
    config: SingleFlightConfig = {},
    logger?: Logger,
    structuredLogger?: StructuredLogger,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
    this.structuredLogger = structuredLogger;
    this.state = {
      inFlight: null,
      lastFailureAt: null,
      currentBackoffMs: this.config.initialBackoffMs,
      failureCount: 0,
      cachedResult: null,
    };
  }

  /**
   * Log a message using available logger
   */
  private log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (this.structuredLogger) {
      this.structuredLogger[level](message, {
        category: "CRED_DERIVE",
        ...context,
      });
    } else if (this.logger) {
      this.logger[level](`[SingleFlight] ${message}`);
    }
  }

  /**
   * Check if we should retry based on backoff
   */
  shouldRetry(): { canRetry: boolean; waitMs: number; reason?: string } {
    // If we have cached successful credentials, no need to retry
    if (this.state.cachedResult?.success) {
      return { canRetry: false, waitMs: 0, reason: "Cached credentials available" };
    }

    // If no previous failure, allow retry
    if (this.state.lastFailureAt === null) {
      return { canRetry: true, waitMs: 0 };
    }

    const now = Date.now();
    const elapsed = now - this.state.lastFailureAt;
    const remainingWait = this.state.currentBackoffMs - elapsed;

    if (remainingWait > 0) {
      const waitMinutes = Math.ceil(remainingWait / 60000);
      return {
        canRetry: false,
        waitMs: remainingWait,
        reason: `Backoff active: wait ${waitMinutes}m (${this.state.failureCount} consecutive failures)`,
      };
    }

    return { canRetry: true, waitMs: 0 };
  }

  /**
   * Execute credential derivation with single-flight protection
   *
   * @param deriveFn - The actual derivation function to call
   * @returns The derivation result
   */
  async derive(
    deriveFn: () => Promise<DerivationResult>,
  ): Promise<DerivationResult> {
    // Return cached successful result if available
    if (this.state.cachedResult?.success) {
      this.log("debug", "Returning cached successful credentials");
      return this.state.cachedResult;
    }

    // If a derivation is in flight, wait for it
    if (this.state.inFlight) {
      this.log("info", "Derivation already in progress, awaiting result...");
      return this.state.inFlight;
    }

    // Check backoff
    const { canRetry, waitMs, reason } = this.shouldRetry();
    if (!canRetry) {
      this.log("warn", `Derivation blocked by backoff: ${reason}`);
      return {
        success: false,
        error: `Derivation blocked: ${reason}. Retry after ${Math.ceil(waitMs / 60000)} minutes.`,
      };
    }

    // Start the derivation
    this.log("info", "Starting credential derivation...", {
      failureCount: this.state.failureCount,
      currentBackoffMs: this.state.currentBackoffMs,
    });

    this.state.inFlight = this.executeDerivation(deriveFn);

    try {
      const result = await this.state.inFlight;
      return result;
    } finally {
      this.state.inFlight = null;
    }
  }

  /**
   * Internal: Execute derivation with error handling
   */
  private async executeDerivation(
    deriveFn: () => Promise<DerivationResult>,
  ): Promise<DerivationResult> {
    try {
      const result = await deriveFn();

      if (result.success) {
        // Reset backoff on success
        this.state.lastFailureAt = null;
        this.state.currentBackoffMs = this.config.initialBackoffMs;
        this.state.failureCount = 0;
        this.state.cachedResult = result;
        this.log("info", "Credential derivation succeeded");
        return result;
      }

      // Handle failure
      this.recordFailure();
      return result;
    } catch (error) {
      this.recordFailure();
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Derivation exception: ${message}`,
      };
    }
  }

  /**
   * Record a failure and update backoff
   */
  private recordFailure(): void {
    this.state.lastFailureAt = Date.now();
    this.state.failureCount++;

    // Increase backoff (exponential)
    this.state.currentBackoffMs = Math.min(
      this.state.currentBackoffMs * this.config.backoffMultiplier,
      this.config.maxBackoffMs,
    );

    const backoffMinutes = Math.ceil(this.state.currentBackoffMs / 60000);
    this.log("warn", `Derivation failed, backoff increased`, {
      failureCount: this.state.failureCount,
      nextBackoffMinutes: backoffMinutes,
    });
  }

  /**
   * Force clear the cached result and backoff (for testing or manual reset)
   */
  reset(): void {
    this.state = {
      inFlight: null,
      lastFailureAt: null,
      currentBackoffMs: this.config.initialBackoffMs,
      failureCount: 0,
      cachedResult: null,
    };
    this.log("debug", "Single-flight state reset");
  }

  /**
   * Get current state for diagnostics
   */
  getState(): {
    isInFlight: boolean;
    failureCount: number;
    currentBackoffMs: number;
    hasCachedResult: boolean;
    canRetry: boolean;
  } {
    const { canRetry } = this.shouldRetry();
    return {
      isInFlight: this.state.inFlight !== null,
      failureCount: this.state.failureCount,
      currentBackoffMs: this.state.currentBackoffMs,
      hasCachedResult: this.state.cachedResult?.success ?? false,
      canRetry,
    };
  }
}

// Global singleton instance
let globalSingleFlight: SingleFlightDerivation | null = null;

/**
 * Get or create the global single-flight derivation coordinator
 */
export function getSingleFlightDerivation(
  logger?: Logger,
  structuredLogger?: StructuredLogger,
): SingleFlightDerivation {
  if (!globalSingleFlight) {
    globalSingleFlight = new SingleFlightDerivation({}, logger, structuredLogger);
  }
  return globalSingleFlight;
}

/**
 * Reset the global single-flight coordinator (for testing)
 */
export function resetSingleFlightDerivation(): void {
  if (globalSingleFlight) {
    globalSingleFlight.reset();
  }
  globalSingleFlight = null;
}
