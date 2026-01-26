/**
 * Tests for auth fallback system
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_LADDER,
  isInvalidL1HeadersError,
  isCouldNotCreateKeyError,
  extractStatusCode,
  extractErrorMessage,
  signatureTypeLabel,
  generateFailureSummary,
} from "../../src/clob/auth-fallback";
import { SignatureType } from "@polymarket/order-utils";

test("FALLBACK_LADDER has correct order", () => {
  assert.equal(FALLBACK_LADDER.length, 5);

  // A) EOA + signer
  assert.equal(FALLBACK_LADDER[0]?.signatureType, SignatureType.EOA);
  assert.equal(FALLBACK_LADDER[0]?.useEffectiveForL1, false);

  // B) Safe + signer
  assert.equal(
    FALLBACK_LADDER[1]?.signatureType,
    SignatureType.POLY_GNOSIS_SAFE,
  );
  assert.equal(FALLBACK_LADDER[1]?.useEffectiveForL1, false);

  // C) Safe + effective
  assert.equal(
    FALLBACK_LADDER[2]?.signatureType,
    SignatureType.POLY_GNOSIS_SAFE,
  );
  assert.equal(FALLBACK_LADDER[2]?.useEffectiveForL1, true);

  // D) Proxy + signer
  assert.equal(FALLBACK_LADDER[3]?.signatureType, SignatureType.POLY_PROXY);
  assert.equal(FALLBACK_LADDER[3]?.useEffectiveForL1, false);

  // E) Proxy + effective
  assert.equal(FALLBACK_LADDER[4]?.signatureType, SignatureType.POLY_PROXY);
  assert.equal(FALLBACK_LADDER[4]?.useEffectiveForL1, true);
});

test("isInvalidL1HeadersError - detects 401 with message", () => {
  const error = {
    response: {
      status: 401,
      data: { message: "Invalid L1 Request headers" },
    },
    message: "Request failed",
  };

  assert.equal(isInvalidL1HeadersError(error), true);
});

test("isInvalidL1HeadersError - detects 401 in message field", () => {
  const error = {
    response: { status: 401 },
    message: "Invalid L1 Request headers",
  };

  assert.equal(isInvalidL1HeadersError(error), true);
});

test("isInvalidL1HeadersError - returns false for non-401", () => {
  const error = {
    response: {
      status: 400,
      data: { message: "Invalid L1 Request headers" },
    },
  };

  assert.equal(isInvalidL1HeadersError(error), false);
});

test("isInvalidL1HeadersError - returns false without message", () => {
  const error = {
    response: { status: 401 },
    message: "Unauthorized",
  };

  assert.equal(isInvalidL1HeadersError(error), false);
});

test("isCouldNotCreateKeyError - detects 400 with message", () => {
  const error = {
    response: {
      status: 400,
      data: { message: "Could not create api key" },
    },
  };

  assert.equal(isCouldNotCreateKeyError(error), true);
});

test("isCouldNotCreateKeyError - returns false for non-400", () => {
  const error = {
    response: {
      status: 401,
      data: { message: "Could not create api key" },
    },
  };

  assert.equal(isCouldNotCreateKeyError(error), false);
});

test("extractStatusCode - from response.status", () => {
  const error = { response: { status: 401 } };
  assert.equal(extractStatusCode(error), 401);
});

test("extractStatusCode - from status", () => {
  const error = { status: 403 };
  assert.equal(extractStatusCode(error), 403);
});

test("extractStatusCode - returns undefined when missing", () => {
  const error = { message: "error" };
  assert.equal(extractStatusCode(error), undefined);
});

test("extractErrorMessage - from string error", () => {
  const error = "Something went wrong";
  assert.equal(extractErrorMessage(error), "Something went wrong");
});

test("extractErrorMessage - from error.message", () => {
  const error = { message: "Network error" };
  assert.equal(extractErrorMessage(error), "Network error");
});

test("extractErrorMessage - from response.data string", () => {
  const error = { response: { data: "Invalid request" } };
  assert.equal(extractErrorMessage(error), "Invalid request");
});

test("extractErrorMessage - from response.data object", () => {
  const error = { response: { data: { error: "Bad request" } } };
  assert.ok(extractErrorMessage(error).includes("Bad request"));
});

test("extractErrorMessage - returns unknown for empty", () => {
  const error = {};
  assert.equal(extractErrorMessage(error), "Unknown error");
});

test("signatureTypeLabel - EOA", () => {
  assert.equal(signatureTypeLabel(SignatureType.EOA), "EOA");
});

test("signatureTypeLabel - Proxy", () => {
  assert.equal(signatureTypeLabel(SignatureType.POLY_PROXY), "Proxy");
});

test("signatureTypeLabel - Safe", () => {
  assert.equal(signatureTypeLabel(SignatureType.POLY_GNOSIS_SAFE), "Safe");
});

test("signatureTypeLabel - Unknown", () => {
  assert.equal(signatureTypeLabel(99), "Unknown(99)");
});

// Test generateFailureSummary log-level gating
test("generateFailureSummary - outputs compact summary without debug level", () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalDebug = process.env.DEBUG;

  try {
    process.env.LOG_LEVEL = "info";
    delete process.env.DEBUG;

    const messages: string[] = [];
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: (msg: string) => messages.push(msg),
      debug: (msg: string) => messages.push(`DEBUG: ${msg}`),
    };

    const results = [
      { success: false, error: "Error A", statusCode: 401 },
      { success: false, error: "Error B", statusCode: 401 },
    ];

    generateFailureSummary(results, mockLogger);

    // Should have only 1 compact error message, no debug output
    assert.equal(messages.length, 1);
    assert.ok(
      messages[0]?.includes("All 2 credential derivation attempts failed"),
    );
    assert.ok(messages[0]?.includes("Error B")); // Last error
    assert.ok(!messages.some((m) => m.includes("DEBUG:"))); // No debug messages
  } finally {
    // Restore environment variables even if test fails
    if (originalLogLevel) process.env.LOG_LEVEL = originalLogLevel;
    else delete process.env.LOG_LEVEL;
    if (originalDebug) process.env.DEBUG = originalDebug;
  }
});

test.skip("generateFailureSummary - outputs verbose details at debug level", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  try {
    process.env.LOG_LEVEL = "debug";

    const messages: string[] = [];
    const mockLogger = {
      info: () => {},
      warn: () => {},
      error: (msg: string) => messages.push(`ERROR: ${msg}`),
      debug: (msg: string) => messages.push(`DEBUG: ${msg}`),
    };

    const results = [
      { success: false, error: "Error A", statusCode: 401 },
      { success: false, error: "Error B", statusCode: 400 },
    ];

    generateFailureSummary(results, mockLogger);

    // Should have both error and debug messages
    assert.ok(messages.some((m) => m.includes("ERROR:")));
    assert.ok(messages.some((m) => m.includes("DEBUG:")));
    assert.ok(messages.some((m) => m.includes("POSSIBLE CAUSES")));
  } finally {
    // Restore environment variables even if test fails
    if (originalLogLevel) process.env.LOG_LEVEL = originalLogLevel;
    else delete process.env.LOG_LEVEL;
  }
});
