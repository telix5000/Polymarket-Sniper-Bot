import assert from "node:assert";
import { test, describe } from "node:test";
import { mapOrderFailureReason } from "../../../src/lib/diag-workflow";

/**
 * Unit tests for diag-workflow.ts functions
 *
 * These tests verify:
 * 1. Order failure reason mapping
 * 2. Diagnostic workflow step handling
 */

describe("mapOrderFailureReason", () => {
  test("should return unknown_error for undefined reason", () => {
    assert.strictEqual(mapOrderFailureReason(undefined), "unknown_error");
  });

  test("should return unknown_error for empty string", () => {
    assert.strictEqual(mapOrderFailureReason(""), "unknown_error");
  });

  test("should map live trading disabled to no_wallet_credentials", () => {
    assert.strictEqual(
      mapOrderFailureReason("live trading disabled"),
      "no_wallet_credentials",
    );
  });

  test("should map LIVE TRADING to no_wallet_credentials (case insensitive)", () => {
    assert.strictEqual(
      mapOrderFailureReason("LIVE TRADING disabled"),
      "no_wallet_credentials",
    );
  });

  test("should map simulation to no_wallet_credentials", () => {
    assert.strictEqual(
      mapOrderFailureReason("simulation mode"),
      "no_wallet_credentials",
    );
  });

  test("should map simulated to no_wallet_credentials", () => {
    assert.strictEqual(
      mapOrderFailureReason("simulated order"),
      "no_wallet_credentials",
    );
  });

  test("should map SIMULATED to no_wallet_credentials", () => {
    assert.strictEqual(
      mapOrderFailureReason("SIMULATED"),
      "no_wallet_credentials",
    );
  });

  test("should map liquidity errors to insufficient_liquidity", () => {
    assert.strictEqual(
      mapOrderFailureReason("insufficient liquidity"),
      "insufficient_liquidity",
    );
  });

  test("should map depth errors to insufficient_liquidity", () => {
    assert.strictEqual(
      mapOrderFailureReason("not enough depth"),
      "insufficient_liquidity",
    );
  });

  test("should map price range errors to price_out_of_range", () => {
    assert.strictEqual(
      mapOrderFailureReason("price out of range"),
      "price_out_of_range",
    );
  });

  test("should map price protection errors to price_out_of_range", () => {
    assert.strictEqual(
      mapOrderFailureReason("price protection triggered"),
      "price_out_of_range",
    );
  });

  test("should map PRICE_TOO_HIGH to price_out_of_range", () => {
    assert.strictEqual(
      mapOrderFailureReason("PRICE_TOO_HIGH"),
      "price_out_of_range",
    );
  });

  test("should map PRICE_TOO_LOW to price_out_of_range", () => {
    assert.strictEqual(
      mapOrderFailureReason("PRICE_TOO_LOW"),
      "price_out_of_range",
    );
  });

  test("should map orderbook errors to orderbook_unavailable", () => {
    assert.strictEqual(
      mapOrderFailureReason("orderbook unavailable"),
      "orderbook_unavailable",
    );
  });

  test("should map NO_ASKS to orderbook_unavailable", () => {
    assert.strictEqual(
      mapOrderFailureReason("NO_ASKS"),
      "orderbook_unavailable",
    );
  });

  test("should map NO_BIDS to orderbook_unavailable", () => {
    assert.strictEqual(
      mapOrderFailureReason("NO_BIDS"),
      "orderbook_unavailable",
    );
  });

  test("should map cooldown errors to cooldown_active", () => {
    assert.strictEqual(
      mapOrderFailureReason("cooldown period active"),
      "cooldown_active",
    );
  });

  test("should map risk errors to risk_limits_blocked", () => {
    assert.strictEqual(
      mapOrderFailureReason("risk limits exceeded"),
      "risk_limits_blocked",
    );
  });

  test("should map timeout errors to order_timeout", () => {
    assert.strictEqual(mapOrderFailureReason("order timeout"), "order_timeout");
  });

  test("should map API errors to api_error", () => {
    assert.strictEqual(
      mapOrderFailureReason("API request failed"),
      "api_error",
    );
  });

  test("should map network errors to api_error", () => {
    assert.strictEqual(mapOrderFailureReason("network error"), "api_error");
  });

  test("should return unknown_error for unrecognized reasons", () => {
    assert.strictEqual(
      mapOrderFailureReason("some random error"),
      "unknown_error",
    );
  });
});

describe("DiagStep types", () => {
  test("should include WHALE_HEDGE and SCAN_HEDGE steps", async () => {
    // Import the type and verify the new step values are valid
    const { DiagTracer } = await import("../../../src/lib/diag-mode");

    // Create a tracer and trace hedge-related events
    const tracer = new DiagTracer();

    // These should compile without errors (type-level test)
    tracer.trace({
      step: "WHALE_HEDGE",
      action: "hedge_trigger_evaluated",
      result: "OK",
      detail: {
        entryPriceCents: 50,
        currentPriceCents: 34,
        adverseMoveCents: 16,
        triggerThresholdCents: 16,
        shouldTrigger: true,
        side: "LONG",
      },
    });

    tracer.trace({
      step: "SCAN_HEDGE",
      action: "hard_stop_evaluated",
      result: "OK",
      detail: {
        entryPriceCents: 50,
        currentPriceCents: 20,
        adverseMoveCents: 30,
        hardStopThresholdCents: 30,
        shouldTrigger: true,
        side: "LONG",
      },
    });

    // Verify trace events are recorded
    const whaleHedgeEvents = tracer.getStepEvents("WHALE_HEDGE");
    assert.ok(whaleHedgeEvents.length > 0, "Should have WHALE_HEDGE events");
    assert.strictEqual(
      whaleHedgeEvents[0].action,
      "hedge_trigger_evaluated",
      "Should have hedge_trigger_evaluated action",
    );

    const scanHedgeEvents = tracer.getStepEvents("SCAN_HEDGE");
    assert.ok(scanHedgeEvents.length > 0, "Should have SCAN_HEDGE events");
    assert.strictEqual(
      scanHedgeEvents[0].action,
      "hard_stop_evaluated",
      "Should have hard_stop_evaluated action",
    );
  });

  test("DiagReason should include hedge-specific reasons", async () => {
    // Import and verify the new DiagReason values are valid
    const { DiagTracer } = await import("../../../src/lib/diag-mode");

    const tracer = new DiagTracer();

    // These should compile without errors (type-level test)
    tracer.trace({
      step: "WHALE_HEDGE",
      action: "hedge_skipped",
      result: "SKIPPED",
      reason: "hedge_not_triggered",
    });

    tracer.trace({
      step: "SCAN_HEDGE",
      action: "hedge_order_failed",
      result: "REJECTED",
      reason: "hedge_order_rejected",
    });

    tracer.trace({
      step: "WHALE_HEDGE",
      action: "hard_stop_triggered",
      result: "OK",
      reason: "hard_stop_triggered",
    });

    // Verify events are recorded with correct reasons
    const events = tracer.getEvents();
    const reasons = events.map((e) => e.reason).filter(Boolean);
    assert.ok(reasons.includes("hedge_not_triggered"));
    assert.ok(reasons.includes("hedge_order_rejected"));
    assert.ok(reasons.includes("hard_stop_triggered"));
  });
});
