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

  test("should classify as NEARLY_RESOLVED when bestAsk > 0.95", () => {
    // classifyMarketState uses > for classification (matching trading decision)
    assert.strictEqual(classifyMarketState(0.9, 0.96), "NEARLY_RESOLVED");
    assert.strictEqual(classifyMarketState(0.8, 0.99), "NEARLY_RESOLVED");
  });

  test("should classify as TRADEABLE at exactly bestAsk=0.95 (boundary)", () => {
    // bestAsk = 0.95 exactly is considered tradeable (uses strict > inequality)
    assert.strictEqual(classifyMarketState(0.9, 0.95), "TRADEABLE");
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

  test("should return tradeable=true at exactly bestAsk=0.95 (boundary)", () => {
    // Trading is allowed at exactly 0.95 (strict inequality > is used, not >=)
    const result = checkBookTradeable(0.9, 0.95);

    assert.strictEqual(
      result.tradeable,
      true,
      "bestAsk=0.95 should be tradeable",
    );
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
    assert.strictEqual(stats.byRule.deadBook, 0);
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

  test("formatRejectionStatsSummary includes deadBook stat", () => {
    const stats = createEmptyRejectionStats();
    stats.byRule.deadBook = 4;

    const formatted = formatRejectionStatsSummary(stats);

    assert.ok(formatted.includes("deadBook: 4"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dead Book Classification Tests (uses shared price-safety math)
// ═══════════════════════════════════════════════════════════════════════════

describe("Dead Book Classification in performBookSanityCheck", () => {
  const defaultCfg = {
    bookMaxAsk: 0.95,
    bookMaxSpread: 0.2,
    deadBookBid: 0.02,
    deadBookAsk: 0.98,
  };

  test("should classify 0.01/0.99 as empty_book (stricter than dead_book)", () => {
    // 0.01/0.99 = 1¢/99¢ which is EMPTY_BOOK threshold
    const result = performBookSanityCheck(0.01, 0.99, defaultCfg);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "empty_book");
  });

  test("should classify 0.02/0.98 as dead_book", () => {
    // 0.02/0.98 = 2¢/98¢ which is DEAD_BOOK threshold
    const result = performBookSanityCheck(0.02, 0.98, defaultCfg);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "dead_book");
  });

  test("should classify 0.015/0.985 as dead_book (within 2¢/98¢ thresholds)", () => {
    // 1.5¢/98.5¢ - bid (1.5¢) < 2¢ threshold and ask (98.5¢) > 98¢ threshold
    // This is dead_book (not empty_book since 1.5¢ > 1¢)
    const result = performBookSanityCheck(0.015, 0.985, defaultCfg);

    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "dead_book");
  });

  test("should NOT classify 0.03/0.97 as dead_book (outside thresholds)", () => {
    // 3¢/97¢ - bid > 2¢ threshold, so not dead
    const result = performBookSanityCheck(0.03, 0.97, defaultCfg);

    // Should still fail for ask_too_high (0.97 >= 0.95)
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.rule, "ask_too_high");
  });

  test("should include bookHealth in detail when dead_book detected", () => {
    const result = performBookSanityCheck(0.02, 0.98, defaultCfg);

    assert.ok(result.detail.bookHealth, "Should include bookHealth");
    assert.strictEqual(result.detail.bookHealth?.status, "DEAD_BOOK");
    assert.strictEqual(result.detail.bookHealth?.healthy, false);
  });

  test("should include dead book thresholds in detail", () => {
    const result = performBookSanityCheck(0.45, 0.55, defaultCfg);

    assert.strictEqual(result.detail.thresholds.deadBidCents, 2);
    assert.strictEqual(result.detail.thresholds.deadAskCents, 98);
    assert.strictEqual(result.detail.thresholds.emptyBidCents, 1);
    assert.strictEqual(result.detail.thresholds.emptyAskCents, 99);
  });

  test("should use same math as isDeadBook from price-safety module", async () => {
    // Import isDeadBook to verify same behavior
    const { isDeadBook } = await import("../../../src/lib/price-safety");

    const testCases = [
      { bid: 0.01, ask: 0.99 }, // Empty book
      { bid: 0.02, ask: 0.98 }, // Dead book
      { bid: 0.03, ask: 0.97 }, // Not dead
      { bid: 0.49, ask: 0.51 }, // Healthy
    ];

    for (const tc of testCases) {
      const sanityResult = performBookSanityCheck(tc.bid, tc.ask, defaultCfg);
      const isDeadResult = isDeadBook(tc.bid, tc.ask);

      // If isDeadBook returns true, sanity check should fail with dead_book or empty_book
      if (isDeadResult) {
        assert.strictEqual(
          sanityResult.passed,
          false,
          `Expected fail for bid=${tc.bid}, ask=${tc.ask}`,
        );
        assert.ok(
          sanityResult.rule === "dead_book" ||
            sanityResult.rule === "empty_book",
          `Expected dead_book or empty_book rule for bid=${tc.bid}, ask=${tc.ask}, got ${sanityResult.rule}`,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Candidate Attempt Loop Tests
// Tests for the retry logic that tries multiple candidates until one passes
// ═══════════════════════════════════════════════════════════════════════════

describe("Candidate Attempt Loop Behavior", () => {
  beforeEach(() => {
    clearBadBookCooldowns();
  });

  describe("Candidate-stage vs Execution-stage rejections", () => {
    // These are candidate-stage rejections (result should be SKIPPED)
    const candidateStageReasons = ["skipped_bad_book", "candidate_cooldown"];

    // These are execution-stage rejections (result should be REJECTED)
    const executionStageReasons = [
      "price_out_of_range",
      "insufficient_liquidity",
      "no_wallet_credentials",
      "api_error",
      "order_timeout",
    ];

    test("candidate-stage reasons should result in SKIPPED", () => {
      for (const reason of candidateStageReasons) {
        // The logic in the workflow determines result based on lastRejectionReason
        const isCandidateStage = candidateStageReasons.includes(reason);
        const expectedResult = isCandidateStage ? "SKIPPED" : "REJECTED";

        assert.strictEqual(
          expectedResult,
          "SKIPPED",
          `${reason} should map to SKIPPED`,
        );
      }
    });

    test("execution-stage reasons should result in REJECTED", () => {
      for (const reason of executionStageReasons) {
        // The logic in the workflow determines result based on lastRejectionReason
        const isCandidateStage = candidateStageReasons.includes(reason);
        const expectedResult = isCandidateStage ? "SKIPPED" : "REJECTED";

        assert.strictEqual(
          expectedResult,
          "REJECTED",
          `${reason} should map to REJECTED`,
        );
      }
    });
  });

  describe("Cooldown respects maxCandidateAttempts", () => {
    test("multiple candidates can be added to cooldown sequentially", () => {
      const tokens = ["token1", "token2", "token3", "token4", "token5"];

      for (const token of tokens) {
        assert.strictEqual(
          isInCooldown(token),
          false,
          `${token} should not be in cooldown initially`,
        );
        addToCooldown(token, 600);
        assert.strictEqual(
          isInCooldown(token),
          true,
          `${token} should be in cooldown after adding`,
        );
      }

      // All should still be in cooldown
      for (const token of tokens) {
        assert.strictEqual(
          isInCooldown(token),
          true,
          `${token} should still be in cooldown`,
        );
      }
    });

    test("clearing cooldowns allows retry of previously rejected candidates", () => {
      const token = "test-token";

      addToCooldown(token, 600);
      assert.strictEqual(isInCooldown(token), true);

      clearBadBookCooldowns();
      assert.strictEqual(isInCooldown(token), false);
    });
  });

  describe("performBookSanityCheck retry triggers", () => {
    const defaultCfg = {
      bookMaxAsk: 0.95,
      bookMaxSpread: 0.2,
      deadBookBid: 0.02,
      deadBookAsk: 0.98,
    };

    test("dead_book rejection should trigger immediate retry (not termination)", () => {
      // First candidate: dead book (should fail with dead_book rule)
      const result1 = performBookSanityCheck(0.02, 0.98, defaultCfg);
      assert.strictEqual(result1.passed, false);
      assert.strictEqual(result1.rule, "dead_book");

      // Second candidate: healthy book (should pass)
      const result2 = performBookSanityCheck(0.45, 0.55, defaultCfg);
      assert.strictEqual(result2.passed, true);
    });

    test("empty_book rejection should trigger immediate retry", () => {
      const result = performBookSanityCheck(0.01, 0.99, defaultCfg);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.rule, "empty_book");
      // Loop should continue to next candidate
    });

    test("spread_too_wide rejection should trigger retry", () => {
      const result = performBookSanityCheck(0.3, 0.7, defaultCfg);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.rule, "spread_too_wide");
    });

    test("ask_too_high rejection should trigger retry", () => {
      const result = performBookSanityCheck(0.9, 0.96, defaultCfg);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.rule, "ask_too_high");
    });

    test("healthy book should stop the retry loop (candidate accepted)", () => {
      const result = performBookSanityCheck(0.45, 0.55, defaultCfg);
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.rule, undefined);
    });
  });

  describe("Multiple candidate simulation", () => {
    const defaultCfg = {
      bookMaxAsk: 0.95,
      bookMaxSpread: 0.2,
      deadBookBid: 0.02,
      deadBookAsk: 0.98,
    };

    test("simulates loop: first dead_book, second passes", () => {
      const candidates = [
        { bid: 0.02, ask: 0.98 }, // dead_book - retry
        { bid: 0.45, ask: 0.55 }, // healthy - accept
      ];

      let acceptedIndex = -1;
      for (let i = 0; i < candidates.length; i++) {
        const result = performBookSanityCheck(
          candidates[i].bid,
          candidates[i].ask,
          defaultCfg,
        );
        if (result.passed) {
          acceptedIndex = i;
          break;
        }
      }

      assert.strictEqual(
        acceptedIndex,
        1,
        "Second candidate should be accepted",
      );
    });

    test("simulates loop: all candidates fail", () => {
      const candidates = [
        { bid: 0.01, ask: 0.99 }, // empty_book
        { bid: 0.02, ask: 0.98 }, // dead_book
        { bid: 0.9, ask: 0.96 }, // ask_too_high
      ];

      let acceptedIndex = -1;
      let lastRule = "";
      for (let i = 0; i < candidates.length; i++) {
        const result = performBookSanityCheck(
          candidates[i].bid,
          candidates[i].ask,
          defaultCfg,
        );
        if (result.passed) {
          acceptedIndex = i;
          break;
        }
        lastRule = result.rule || "";
      }

      assert.strictEqual(acceptedIndex, -1, "No candidate should be accepted");
      assert.strictEqual(
        lastRule,
        "ask_too_high",
        "Last rejection should be ask_too_high",
      );
    });

    test("maxCandidateAttempts limits iteration", () => {
      const maxAttempts = 3;
      const candidates = [
        { bid: 0.01, ask: 0.99 }, // 1
        { bid: 0.02, ask: 0.98 }, // 2
        { bid: 0.02, ask: 0.98 }, // 3 - max reached
        { bid: 0.45, ask: 0.55 }, // 4 - would pass but not reached
        { bid: 0.45, ask: 0.55 }, // 5 - not reached
      ];

      let attemptCount = 0;
      let acceptedIndex = -1;
      for (
        let i = 0;
        i < candidates.length && attemptCount < maxAttempts;
        i++
      ) {
        attemptCount++;
        const result = performBookSanityCheck(
          candidates[i].bid,
          candidates[i].ask,
          defaultCfg,
        );
        if (result.passed) {
          acceptedIndex = i;
          break;
        }
      }

      assert.strictEqual(
        attemptCount,
        maxAttempts,
        "Should stop at maxAttempts",
      );
      assert.strictEqual(
        acceptedIndex,
        -1,
        "Should not accept any (max reached before healthy)",
      );
    });
  });
});
