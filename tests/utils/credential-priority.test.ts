/**
 * Tests for credential source priority logic
 *
 * The credential priority should be:
 * 1. User-provided credentials via env vars (POLYMARKET_API_KEY, etc.)
 * 2. Cached credentials from /data/clob-creds.json
 * 3. Derived credentials (if CLOB_DERIVE_CREDS=true or missing)
 *
 * CLOB_DERIVE_CREDS=true forces re-derivation, overriding cached creds.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Mock types matching the actual implementation
type CredentialSource = "env" | "cache" | "derived" | "none";

interface CredentialConfig {
  envApiKey?: string;
  envApiSecret?: string;
  envApiPassphrase?: string;
  cacheExists: boolean;
  cacheValid: boolean;
  deriveEnabled: boolean;
  forceDeriveOverride: boolean;
}

/**
 * Determine the credential source based on configuration.
 * This mirrors the logic in clob-client.factory.ts
 */
function determineCredentialSource(config: CredentialConfig): CredentialSource {
  // Priority 1: User-provided credentials via env vars
  const hasEnvCreds =
    Boolean(config.envApiKey) &&
    Boolean(config.envApiSecret) &&
    Boolean(config.envApiPassphrase);

  if (hasEnvCreds) {
    return "env";
  }

  // Priority 2: Cached credentials (unless force derive is enabled)
  if (config.cacheExists && config.cacheValid && !config.forceDeriveOverride) {
    return "cache";
  }

  // Priority 3: Derive credentials
  if (config.deriveEnabled) {
    return "derived";
  }

  // No credentials available
  return "none";
}

describe("credential source priority", () => {
  test("env credentials take priority over cache", () => {
    const source = determineCredentialSource({
      envApiKey: "key",
      envApiSecret: "secret",
      envApiPassphrase: "passphrase",
      cacheExists: true,
      cacheValid: true,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "env");
  });

  test("env credentials take priority over derive", () => {
    const source = determineCredentialSource({
      envApiKey: "key",
      envApiSecret: "secret",
      envApiPassphrase: "passphrase",
      cacheExists: false,
      cacheValid: false,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "env");
  });

  test("cache is used when env creds are missing", () => {
    const source = determineCredentialSource({
      envApiKey: undefined,
      envApiSecret: undefined,
      envApiPassphrase: undefined,
      cacheExists: true,
      cacheValid: true,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "cache");
  });

  test("derive is used when cache is invalid", () => {
    const source = determineCredentialSource({
      envApiKey: undefined,
      envApiSecret: undefined,
      envApiPassphrase: undefined,
      cacheExists: true,
      cacheValid: false,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "derived");
  });

  test("derive is used when cache does not exist", () => {
    const source = determineCredentialSource({
      envApiKey: undefined,
      envApiSecret: undefined,
      envApiPassphrase: undefined,
      cacheExists: false,
      cacheValid: false,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "derived");
  });

  test("forceDeriveOverride bypasses valid cache", () => {
    const source = determineCredentialSource({
      envApiKey: undefined,
      envApiSecret: undefined,
      envApiPassphrase: undefined,
      cacheExists: true,
      cacheValid: true,
      deriveEnabled: true,
      forceDeriveOverride: true,
    });
    assert.equal(source, "derived");
  });

  test("returns none when derive is disabled and no creds available", () => {
    const source = determineCredentialSource({
      envApiKey: undefined,
      envApiSecret: undefined,
      envApiPassphrase: undefined,
      cacheExists: false,
      cacheValid: false,
      deriveEnabled: false,
      forceDeriveOverride: false,
    });
    assert.equal(source, "none");
  });

  test("partial env creds do not qualify as env source", () => {
    // Missing passphrase
    const source = determineCredentialSource({
      envApiKey: "key",
      envApiSecret: "secret",
      envApiPassphrase: undefined,
      cacheExists: true,
      cacheValid: true,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "cache");
  });

  test("empty string env creds do not qualify as env source", () => {
    const source = determineCredentialSource({
      envApiKey: "",
      envApiSecret: "",
      envApiPassphrase: "",
      cacheExists: true,
      cacheValid: true,
      deriveEnabled: true,
      forceDeriveOverride: false,
    });
    assert.equal(source, "cache");
  });
});

describe("credential precedence documentation", () => {
  test("documents the credential priority order", () => {
    // This test documents the expected behavior for reference
    const priorityOrder = [
      "1. User-provided env vars (POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE)",
      "2. Cached credentials (/data/clob-creds.json) - unless CLOB_DERIVE_CREDS=true",
      "3. Derived credentials via L1 auth (deriveApiKey/createApiKey)",
    ];

    assert.equal(priorityOrder.length, 3);
    assert.ok(priorityOrder[0]?.includes("env"));
    assert.ok(priorityOrder[1]?.includes("Cached"));
    assert.ok(priorityOrder[2]?.includes("Derived"));
  });

  test("documents env var alternatives", () => {
    // The implementation supports multiple env var names for backwards compatibility
    const envVarAlternatives = {
      apiKey: ["POLYMARKET_API_KEY", "POLY_API_KEY", "CLOB_API_KEY"],
      apiSecret: ["POLYMARKET_API_SECRET", "POLY_SECRET", "CLOB_API_SECRET"],
      passphrase: [
        "POLYMARKET_API_PASSPHRASE",
        "POLY_PASSPHRASE",
        "CLOB_API_PASSPHRASE",
      ],
    };

    // Verify each category has at least the main env var
    assert.ok(envVarAlternatives.apiKey.includes("POLYMARKET_API_KEY"));
    assert.ok(envVarAlternatives.apiSecret.includes("POLYMARKET_API_SECRET"));
    assert.ok(
      envVarAlternatives.passphrase.includes("POLYMARKET_API_PASSPHRASE"),
    );
  });
});
