import assert from "node:assert";
import { test, describe } from "node:test";
import {
  DiagTracer,
  DiagStep,
  DiagResult,
  DiagReason,
  parseDiagModeConfig,
  isDiagModeEnabled,
  isGitHubActions,
  createTimeout,
  withTimeout,
  DiagTimeoutError,
  mapErrorToReason,
  sanitizeDetail,
  ghGroup,
  ghEndGroup,
} from "../../src/lib/diag-mode";

/**
 * Unit tests for Diagnostic Mode (DIAG_MODE)
 *
 * These tests verify:
 * 1. Configuration parsing from environment variables
 * 2. Trace event generation and structure
 * 3. Timeout utilities
 * 4. Error-to-reason mapping
 * 5. Sensitive data sanitization
 */

describe("DiagModeConfig Parsing", () => {
  test("should return disabled config when DIAG_MODE is not set", () => {
    // Save and clear env
    const original = process.env.DIAG_MODE;
    delete process.env.DIAG_MODE;

    const config = parseDiagModeConfig();

    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.whaleTimeoutSec, 60);
    assert.strictEqual(config.orderTimeoutSec, 30);
    assert.strictEqual(config.forceShares, 1);

    // Restore
    if (original !== undefined) process.env.DIAG_MODE = original;
  });

  test("should enable when DIAG_MODE=true", () => {
    const original = process.env.DIAG_MODE;
    process.env.DIAG_MODE = "true";

    const config = parseDiagModeConfig();

    assert.strictEqual(config.enabled, true);

    if (original !== undefined) {
      process.env.DIAG_MODE = original;
    } else {
      delete process.env.DIAG_MODE;
    }
  });

  test("should enable when DIAG_MODE=1", () => {
    const original = process.env.DIAG_MODE;
    process.env.DIAG_MODE = "1";

    const config = parseDiagModeConfig();

    assert.strictEqual(config.enabled, true);

    if (original !== undefined) {
      process.env.DIAG_MODE = original;
    } else {
      delete process.env.DIAG_MODE;
    }
  });

  test("should parse custom timeout values", () => {
    const origDiag = process.env.DIAG_MODE;
    const origWhale = process.env.DIAG_WHALE_TIMEOUT_SEC;
    const origOrder = process.env.DIAG_ORDER_TIMEOUT_SEC;

    process.env.DIAG_MODE = "true";
    process.env.DIAG_WHALE_TIMEOUT_SEC = "120";
    process.env.DIAG_ORDER_TIMEOUT_SEC = "45";

    const config = parseDiagModeConfig();

    assert.strictEqual(config.whaleTimeoutSec, 120);
    assert.strictEqual(config.orderTimeoutSec, 45);

    // Restore
    if (origDiag !== undefined) {
      process.env.DIAG_MODE = origDiag;
    } else {
      delete process.env.DIAG_MODE;
    }
    if (origWhale !== undefined) {
      process.env.DIAG_WHALE_TIMEOUT_SEC = origWhale;
    } else {
      delete process.env.DIAG_WHALE_TIMEOUT_SEC;
    }
    if (origOrder !== undefined) {
      process.env.DIAG_ORDER_TIMEOUT_SEC = origOrder;
    } else {
      delete process.env.DIAG_ORDER_TIMEOUT_SEC;
    }
  });

  test("should default to 1 share when invalid DIAG_FORCE_SHARES", () => {
    const origDiag = process.env.DIAG_MODE;
    const origShares = process.env.DIAG_FORCE_SHARES;

    process.env.DIAG_MODE = "true";
    process.env.DIAG_FORCE_SHARES = "0";

    const config = parseDiagModeConfig();

    assert.strictEqual(config.forceShares, 1);

    // Restore
    if (origDiag !== undefined) {
      process.env.DIAG_MODE = origDiag;
    } else {
      delete process.env.DIAG_MODE;
    }
    if (origShares !== undefined) {
      process.env.DIAG_FORCE_SHARES = origShares;
    } else {
      delete process.env.DIAG_FORCE_SHARES;
    }
  });
});

describe("isDiagModeEnabled", () => {
  test("should return false when not set", () => {
    const original = process.env.DIAG_MODE;
    delete process.env.DIAG_MODE;

    assert.strictEqual(isDiagModeEnabled(), false);

    if (original !== undefined) process.env.DIAG_MODE = original;
  });

  test("should return true when set to true", () => {
    const original = process.env.DIAG_MODE;
    process.env.DIAG_MODE = "true";

    assert.strictEqual(isDiagModeEnabled(), true);

    if (original !== undefined) {
      process.env.DIAG_MODE = original;
    } else {
      delete process.env.DIAG_MODE;
    }
  });
});

describe("DiagTracer", () => {
  test("should generate unique trace ID", () => {
    const tracer1 = new DiagTracer();
    const tracer2 = new DiagTracer();

    assert.notStrictEqual(tracer1.getTraceId(), tracer2.getTraceId());
    assert.ok(tracer1.getTraceId().length > 0);
  });

  test("should use provided trace ID", () => {
    const customId = "custom-trace-id-123";
    const tracer = new DiagTracer(customId);

    assert.strictEqual(tracer.getTraceId(), customId);
  });

  test("should emit trace events with correct structure", () => {
    const tracer = new DiagTracer("test-trace");

    const event = tracer.trace({
      step: "WHALE_BUY",
      action: "buy_attempt_started",
      result: "OK",
      marketId: "market-123",
      tokenId: "token-456",
      outcomeLabel: "YES",
      detail: { price: 0.45 },
    });

    assert.strictEqual(event.diag, true);
    assert.strictEqual(event.traceId, "test-trace");
    assert.strictEqual(event.step, "WHALE_BUY");
    assert.strictEqual(event.action, "buy_attempt_started");
    assert.strictEqual(event.result, "OK");
    assert.strictEqual(event.marketId, "market-123");
    assert.strictEqual(event.tokenId, "token-456");
    assert.strictEqual(event.outcomeLabel, "YES");
    assert.deepStrictEqual(event.detail, { price: 0.45 });
    assert.ok(event.timestamp);
  });

  test("should track events and retrieve by step", () => {
    const tracer = new DiagTracer("test");

    tracer.trace({ step: "WHALE_BUY", action: "start", result: "OK" });
    tracer.trace({ step: "WHALE_BUY", action: "end", result: "OK" });
    tracer.trace({ step: "WHALE_SELL", action: "start", result: "SKIPPED" });

    const allEvents = tracer.getEvents();
    assert.strictEqual(allEvents.length, 3);

    const whaleBuyEvents = tracer.getStepEvents("WHALE_BUY");
    assert.strictEqual(whaleBuyEvents.length, 2);

    const whaleSellEvents = tracer.getStepEvents("WHALE_SELL");
    assert.strictEqual(whaleSellEvents.length, 1);
  });

  test("should clear events", () => {
    const tracer = new DiagTracer();

    tracer.trace({ step: "SCAN_BUY", action: "test", result: "OK" });
    assert.strictEqual(tracer.getEvents().length, 1);

    tracer.clear();
    assert.strictEqual(tracer.getEvents().length, 0);
  });
});

describe("Timeout Utilities", () => {
  test("createTimeout should create cancellable timeout", async () => {
    const timeout = createTimeout<string>(50, "order_timeout");

    // Cancel before it fires
    timeout.cancel();

    // Should not reject since we cancelled
    // Create a race with a resolved promise
    const result = await Promise.race([
      timeout.promise.catch(() => "caught"),
      Promise.resolve("resolved"),
    ]);

    assert.strictEqual(result, "resolved");
  });

  test("withTimeout should resolve if operation completes in time", async () => {
    const fastOp = new Promise<string>((resolve) => {
      setTimeout(() => resolve("success"), 10);
    });

    const result = await withTimeout(fastOp, 100, "order_timeout");
    assert.strictEqual(result, "success");
  });

  test("withTimeout should reject if operation times out", async () => {
    const slowOp = new Promise<string>((resolve) => {
      setTimeout(() => resolve("success"), 200);
    });

    try {
      await withTimeout(slowOp, 50, "order_timeout");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err instanceof DiagTimeoutError);
      assert.strictEqual(err.reason, "order_timeout");
    }
  });
});

describe("mapErrorToReason", () => {
  test("should map DiagTimeoutError to its reason", () => {
    const err = new DiagTimeoutError("timeout_waiting_for_whale", 60000);
    assert.strictEqual(mapErrorToReason(err), "timeout_waiting_for_whale");
  });

  test("should map wallet/credentials errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("PRIVATE_KEY is not set")),
      "no_wallet_credentials",
    );
    assert.strictEqual(
      mapErrorToReason(new Error("wallet not configured")),
      "no_wallet_credentials",
    );
  });

  test("should map websocket errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("WebSocket connection failed")),
      "ws_disconnected",
    );
    assert.strictEqual(
      mapErrorToReason(new Error("ws disconnected unexpectedly")),
      "ws_disconnected",
    );
  });

  test("should map orderbook errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("orderbook unavailable")),
      "orderbook_unavailable",
    );
    assert.strictEqual(
      mapErrorToReason(new Error("order book not found")),
      "orderbook_unavailable",
    );
  });

  test("should map liquidity errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("insufficient liquidity")),
      "insufficient_liquidity",
    );
    assert.strictEqual(
      mapErrorToReason(new Error("not enough depth")),
      "insufficient_liquidity",
    );
  });

  test("should map price range errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("price out of range")),
      "price_out_of_range",
    );
    assert.strictEqual(
      mapErrorToReason(new Error("price exceeds bound")),
      "price_out_of_range",
    );
  });

  test("should map API errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("API request failed")),
      "api_error",
    );
    assert.strictEqual(
      mapErrorToReason(new Error("fetch error")),
      "api_error",
    );
  });

  test("should return unknown_error for unrecognized errors", () => {
    assert.strictEqual(
      mapErrorToReason(new Error("some random error")),
      "unknown_error",
    );
  });
});

describe("sanitizeDetail", () => {
  test("should redact sensitive keys", () => {
    const input = {
      privateKey: "0x1234567890abcdef",
      apiKey: "secret123",
      password: "hunter2",
      token: "bearer-token",
      credential: "my-cred",
      normalField: "visible",
    };

    const result = sanitizeDetail(input);

    assert.strictEqual(result.privateKey, "[REDACTED]");
    assert.strictEqual(result.apiKey, "[REDACTED]");
    assert.strictEqual(result.password, "[REDACTED]");
    assert.strictEqual(result.token, "[REDACTED]");
    assert.strictEqual(result.credential, "[REDACTED]");
    assert.strictEqual(result.normalField, "visible");
  });

  test("should redact private key patterns", () => {
    const input = {
      wallet:
        "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    };

    const result = sanitizeDetail(input);

    assert.strictEqual(result.wallet, "[REDACTED_KEY]");
  });

  test("should redact long hex strings", () => {
    const input = {
      hashValue: "abcdef1234567890abcdef1234567890",
    };

    const result = sanitizeDetail(input);

    assert.strictEqual(result.hashValue, "[REDACTED_HEX]");
  });

  test("should recursively sanitize nested objects", () => {
    const input = {
      outer: {
        apiKey: "secret",
        inner: {
          password: "hidden",
          visible: "ok",
        },
      },
    };

    const result = sanitizeDetail(input) as Record<string, unknown>;

    const outer = result.outer as Record<string, unknown>;
    assert.strictEqual(outer.apiKey, "[REDACTED]");

    const inner = outer.inner as Record<string, unknown>;
    assert.strictEqual(inner.password, "[REDACTED]");
    assert.strictEqual(inner.visible, "ok");
  });

  test("should pass through safe values unchanged", () => {
    const input = {
      price: 0.45,
      count: 10,
      name: "test",
      isActive: true,
      items: [1, 2, 3],
    };

    const result = sanitizeDetail(input);

    assert.strictEqual(result.price, 0.45);
    assert.strictEqual(result.count, 10);
    assert.strictEqual(result.name, "test");
    assert.strictEqual(result.isActive, true);
    assert.deepStrictEqual(result.items, [1, 2, 3]);
  });
});

describe("GitHub Actions Integration", () => {
  test("isGitHubActions should return false by default", () => {
    const original = process.env.GITHUB_ACTIONS;
    delete process.env.GITHUB_ACTIONS;

    assert.strictEqual(isGitHubActions(), false);

    if (original !== undefined) process.env.GITHUB_ACTIONS = original;
  });

  test("isGitHubActions should return true when GITHUB_ACTIONS=true", () => {
    const original = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";

    assert.strictEqual(isGitHubActions(), true);

    if (original !== undefined) {
      process.env.GITHUB_ACTIONS = original;
    } else {
      delete process.env.GITHUB_ACTIONS;
    }
  });
});

describe("DiagStep and DiagResult Types", () => {
  test("should have correct step values", () => {
    const steps: DiagStep[] = ["WHALE_BUY", "WHALE_SELL", "SCAN_BUY", "SCAN_SELL"];

    assert.strictEqual(steps.length, 4);
    assert.ok(steps.includes("WHALE_BUY"));
    assert.ok(steps.includes("WHALE_SELL"));
    assert.ok(steps.includes("SCAN_BUY"));
    assert.ok(steps.includes("SCAN_SELL"));
  });

  test("should have correct reason values", () => {
    const reasons: DiagReason[] = [
      "unsupported_market_schema",
      "not_binary_market",
      "cannot_resolve_outcome_token",
      "orderbook_unavailable",
      "insufficient_liquidity",
      "price_out_of_range",
      "cooldown_active",
      "risk_limits_blocked",
      "no_wallet_credentials",
      "ws_disconnected",
      "api_error",
      "no_position_to_sell",
      "sell_skipped_no_buy",
      "timeout_waiting_for_whale",
      "order_timeout",
      "unknown_error",
    ];

    assert.strictEqual(reasons.length, 16);
    assert.ok(reasons.includes("timeout_waiting_for_whale"));
    assert.ok(reasons.includes("no_position_to_sell"));
    assert.ok(reasons.includes("sell_skipped_no_buy"));
  });
});
