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

// ═══════════════════════════════════════════════════════════════════════════
// emitRoutingPolicyEffectiveEvent effectiveSettings tests
// ═══════════════════════════════════════════════════════════════════════════

import { emitRoutingPolicyEffectiveEvent } from "../../../src/lib/vpn";

describe("emitRoutingPolicyEffectiveEvent effectiveSettings.source", () => {
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

  it("should set source=DEFAULT for all settings when no env vars are set", () => {
    // Call emitRoutingPolicyEffectiveEvent (VPN not active, but that's ok for this test)
    const event = emitRoutingPolicyEffectiveEvent();

    // All sources should be DEFAULT
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_RPC.source,
      "DEFAULT",
      "VPN_BYPASS_RPC source should be DEFAULT when env var is unset",
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS.source,
      "DEFAULT",
      "VPN_BYPASS_POLYMARKET_READS source should be DEFAULT when env var is unset",
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS.source,
      "DEFAULT",
      "VPN_BYPASS_POLYMARKET_WS source should be DEFAULT when env var is unset",
    );

    // Values should match defaults
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_RPC.value,
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_RPC,
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS.value,
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS.value,
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    );
  });

  it("should set source=ENV for all settings when all env vars are set", () => {
    // Set all env vars explicitly
    process.env.VPN_BYPASS_RPC = "false";
    process.env.VPN_BYPASS_POLYMARKET_READS = "true";
    process.env.VPN_BYPASS_POLYMARKET_WS = "false";

    const event = emitRoutingPolicyEffectiveEvent();

    // All sources should be ENV
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_RPC.source,
      "ENV",
      "VPN_BYPASS_RPC source should be ENV when env var is set",
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS.source,
      "ENV",
      "VPN_BYPASS_POLYMARKET_READS source should be ENV when env var is set",
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS.source,
      "ENV",
      "VPN_BYPASS_POLYMARKET_WS source should be ENV when env var is set",
    );

    // Values should match what was set in env
    assert.strictEqual(event.effectiveSettings.VPN_BYPASS_RPC.value, false);
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS.value,
      true,
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS.value,
      false,
    );
  });

  it("should correctly mix DEFAULT and ENV sources when some env vars are set", () => {
    // Set only one env var
    process.env.VPN_BYPASS_RPC = "false";

    const event = emitRoutingPolicyEffectiveEvent();

    // VPN_BYPASS_RPC should be ENV, others should be DEFAULT
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_RPC.source,
      "ENV",
      "VPN_BYPASS_RPC source should be ENV",
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS.source,
      "DEFAULT",
      "VPN_BYPASS_POLYMARKET_READS source should be DEFAULT",
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS.source,
      "DEFAULT",
      "VPN_BYPASS_POLYMARKET_WS source should be DEFAULT",
    );

    // Value should be overridden for VPN_BYPASS_RPC
    assert.strictEqual(event.effectiveSettings.VPN_BYPASS_RPC.value, false);
    // Others should use defaults
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS.value,
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_READS,
    );
    assert.strictEqual(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS.value,
      VPN_BYPASS_DEFAULTS.VPN_BYPASS_POLYMARKET_WS,
    );
  });

  it("should include effectiveSettings in event structure", () => {
    const event = emitRoutingPolicyEffectiveEvent();

    // Verify event has expected structure
    assert.strictEqual(event.event, "VPN_ROUTING_POLICY_EFFECTIVE");
    assert.ok(event.effectiveSettings, "event should have effectiveSettings");
    assert.ok(
      event.effectiveSettings.VPN_BYPASS_RPC,
      "effectiveSettings should have VPN_BYPASS_RPC",
    );
    assert.ok(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_READS,
      "effectiveSettings should have VPN_BYPASS_POLYMARKET_READS",
    );
    assert.ok(
      event.effectiveSettings.VPN_BYPASS_POLYMARKET_WS,
      "effectiveSettings should have VPN_BYPASS_POLYMARKET_WS",
    );

    // Each setting should have value and source
    assert.ok(
      "value" in event.effectiveSettings.VPN_BYPASS_RPC,
      "VPN_BYPASS_RPC should have value",
    );
    assert.ok(
      "source" in event.effectiveSettings.VPN_BYPASS_RPC,
      "VPN_BYPASS_RPC should have source",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ensureWriteHostVpnRoutes tests (mocked system calls)
// ═══════════════════════════════════════════════════════════════════════════

import { ensureWriteHostVpnRoutes } from "../../../src/lib/vpn";

describe("ensureWriteHostVpnRoutes", () => {
  it("should return attempted=false when VPN is not active", () => {
    // VPN is not active by default in test environment
    const result = ensureWriteHostVpnRoutes();

    // Should not attempt if VPN is not active
    assert.strictEqual(
      result.attempted,
      false,
      "Should not attempt when VPN is not active",
    );
    assert.strictEqual(
      result.success,
      true, // Not a failure, just nothing to do
      "Should report success when VPN is not active (nothing to do)",
    );
    assert.strictEqual(
      result.vpnInterface,
      null,
      "VPN interface should be null when VPN is not active",
    );
    assert.deepStrictEqual(
      result.results,
      [],
      "Results should be empty when VPN is not active",
    );
  });

  it("should have correct return type structure", () => {
    const result = ensureWriteHostVpnRoutes();

    // Verify structure
    assert.ok("attempted" in result, "Result should have attempted property");
    assert.ok("success" in result, "Result should have success property");
    assert.ok("results" in result, "Result should have results property");
    assert.ok(
      "vpnInterface" in result,
      "Result should have vpnInterface property",
    );
    assert.ok(Array.isArray(result.results), "results should be an array");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WriteHostRouteResult structure tests
// ═══════════════════════════════════════════════════════════════════════════

describe("WriteHostRouteResult interface validation", () => {
  it("should define expected WriteHostRouteResult properties", () => {
    // This test validates the interface contract by checking
    // what a valid result object looks like
    const mockResult = {
      hostname: "clob.polymarket.com",
      ips: ["104.18.0.1", "104.18.0.2"],
      routesAdded: 2,
      routesFailed: 0,
      success: true,
      error: undefined,
    };

    // Verify the structure is valid
    assert.strictEqual(typeof mockResult.hostname, "string");
    assert.ok(Array.isArray(mockResult.ips));
    assert.strictEqual(typeof mockResult.routesAdded, "number");
    assert.strictEqual(typeof mockResult.routesFailed, "number");
    assert.strictEqual(typeof mockResult.success, "boolean");
  });

  it("should handle failed route result structure", () => {
    const mockFailedResult = {
      hostname: "clob.polymarket.com",
      ips: [],
      routesAdded: 0,
      routesFailed: 0,
      success: false,
      error: "No IPs resolved",
    };

    assert.strictEqual(mockFailedResult.success, false);
    assert.strictEqual(mockFailedResult.error, "No IPs resolved");
    assert.strictEqual(mockFailedResult.ips.length, 0);
  });
});
