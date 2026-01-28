/**
 * Tests for rate limit and retry utilities
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  RateLimiter,
  calculateBackoff,
  isRetryableError,
  isRateLimitError,
  isCloudflareBlockError,
  withRetry,
  sleep,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
  rateLimiters,
} from "../../src/services/polymarket/rate-limit";

describe("Rate Limit Utilities", async () => {
  describe("RateLimiter", async () => {
    it("should allow requests within limit", () => {
      const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000 });

      assert.strictEqual(limiter.canMakeRequest(), true);
      limiter.recordRequest();
      assert.strictEqual(limiter.canMakeRequest(), true);
      limiter.recordRequest();
      assert.strictEqual(limiter.canMakeRequest(), true);
      limiter.recordRequest();
      // After 3 requests, should be at limit
      assert.strictEqual(limiter.canMakeRequest(), false);
    });

    it("should track current request count", () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });

      assert.strictEqual(limiter.getCurrentCount(), 0);
      limiter.recordRequest();
      assert.strictEqual(limiter.getCurrentCount(), 1);
      limiter.recordRequest();
      assert.strictEqual(limiter.getCurrentCount(), 2);
    });

    it("should reset when reset() is called", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });

      limiter.recordRequest();
      limiter.recordRequest();
      assert.strictEqual(limiter.canMakeRequest(), false);

      limiter.reset();
      assert.strictEqual(limiter.canMakeRequest(), true);
      assert.strictEqual(limiter.getCurrentCount(), 0);
    });

    it("should calculate wait time correctly", () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });

      // Before any requests
      assert.strictEqual(limiter.getWaitTime(), 0);

      limiter.recordRequest();
      // Now at limit, should have wait time
      const waitTime = limiter.getWaitTime();
      assert.ok(waitTime > 0);
      assert.ok(waitTime <= 1000);
    });
  });

  describe("calculateBackoff", async () => {
    it("should calculate exponential backoff", () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        jitterFactor: 0, // No jitter for predictable testing
      };

      // First attempt: base delay
      assert.strictEqual(calculateBackoff(0, config), config.baseDelayMs);

      // Second attempt: base * 2
      assert.strictEqual(calculateBackoff(1, config), config.baseDelayMs * 2);

      // Third attempt: base * 4
      assert.strictEqual(calculateBackoff(2, config), config.baseDelayMs * 4);
    });

    it("should respect maximum delay", () => {
      const config = {
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        jitterFactor: 0,
        maxRetries: 10,
      };

      // With high attempt, should cap at maxDelayMs
      assert.strictEqual(calculateBackoff(10, config), config.maxDelayMs);
    });

    it("should add jitter when configured", () => {
      const config = {
        ...DEFAULT_RETRY_CONFIG,
        jitterFactor: 0.5,
      };

      // Run multiple times to verify jitter variance
      const results = new Set<number>();
      for (let i = 0; i < 10; i++) {
        results.add(calculateBackoff(0, config));
      }

      // With jitter, we should see variance in results
      // This is probabilistic but should almost always pass
      assert.ok(results.size > 1, "Jitter should produce varying results");
    });
  });

  describe("Error Classification", async () => {
    describe("isRetryableError", async () => {
      it("should identify network error codes as retryable", () => {
        assert.strictEqual(isRetryableError({ code: "ECONNRESET" }), true);
        assert.strictEqual(isRetryableError({ code: "ETIMEDOUT" }), true);
        assert.strictEqual(isRetryableError({ code: "ECONNREFUSED" }), true);
      });

      it("should identify HTTP 5xx errors as retryable", () => {
        assert.strictEqual(
          isRetryableError({ response: { status: 500 } }),
          true,
        );
        assert.strictEqual(
          isRetryableError({ response: { status: 502 } }),
          true,
        );
        assert.strictEqual(
          isRetryableError({ response: { status: 503 } }),
          true,
        );
      });

      it("should identify 429 as retryable", () => {
        assert.strictEqual(
          isRetryableError({ response: { status: 429 } }),
          true,
        );
      });

      it("should not identify client errors as retryable", () => {
        assert.strictEqual(
          isRetryableError({ response: { status: 400 } }),
          false,
        );
        assert.strictEqual(
          isRetryableError({ response: { status: 401 } }),
          false,
        );
        assert.strictEqual(
          isRetryableError({ response: { status: 404 } }),
          false,
        );
      });

      it("should identify timeout messages as retryable", () => {
        assert.strictEqual(
          isRetryableError({ message: "Connection timeout" }),
          true,
        );
        assert.strictEqual(
          isRetryableError({ message: "Request timeout exceeded" }),
          true,
        );
      });
    });

    describe("isRateLimitError", async () => {
      it("should identify 429 status as rate limit error", () => {
        assert.strictEqual(
          isRateLimitError({ response: { status: 429 } }),
          true,
        );
        assert.strictEqual(isRateLimitError({ statusCode: 429 }), true);
      });

      it("should not identify other errors as rate limit", () => {
        assert.strictEqual(
          isRateLimitError({ response: { status: 500 } }),
          false,
        );
        assert.strictEqual(
          isRateLimitError({ response: { status: 400 } }),
          false,
        );
      });
    });

    describe("isCloudflareBlockError", async () => {
      it("should identify Cloudflare 403 errors", () => {
        assert.strictEqual(
          isCloudflareBlockError({
            statusCode: 403,
            message: "Blocked by Cloudflare",
          }),
          true,
        );
        assert.strictEqual(
          isCloudflareBlockError({
            response: { status: 403 },
            message: "cf-ray header found",
          }),
          true,
        );
      });

      it("should not identify regular 403 as Cloudflare block", () => {
        assert.strictEqual(
          isCloudflareBlockError({
            statusCode: 403,
            message: "Forbidden",
          }),
          false,
        );
      });
    });
  });

  describe("withRetry", async () => {
    it("should return success on first try if no error", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return "success";
      };

      const result = await withRetry(fn);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, "success");
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(callCount, 1);
    });

    it("should retry on retryable errors", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        if (callCount < 3) {
          const err: NodeJS.ErrnoException = new Error("Network error");
          err.code = "ECONNRESET";
          throw err;
        }
        return "success";
      };

      const result = await withRetry(fn, {
        baseDelayMs: 10, // Fast retries for test
        maxRetries: 3,
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.data, "success");
      assert.strictEqual(result.attempts, 3);
    });

    it("should not retry on non-retryable errors", async () => {
      let callCount = 0;
      const fn = async () => {
        callCount++;
        throw { response: { status: 400 }, message: "Bad request" };
      };

      const result = await withRetry(fn, { maxRetries: 3 });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, 1);
      assert.strictEqual(callCount, 1);
    });

    it("should call onRetry callback", async () => {
      let retryCount = 0;
      const fn = async () => {
        if (retryCount < 2) {
          const err: NodeJS.ErrnoException = new Error("Network error");
          err.code = "ETIMEDOUT";
          throw err;
        }
        return "success";
      };

      const result = await withRetry(
        fn,
        { baseDelayMs: 10, maxRetries: 3 },
        (attempt, _error, _delay) => {
          retryCount = attempt;
        },
      );

      assert.strictEqual(result.success, true);
      assert.strictEqual(retryCount, 2);
    });

    it("should fail after max retries", async () => {
      const fn = async () => {
        const err: NodeJS.ErrnoException = new Error("Network error");
        err.code = "ECONNRESET";
        throw err;
      };

      const result = await withRetry(fn, { baseDelayMs: 10, maxRetries: 2 });

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.attempts, 3); // Initial + 2 retries
      assert.ok(result.error);
    });
  });

  describe("sleep", async () => {
    it("should sleep for approximately the specified time", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      // Allow some tolerance for timing; only assert a lower bound to avoid flakiness on slow CI
      assert.ok(elapsed >= 45, `Expected >= 45ms, got ${elapsed}ms`);
    });
  });

  describe("Default Configurations", async () => {
    it("should have sensible default retry config", () => {
      assert.ok(DEFAULT_RETRY_CONFIG.maxRetries >= 1);
      assert.ok(DEFAULT_RETRY_CONFIG.baseDelayMs > 0);
      assert.ok(
        DEFAULT_RETRY_CONFIG.maxDelayMs > DEFAULT_RETRY_CONFIG.baseDelayMs,
      );
      assert.ok(DEFAULT_RETRY_CONFIG.jitterFactor >= 0);
      assert.ok(DEFAULT_RETRY_CONFIG.jitterFactor <= 1);
    });

    it("should have sensible default rate limit config", () => {
      assert.ok(DEFAULT_RATE_LIMIT_CONFIG.maxRequests > 0);
      assert.ok(DEFAULT_RATE_LIMIT_CONFIG.windowMs > 0);
    });
  });

  describe("Pre-configured Rate Limiters", async () => {
    beforeEach(() => {
      // Reset all rate limiters before each test
      rateLimiters.clob.reset();
      rateLimiters.data.reset();
      rateLimiters.gamma.reset();
      rateLimiters.orders.reset();
    });

    it("should have rate limiters for different endpoints", () => {
      assert.ok(rateLimiters.clob instanceof RateLimiter);
      assert.ok(rateLimiters.data instanceof RateLimiter);
      assert.ok(rateLimiters.gamma instanceof RateLimiter);
      assert.ok(rateLimiters.orders instanceof RateLimiter);
    });

    it("should allow requests through rate limiters", () => {
      assert.strictEqual(rateLimiters.clob.canMakeRequest(), true);
      assert.strictEqual(rateLimiters.data.canMakeRequest(), true);
      assert.strictEqual(rateLimiters.gamma.canMakeRequest(), true);
      assert.strictEqual(rateLimiters.orders.canMakeRequest(), true);
    });
  });
});
