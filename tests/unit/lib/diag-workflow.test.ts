import assert from "node:assert";
import { test, describe, beforeEach } from "node:test";
import {
  mapOrderFailureReason,
  classifyMarketState,
  classifyGuardrailDecision,
  createSpreadGuardrailDiagnostic,
  formatSpreadGuardrailDiagnostic,
  checkBookTradeable,
  DIAG_MAX_BEST_ASK,
  DIAG_MAX_SPREAD,
  // Book sanity pre-filter
  performBookSanityCheck,
  isInCooldown,
  addToCooldown,
  clearBadBookCooldowns,
  createEmptyRejectionStats,
  formatRejectionStatsSummary,
} from "../../../src/lib/diag-workflow";

/**
 * Unit tests for diag-workflow.ts functions
 *
 * These tests verify:
 * 1. Order failure reason mapping
 * 2. Diagnostic workflow step handling
 * 3. Spread guardrail diagnostics (Part B & G)
 * 4. Book sanity pre-filter and cooldown
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

// ═══════════════════════════════════════════════════════════════════════════
// Spread Guardrail Diagnostics Tests (Parts B & G)
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyMarketState", () => {
  test("should classify as EMPTY_OR_FAKE_BOOK when bestBid <= 0.01 and bestAsk >= 0.99", () => {
    assert.strictEqual(classifyMarketState(0.01, 0.99), "EMPTY_OR_FAKE_BOOK");
    assert.strictEqual(classifyMarketState(0.005, 1.0), "EMPTY_OR_FAKE_BOOK");
  });

  test("should classify as NEARLY_RESOLVED when bestAsk >= 0.95", () => {
    // classifyMarketState uses >= for classification (not trading decision)
    assert.strictEqual(classifyMarketState(0.9, 0.95), "NEARLY_RESOLVED");
    assert.strictEqual(classifyMarketState(0.8, 0.96), "NEARLY_RESOLVED");
  });

  test("should classify as NORMAL_BUT_WIDE when spread > threshold", () => {
    // Spread = 0.40 which is > DIAG_MAX_SPREAD (0.30)
    assert.strictEqual(classifyMarketState(0.3, 0.7), "NORMAL_BUT_WIDE");
  });

  test("should classify as TRADEABLE when book is acceptable", () => {
    // Spread = 0.20 which is < DIAG_MAX_SPREAD (0.30), bestAsk < 0.95
    assert.strictEqual(classifyMarketState(0.3, 0.5), "TRADEABLE");
    assert.strictEqual(classifyMarketState(0.4, 0.6), "TRADEABLE");
  });

  test("should classify as TRADEABLE when only bestAsk is provided", () => {
    // No bid, bestAsk < 0.95
    assert.strictEqual(classifyMarketState(null, 0.5), "TRADEABLE");
  });

  test("should classify as LOW_LIQUIDITY when depth is insufficient", () => {
    // With depth parameters
    assert.strictEqual(classifyMarketState(0.3, 0.5, 5, 10), "LOW_LIQUIDITY");
  });
});

describe("classifyGuardrailDecision", () => {
  test("should return CORRECT for NEARLY_RESOLVED markets", () => {
    assert.strictEqual(classifyGuardrailDecision("NEARLY_RESOLVED"), "CORRECT");
  });

  test("should return CORRECT for EMPTY_OR_FAKE_BOOK markets", () => {
    assert.strictEqual(
      classifyGuardrailDecision("EMPTY_OR_FAKE_BOOK"),
      "CORRECT",
    );
  });

  test("should return POSSIBLY_TOO_STRICT when whale paid similar price", () => {
    // Whale price close to bestAsk
    assert.strictEqual(
      classifyGuardrailDecision("NORMAL_BUT_WIDE", 0.68, 0.7),
      "POSSIBLY_TOO_STRICT",
    );
  });

  test("should return UNKNOWN for other cases", () => {
    assert.strictEqual(classifyGuardrailDecision("TRADEABLE"), "UNKNOWN");
    assert.strictEqual(classifyGuardrailDecision("NORMAL_BUT_WIDE"), "UNKNOWN");
  });
});

describe("createSpreadGuardrailDiagnostic", () => {
  test("should create diagnostic with all fields for wide spread", () => {
    const diag = createSpreadGuardrailDiagnostic(0.2, 0.8, 0.5);

    assert.strictEqual(diag.bestBid, 0.2);
    assert.strictEqual(diag.bestAsk, 0.8);
    // Use toFixed to avoid floating point precision issues
    assert.strictEqual(diag.spread?.toFixed(2), "0.60");
    assert.strictEqual(diag.signalPrice, 0.5);
    assert.strictEqual(diag.guardrailType, "SPREAD_TOO_WIDE");
    assert.strictEqual(diag.marketStateClassification, "NORMAL_BUT_WIDE");
  });

  test("should detect NEARLY_RESOLVED market", () => {
    // bestAsk > 0.95 triggers NEARLY_RESOLVED
    const diag = createSpreadGuardrailDiagnostic(0.9, 0.98, 0.95);

    assert.strictEqual(diag.guardrailType, "NEARLY_RESOLVED");
    assert.strictEqual(diag.marketStateClassification, "NEARLY_RESOLVED");
    assert.strictEqual(diag.thresholdUsed, DIAG_MAX_BEST_ASK);
  });

  test("should detect EMPTY_BOOK", () => {
    const diag = createSpreadGuardrailDiagnostic(0.01, 0.99, 0.5);

    assert.strictEqual(diag.guardrailType, "EMPTY_BOOK");
    assert.strictEqual(diag.marketStateClassification, "EMPTY_OR_FAKE_BOOK");
  });

  test("should return OK for tradeable book", () => {
    const diag = createSpreadGuardrailDiagnostic(0.45, 0.55, 0.5);

    assert.strictEqual(diag.guardrailType, "OK");
    assert.strictEqual(diag.marketStateClassification, "TRADEABLE");
  });

  test("should include whale comparison when provided", () => {
    const diag = createSpreadGuardrailDiagnostic(
      0.2,
      0.8,
      0.5,
      undefined,
      0.75,
    );

    assert.strictEqual(diag.whaleTradePrice, 0.75);
    assert.strictEqual(diag.whaleSpreadAtTrade, 0.55); // 0.75 - 0.20
    assert.strictEqual(diag.whaleViolatedThreshold, true); // 0.55 > 0.30
  });
});

describe("formatSpreadGuardrailDiagnostic", () => {
  test("should format diagnostic as multiline string", () => {
    const diag = createSpreadGuardrailDiagnostic(0.2, 0.8, 0.5);
    const formatted = formatSpreadGuardrailDiagnostic(diag);

    assert.ok(formatted.includes("Spread:"), "Should include spread");
    assert.ok(
      formatted.includes("MarketState:"),
      "Should include market state",
    );
    assert.ok(
      formatted.includes("SignalPrice:"),
      "Should include signal price",
    );
    assert.ok(
      formatted.includes("GuardrailDecision:"),
      "Should include decision",
    );
  });

  test("should include whale price when present", () => {
    const diag = createSpreadGuardrailDiagnostic(
      0.2,
      0.8,
      0.5,
      undefined,
      0.75,
    );
    const formatted = formatSpreadGuardrailDiagnostic(diag);

    assert.ok(
      formatted.includes("WhalePrice: 0.75"),
      "Should include whale price",
    );
  });
});

describe("checkBookTradeable", () => {
  test("should return tradeable=true for acceptable book", () => {
    const result = checkBookTradeable(0.45, 0.55);

    assert.strictEqual(result.tradeable, true);
    assert.ok(result.diagnostic, "Should include diagnostic");
    assert.strictEqual(result.diagnostic?.guardrailType, "OK");
  });

  test("should return tradeable=false for wide spread", () => {
    const result = checkBookTradeable(0.1, 0.9);

    assert.strictEqual(result.tradeable, false);
    assert.strictEqual(result.reason, "BOOK_TOO_WIDE");
    assert.ok(result.detail, "Should include detail");
    assert.ok(result.diagnostic, "Should include diagnostic");
  });

  test("should return tradeable=false for nearly resolved market", () => {
    const result = checkBookTradeable(0.9, 0.98);

    assert.strictEqual(result.tradeable, false);
    assert.strictEqual(result.reason, "BOOK_TOO_WIDE");
    assert.ok(
      result.detail?.marketStateClassification === "NEARLY_RESOLVED",
      "Should classify as NEARLY_RESOLVED",
    );
  });

  test("should pass signal price and whale price to diagnostic", () => {
    const result = checkBookTradeable(0.2, 0.8, 0.5, 0.75);

    assert.ok(result.diagnostic, "Should include diagnostic");
    assert.strictEqual(result.diagnostic?.signalPrice, 0.5);
    assert.strictEqual(result.diagnostic?.whaleTradePrice, 0.75);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Book Sanity Pre-Filter Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("performBookSanityCheck", () => {
  const defaultCfg = { bookMaxAsk: 0.95, bookMaxSpread: 0.2 };

  test("should pass for acceptable book", () => {
    const result = performBookSanityCheck(0.45, 0.55, defaultCfg);

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.rule, undefined);
  });

  test("should reject empty/fake book (bestBid=0.01, bestAsk=0.99)", () => {
    const result = performBookSanityCheck(0.01, 0.99, defaultCfg);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "empty_book");
  });

  test("should reject ask too high (bestAsk >= 0.95)", () => {
    const result = performBookSanityCheck(0.9, 0.96, defaultCfg);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "ask_too_high");
  });

  test("should reject spread too wide (spread >= 0.20)", () => {
    // Spread = 0.50 - 0.20 = 0.30 which is > 0.20
    const result = performBookSanityCheck(0.2, 0.5, defaultCfg);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "spread_too_wide");
  });

  test("should include thresholds in detail", () => {
    const result = performBookSanityCheck(0.45, 0.55, defaultCfg);

    assert.strictEqual(result.detail.thresholds.maxAsk, 0.95);
    assert.strictEqual(result.detail.thresholds.maxSpread, 0.2);
  });

  test("should include signal price in detail when provided", () => {
    const result = performBookSanityCheck(0.45, 0.55, defaultCfg, 0.5);

    assert.strictEqual(result.detail.signalPrice, 0.5);
  });
});

describe("Cooldown tracking", () => {
  beforeEach(() => {
    // Clear cooldowns before each test
    clearBadBookCooldowns();
  });

  test("isInCooldown returns false for unknown token", () => {
    assert.strictEqual(isInCooldown("unknown-token"), false);
  });

  test("addToCooldown + isInCooldown works correctly", () => {
    const tokenId = "test-token-123";

    // Not in cooldown initially
    assert.strictEqual(isInCooldown(tokenId), false);

    // Add to cooldown for 600 seconds
    addToCooldown(tokenId, 600);

    // Now in cooldown
    assert.strictEqual(isInCooldown(tokenId), true);
  });

  test("clearBadBookCooldowns clears all cooldowns", () => {
    const tokenId = "test-token-456";

    addToCooldown(tokenId, 600);
    assert.strictEqual(isInCooldown(tokenId), true);

    clearBadBookCooldowns();
    assert.strictEqual(isInCooldown(tokenId), false);
  });
});

describe("Rejection stats", () => {
  test("createEmptyRejectionStats returns zeroed stats", () => {
    const stats = createEmptyRejectionStats();

    assert.strictEqual(stats.totalCandidates, 0);
    assert.strictEqual(stats.skippedBadBook, 0);
    assert.strictEqual(stats.skippedCooldown, 0);
    assert.strictEqual(stats.rejectedAtExecution, 0);
    assert.strictEqual(stats.executed, 0);
    assert.strictEqual(stats.byRule.askTooHigh, 0);
    assert.strictEqual(stats.byRule.spreadTooWide, 0);
    assert.strictEqual(stats.byRule.emptyBook, 0);
    assert.deepStrictEqual(stats.sampleRejected, []);
  });

  test("formatRejectionStatsSummary produces markdown output", () => {
    const stats = createEmptyRejectionStats();
    stats.totalCandidates = 5;
    stats.skippedBadBook = 3;
    stats.byRule.askTooHigh = 2;
    stats.byRule.spreadTooWide = 1;

    const formatted = formatRejectionStatsSummary(stats);

    assert.ok(formatted.includes("## Guardrail Summary"));
    assert.ok(formatted.includes("Total Candidates**: 5"));
    assert.ok(formatted.includes("Skipped (Bad Book)**: 3"));
    assert.ok(formatted.includes("askTooHigh: 2"));
    assert.ok(formatted.includes("spreadTooWide: 1"));
  });
});
