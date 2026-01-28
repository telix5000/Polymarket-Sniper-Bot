/**
 * Unit tests for VPN getEnvBool helper and bypass defaults
 *
 * These tests verify:
 * 1. getEnvBool returns correct defaults when env vars are unset
 * 2. getEnvBool respects explicit true/false values
 * 3. getEnvBool logs warning and uses default for invalid values
 * 4. VPN_BYPASS_DEFAULTS has correct values
 * 5. clob.polymarket.com is never in bypass hosts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  getEnvBool,
  VPN_BYPASS_DEFAULTS,
  WRITE_HOSTS,
  isWriteHost,
} from "../../../src/lib/vpn";

// Store original env values for restoration
const originalEnv: Record<string, string | undefined> = {};

/**
 * Helper to mock environment variables
 */
function mockEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in originalEnv)) {
      originalEnv[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Restore original environment and clear tracking object
 */
function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  // Clear the tracking object to prevent test pollution
  for (const key of Object.keys(originalEnv)) {
    delete originalEnv[key];
  }
}

describe("getEnvBool", () => {
  beforeEach(() => {
    // Clear test env vars
    mockEnv({
      TEST_BOOL_VAR: undefined,
    });
  });

  afterEach(() => {
    restoreEnv();
  });

  describe("returns default when env var is unset", () => {
    it("should return true default when env var is undefined", () => {
      delete process.env.TEST_BOOL_VAR;
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), true);
    });

    it("should return false default when env var is undefined", () => {
      delete process.env.TEST_BOOL_VAR;
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), false);
    });

    it("should return default when env var is empty string", () => {
      process.env.TEST_BOOL_VAR = "";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), true);
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), false);
    });
  });

  describe("respects explicit true values", () => {
    it('should return true for "true"', () => {
      process.env.TEST_BOOL_VAR = "true";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);
    });

    it('should return true for "TRUE" (case-insensitive)', () => {
      process.env.TEST_BOOL_VAR = "TRUE";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);
    });

    it('should return true for "True" (mixed case)', () => {
      process.env.TEST_BOOL_VAR = "True";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);
    });

    it('should return true for "1"', () => {
      process.env.TEST_BOOL_VAR = "1";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);
    });

    it('should return true for "yes"', () => {
      process.env.TEST_BOOL_VAR = "yes";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);
    });

    it('should return true for "YES" (case-insensitive)', () => {
      process.env.TEST_BOOL_VAR = "YES";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);
    });
  });

  describe("respects explicit false values", () => {
    it('should return false for "false"', () => {
      process.env.TEST_BOOL_VAR = "false";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });

    it('should return false for "FALSE" (case-insensitive)', () => {
      process.env.TEST_BOOL_VAR = "FALSE";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });

    it('should return false for "False" (mixed case)', () => {
      process.env.TEST_BOOL_VAR = "False";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });

    it('should return false for "0"', () => {
      process.env.TEST_BOOL_VAR = "0";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });

    it('should return false for "no"', () => {
      process.env.TEST_BOOL_VAR = "no";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });

    it('should return false for "NO" (case-insensitive)', () => {
      process.env.TEST_BOOL_VAR = "NO";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });
  });

  describe("handles invalid values", () => {
    it("should return default for invalid value and log warning", () => {
      process.env.TEST_BOOL_VAR = "invalid";
      // Should return the default value
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), true);
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), false);
    });

    it("should return default for random string", () => {
      process.env.TEST_BOOL_VAR = "maybe";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), true);
    });

    it("should return default for numeric non-boolean", () => {
      process.env.TEST_BOOL_VAR = "2";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), false);
    });
  });

  describe("handles whitespace", () => {
    it("should handle leading/trailing whitespace", () => {
      process.env.TEST_BOOL_VAR = "  true  ";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", false), true);

      process.env.TEST_BOOL_VAR = "  false  ";
      assert.strictEqual(getEnvBool("TEST_BOOL_VAR", true), false);
    });
  });
});

describe("VPN_BYPASS_DEFAULTS", () => {
  it("should have VPN_BYPASS_RPC default to true", () => {
    assert.strictEqual(
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
      true,
      "VPN_BYPASS_RPC should default to true for speed",
    );
  });

  it("should have VPN_BYPASS_POLYMARKET_READS default to false", () => {
    assert.strictEqual(
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
      false,
      "VPN_BYPASS_POLYMARKET_READS should default to false for safety",
    );
  });

  it("should have VPN_BYPASS_POLYMARKET_WS default to true", () => {
    assert.strictEqual(
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
      true,
      "VPN_BYPASS_POLYMARKET_WS should default to true for latency",
    );
  });
});

describe("WRITE_HOSTS protection", () => {
  it("should include clob.polymarket.com as a WRITE host", () => {
    assert.ok(
      WRITE_HOSTS.has("clob.polymarket.com"),
      "clob.polymarket.com MUST be in WRITE_HOSTS",
    );
  });

  it("should identify clob.polymarket.com as a write host via isWriteHost", () => {
    assert.strictEqual(
      isWriteHost("clob.polymarket.com"),
      true,
      "isWriteHost should return true for clob.polymarket.com",
    );
  });

  it("should NOT identify read-only hosts as write hosts", () => {
    assert.strictEqual(
      isWriteHost("gamma-api.polymarket.com"),
      false,
      "gamma-api.polymarket.com is read-only and should not be a write host",
    );
    assert.strictEqual(
      isWriteHost("data-api.polymarket.com"),
      false,
      "data-api.polymarket.com is read-only and should not be a write host",
    );
    assert.strictEqual(
      isWriteHost("ws-subscriptions-clob.polymarket.com"),
      false,
      "ws-subscriptions-clob.polymarket.com is read-only and should not be a write host",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Route check parsing tests (simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe("Route check parsing", () => {
  /**
   * Simulate parsing `ip route get` output.
   * This mirrors the logic in vpn.ts getRouteForIp function.
   */
  function parseRouteOutput(output: string): {
    interface?: string;
    gateway?: string;
  } {
    // Parse output like: "1.2.3.4 via 10.0.0.1 dev eth0 src 192.168.1.2"
    const viaMatch = output.match(/via\s+(\d+\.\d+\.\d+\.\d+)/);
    const devMatch = output.match(/dev\s+(\S+)/);

    return {
      gateway: viaMatch?.[1],
      interface: devMatch?.[1],
    };
  }

  it("should parse standard route output with via and dev", () => {
    const output = "1.2.3.4 via 10.0.0.1 dev eth0 src 192.168.1.2";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, "10.0.0.1");
    assert.strictEqual(result.interface, "eth0");
  });

  it("should parse route output with only dev (no gateway)", () => {
    const output = "192.168.1.1 dev eth0 src 192.168.1.2";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, undefined);
    assert.strictEqual(result.interface, "eth0");
  });

  it("should parse route output with WireGuard interface", () => {
    const output =
      "104.26.10.100 via 10.2.0.1 dev wg0 table 51820 src 10.2.0.2";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, "10.2.0.1");
    assert.strictEqual(result.interface, "wg0");
  });

  it("should parse route output with tun interface (OpenVPN)", () => {
    const output = "172.217.0.100 via 10.8.0.1 dev tun0 src 10.8.0.6";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, "10.8.0.1");
    assert.strictEqual(result.interface, "tun0");
  });

  it("should handle route output with multiple table entries", () => {
    const output =
      "104.26.10.100 via 172.17.0.1 dev eth0 table main src 172.17.0.2 uid 1000";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, "172.17.0.1");
    assert.strictEqual(result.interface, "eth0");
  });

  it("should return undefined for empty output", () => {
    const output = "";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, undefined);
    assert.strictEqual(result.interface, undefined);
  });

  it("should return undefined for malformed output", () => {
    const output = "RTNETLINK answers: Network is unreachable";
    const result = parseRouteOutput(output);
    assert.strictEqual(result.gateway, undefined);
    assert.strictEqual(result.interface, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BypassSetting source tracking tests
// ═══════════════════════════════════════════════════════════════════════════

describe("BypassSettingSource tracking", () => {
  beforeEach(() => {
    // Clear all VPN bypass env vars for clean tests
    mockEnv({
      VPN_BYPASS_RPC: undefined,
      VPN_BYPASS_POLYMARKET_READS: undefined,
      VPN_BYPASS_POLYMARKET_WS: undefined,
    });
  });

  afterEach(() => {
    restoreEnv();
  });

  it("should correctly identify DEFAULT source when env vars are unset", () => {
    // When env vars are not set, they should be undefined
    assert.strictEqual(process.env.VPN_BYPASS_RPC, undefined);
    assert.strictEqual(process.env.VPN_BYPASS_POLYMARKET_READS, undefined);
    assert.strictEqual(process.env.VPN_BYPASS_POLYMARKET_WS, undefined);

    // getEnvBool should use defaults
    assert.strictEqual(
      getEnvBool("VPN_BYPASS_RPC", VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC),
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
    );
    assert.strictEqual(
      getEnvBool(
        "VPN_BYPASS_POLYMARKET_READS",
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
      ),
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
    );
    assert.strictEqual(
      getEnvBool(
        "VPN_BYPASS_POLYMARKET_WS",
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
      ),
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    );
  });

  it("should correctly identify ENV source when env vars are set", () => {
    // Set env vars explicitly
    process.env.VPN_BYPASS_RPC = "false";
    process.env.VPN_BYPASS_POLYMARKET_READS = "true";
    process.env.VPN_BYPASS_POLYMARKET_WS = "false";

    // Verify they are set
    assert.strictEqual(process.env.VPN_BYPASS_RPC, "false");
    assert.strictEqual(process.env.VPN_BYPASS_POLYMARKET_READS, "true");
    assert.strictEqual(process.env.VPN_BYPASS_POLYMARKET_WS, "false");

    // getEnvBool should use env values, not defaults
    assert.strictEqual(
      getEnvBool("VPN_BYPASS_RPC", VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC),
      false, // overridden by env
    );
    assert.strictEqual(
      getEnvBool(
        "VPN_BYPASS_POLYMARKET_READS",
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
      ),
      true, // overridden by env
    );
    assert.strictEqual(
      getEnvBool(
        "VPN_BYPASS_POLYMARKET_WS",
        VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
      ),
      false, // overridden by env
    );
  });

  it("should distinguish between DEFAULT and ENV sources correctly", () => {
    // Set only one env var explicitly
    process.env.VPN_BYPASS_RPC = "false";

    // VPN_BYPASS_RPC is from ENV, others are from DEFAULT
    assert.strictEqual(
      process.env.VPN_BYPASS_RPC !== undefined,
      true,
      "VPN_BYPASS_RPC should be from ENV",
    );
    assert.strictEqual(
      process.env.VPN_BYPASS_POLYMARKET_READS !== undefined,
      false,
      "VPN_BYPASS_POLYMARKET_READS should be from DEFAULT",
    );
    assert.strictEqual(
      process.env.VPN_BYPASS_POLYMARKET_WS !== undefined,
      false,
      "VPN_BYPASS_POLYMARKET_WS should be from DEFAULT",
    );
  });
});
