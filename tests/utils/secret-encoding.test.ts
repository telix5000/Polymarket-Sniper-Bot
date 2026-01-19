/**
 * Tests for secret encoding normalization utility
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBase64Secret,
  isBase64UrlEncoded,
  isBase64Encoded,
  detectSecretEncoding,
  validateSecret,
} from "../../src/utils/secret-encoding.util";

describe("normalizeBase64Secret", () => {
  test("returns empty string for empty input", () => {
    assert.equal(normalizeBase64Secret(""), "");
  });

  test("returns input unchanged if already base64", () => {
    const base64Secret = "abc+def/ghi=";
    assert.equal(normalizeBase64Secret(base64Secret), base64Secret);
  });

  test("converts base64url to base64", () => {
    // base64url uses - instead of + and _ instead of /
    const base64urlSecret = "abc-def_ghi=";
    const expected = "abc+def/ghi=";
    assert.equal(normalizeBase64Secret(base64urlSecret), expected);
  });

  test("handles mixed encoding (normalizes all url-safe chars)", () => {
    const mixedSecret = "abc-def+ghi_jkl/mno=";
    const expected = "abc+def+ghi/jkl/mno=";
    assert.equal(normalizeBase64Secret(mixedSecret), expected);
  });

  test("preserves padding (=) characters", () => {
    const paddedSecret = "YWJjZGVm-_==";
    const expected = "YWJjZGVm+/==";
    assert.equal(normalizeBase64Secret(paddedSecret), expected);
  });

  test("handles real-world base64url secret", () => {
    // Example: a secret that might come from the CLOB API in base64url format
    const base64urlSecret = "dGhpcyBpcyBhIHRlc3Qgc2VjcmV0IGtleQ-_";
    const expected = "dGhpcyBpcyBhIHRlc3Qgc2VjcmV0IGtleQ+/";
    assert.equal(normalizeBase64Secret(base64urlSecret), expected);
  });
});

describe("isBase64UrlEncoded", () => {
  test("returns false for empty string", () => {
    assert.equal(isBase64UrlEncoded(""), false);
  });

  test("returns true for base64url with dash", () => {
    assert.equal(isBase64UrlEncoded("abc-def"), true);
  });

  test("returns true for base64url with underscore", () => {
    assert.equal(isBase64UrlEncoded("abc_def"), true);
  });

  test("returns false for standard base64", () => {
    assert.equal(isBase64UrlEncoded("abc+def/ghi="), false);
  });

  test("returns false for alphanumeric only", () => {
    assert.equal(isBase64UrlEncoded("abcdefghij"), false);
  });
});

describe("isBase64Encoded", () => {
  test("returns false for empty string", () => {
    assert.equal(isBase64Encoded(""), false);
  });

  test("returns true for base64 with plus", () => {
    assert.equal(isBase64Encoded("abc+def"), true);
  });

  test("returns true for base64 with slash", () => {
    assert.equal(isBase64Encoded("abc/def"), true);
  });

  test("returns false for base64url", () => {
    assert.equal(isBase64Encoded("abc-def_ghi="), false);
  });

  test("returns false for alphanumeric only", () => {
    assert.equal(isBase64Encoded("abcdefghij"), false);
  });
});

describe("detectSecretEncoding", () => {
  test("returns unknown for empty string", () => {
    assert.equal(detectSecretEncoding(""), "unknown");
  });

  test("returns base64 for standard base64 encoding", () => {
    assert.equal(detectSecretEncoding("abc+def/ghi="), "base64");
  });

  test("returns base64url for url-safe encoding", () => {
    assert.equal(detectSecretEncoding("abc-def_ghi="), "base64url");
  });

  test("returns unknown for alphanumeric only", () => {
    // No special characters means we can't definitively determine the encoding
    assert.equal(detectSecretEncoding("YWJjZGVmZ2hpag"), "unknown");
  });

  test("returns unknown for mixed encoding", () => {
    // Contains both + and - which shouldn't happen in valid encoding
    assert.equal(detectSecretEncoding("abc+def-ghi"), "unknown");
  });
});

describe("validateSecret", () => {
  test("returns invalid for undefined", () => {
    const result = validateSecret(undefined);
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("empty"));
  });

  test("returns invalid for empty string", () => {
    const result = validateSecret("");
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("empty"));
  });

  test("returns invalid for too short secret", () => {
    const result = validateSecret("abc");
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("too short"));
  });

  test("returns invalid for invalid characters", () => {
    const result = validateSecret("abc!@#$%^&*()");
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes("invalid characters"));
  });

  test("returns valid for proper base64 secret", () => {
    const result = validateSecret("YWJjZGVmZ2hpamtsbW5vcA==");
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  test("returns valid for proper base64url secret", () => {
    const result = validateSecret("YWJjZGVmZ2hpamtsbW5vcA-_");
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  test("returns valid for minimum length secret", () => {
    const result = validateSecret("12345678");
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });
});
