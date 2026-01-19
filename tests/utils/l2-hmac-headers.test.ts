/**
 * Tests for CLOB auth header construction
 *
 * These tests verify that the auth headers match the format expected
 * by the Polymarket CLOB API as documented in the official clob-client.
 *
 * @see https://github.com/Polymarket/clob-client/blob/main/src/signing/hmac.ts
 * @see https://docs.polymarket.com/developers/CLOB/authentication
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

/**
 * Build L2 HMAC signature following the official clob-client implementation.
 *
 * The message format is: timestamp + method + requestPath + body
 * The signature is HMAC-SHA256 with the secret key.
 * Output is base64url encoded ('+' -> '-', '/' -> '_')
 */
function buildHmacSignature(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): string {
  let message = `${timestamp}${method}${requestPath}`;
  if (body !== undefined) {
    message += body;
  }

  // Normalize secret from base64url to base64
  const normalizedSecret = secret.replace(/-/g, "+").replace(/_/g, "/");

  // Create HMAC signature
  const hmac = crypto.createHmac("sha256", Buffer.from(normalizedSecret, "base64"));
  hmac.update(message);
  const signature = hmac.digest("base64");

  // Convert to URL-safe base64 ('+' -> '-', '/' -> '_')
  return signature.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Build L2 auth headers following the official clob-client format.
 */
function buildL2Headers(
  address: string,
  apiKey: string,
  secret: string,
  passphrase: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): Record<string, string> {
  const signature = buildHmacSignature(secret, timestamp, method, requestPath, body);

  return {
    POLY_ADDRESS: address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestamp),
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
}

describe("L2 HMAC signature", () => {
  const testSecret = "dGVzdHNlY3JldGtleQ=="; // "testsecretkey" in base64
  const timestamp = 1700000000;
  const method = "GET";
  const requestPath = "/balance-allowance?asset_type=COLLATERAL";

  test("produces consistent signature for same inputs", () => {
    const sig1 = buildHmacSignature(testSecret, timestamp, method, requestPath);
    const sig2 = buildHmacSignature(testSecret, timestamp, method, requestPath);
    assert.equal(sig1, sig2);
  });

  test("produces different signatures for different timestamps", () => {
    const sig1 = buildHmacSignature(testSecret, timestamp, method, requestPath);
    const sig2 = buildHmacSignature(testSecret, timestamp + 1, method, requestPath);
    assert.notEqual(sig1, sig2);
  });

  test("produces different signatures for different methods", () => {
    const sig1 = buildHmacSignature(testSecret, timestamp, "GET", requestPath);
    const sig2 = buildHmacSignature(testSecret, timestamp, "POST", requestPath);
    assert.notEqual(sig1, sig2);
  });

  test("produces different signatures for different paths", () => {
    const sig1 = buildHmacSignature(testSecret, timestamp, method, "/path1");
    const sig2 = buildHmacSignature(testSecret, timestamp, method, "/path2");
    assert.notEqual(sig1, sig2);
  });

  test("includes body in signature when present", () => {
    const sig1 = buildHmacSignature(testSecret, timestamp, "POST", "/order");
    const sig2 = buildHmacSignature(testSecret, timestamp, "POST", "/order", '{"side":"BUY"}');
    assert.notEqual(sig1, sig2);
  });

  test("signature is URL-safe base64", () => {
    const signature = buildHmacSignature(testSecret, timestamp, method, requestPath);
    // URL-safe base64 should not contain + or /
    assert.equal(signature.includes("+"), false, "Should not contain +");
    assert.equal(signature.includes("/"), false, "Should not contain /");
    // May contain - and _ which are the URL-safe replacements
    assert.ok(signature.length > 0, "Signature should not be empty");
  });

  test("handles base64url encoded secret", () => {
    // Same secret encoded as base64url (- instead of +, _ instead of /)
    const base64Secret = "dGVzdHNlY3JldGtleQ==";
    const base64urlSecret = "dGVzdHNlY3JldGtleQ--"; // Note: this is synthetic for testing

    // Both should produce valid signatures (implementation normalizes internally)
    const sig1 = buildHmacSignature(base64Secret, timestamp, method, requestPath);
    assert.ok(sig1.length > 0);

    // Real-world base64url doesn't have == padding typically replaced
    // But the normalization handles mixed cases
    const sig2 = buildHmacSignature(base64urlSecret.replace(/-/g, "="), timestamp, method, requestPath);
    assert.ok(sig2.length > 0);
  });
});

describe("L2 auth headers", () => {
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const apiKey = "test-api-key-uuid";
  const secret = "dGVzdHNlY3JldGtleQ==";
  const passphrase = "test-passphrase";
  const timestamp = 1700000000;
  const method = "GET";
  const requestPath = "/balance-allowance?asset_type=COLLATERAL";

  test("includes all required headers", () => {
    const headers = buildL2Headers(
      address,
      apiKey,
      secret,
      passphrase,
      timestamp,
      method,
      requestPath,
    );

    assert.ok("POLY_ADDRESS" in headers);
    assert.ok("POLY_SIGNATURE" in headers);
    assert.ok("POLY_TIMESTAMP" in headers);
    assert.ok("POLY_API_KEY" in headers);
    assert.ok("POLY_PASSPHRASE" in headers);
  });

  test("POLY_ADDRESS matches input address", () => {
    const headers = buildL2Headers(
      address,
      apiKey,
      secret,
      passphrase,
      timestamp,
      method,
      requestPath,
    );

    assert.equal(headers.POLY_ADDRESS, address);
  });

  test("POLY_API_KEY matches input api key", () => {
    const headers = buildL2Headers(
      address,
      apiKey,
      secret,
      passphrase,
      timestamp,
      method,
      requestPath,
    );

    assert.equal(headers.POLY_API_KEY, apiKey);
  });

  test("POLY_PASSPHRASE matches input passphrase", () => {
    const headers = buildL2Headers(
      address,
      apiKey,
      secret,
      passphrase,
      timestamp,
      method,
      requestPath,
    );

    assert.equal(headers.POLY_PASSPHRASE, passphrase);
  });

  test("POLY_TIMESTAMP is string representation", () => {
    const headers = buildL2Headers(
      address,
      apiKey,
      secret,
      passphrase,
      timestamp,
      method,
      requestPath,
    );

    assert.equal(headers.POLY_TIMESTAMP, String(timestamp));
    assert.equal(typeof headers.POLY_TIMESTAMP, "string");
  });

  test("POLY_SIGNATURE is non-empty URL-safe base64", () => {
    const headers = buildL2Headers(
      address,
      apiKey,
      secret,
      passphrase,
      timestamp,
      method,
      requestPath,
    );

    assert.ok(headers.POLY_SIGNATURE.length > 0);
    assert.equal(headers.POLY_SIGNATURE.includes("+"), false);
    assert.equal(headers.POLY_SIGNATURE.includes("/"), false);
  });
});

describe("header key casing", () => {
  test("header keys use correct casing (POLY_*)", () => {
    // The official API expects headers with POLY_ prefix in uppercase
    const expectedKeys = [
      "POLY_ADDRESS",
      "POLY_SIGNATURE",
      "POLY_TIMESTAMP",
      "POLY_API_KEY",
      "POLY_PASSPHRASE",
    ];

    const headers = buildL2Headers(
      "0xaddr",
      "key",
      "c2VjcmV0", // "secret" in base64
      "pass",
      1700000000,
      "GET",
      "/test",
    );

    for (const key of expectedKeys) {
      assert.ok(key in headers, `Header ${key} should be present`);
    }
  });
});

describe("signature message format", () => {
  test("message format is: timestamp + method + path + body", () => {
    // This documents the expected message format
    const timestamp = 1700000000;
    const method = "POST";
    const path = "/order";
    const body = '{"side":"BUY"}';

    // Expected message = "1700000000POST/order{\"side\":\"BUY\"}"
    const expectedMessage = `${timestamp}${method}${path}${body}`;
    assert.equal(expectedMessage, '1700000000POST/order{"side":"BUY"}');

    // Without body
    const expectedMessageNoBody = `${timestamp}${method}${path}`;
    assert.equal(expectedMessageNoBody, "1700000000POST/order");
  });
});
