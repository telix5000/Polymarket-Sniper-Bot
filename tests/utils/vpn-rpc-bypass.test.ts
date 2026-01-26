import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { getVpnBypassConfig } from "../../src/utils/vpn-rpc-bypass.util";

describe("VPN RPC Bypass Configuration", () => {
  const originalEnv = { ...process.env };

  // Helper to reset env after each test
  const resetEnv = () => {
    // Remove test keys
    delete process.env.VPN_BYPASS_RPC;
    delete process.env.vpn_bypass_rpc;
    delete process.env.RPC_URL;
    delete process.env.rpc_url;
  };

  test("VPN_BYPASS_RPC defaults to true when not set", () => {
    resetEnv();
    const config = getVpnBypassConfig();
    assert.strictEqual(config.enabled, true, "Should default to true");
  });

  test("VPN_BYPASS_RPC=true enables bypass", () => {
    resetEnv();
    process.env.VPN_BYPASS_RPC = "true";
    const config = getVpnBypassConfig();
    assert.strictEqual(config.enabled, true);
  });

  test("VPN_BYPASS_RPC=false disables bypass", () => {
    resetEnv();
    process.env.VPN_BYPASS_RPC = "false";
    const config = getVpnBypassConfig();
    assert.strictEqual(config.enabled, false);
  });

  test("VPN_BYPASS_RPC handles uppercase FALSE", () => {
    resetEnv();
    process.env.VPN_BYPASS_RPC = "FALSE";
    const config = getVpnBypassConfig();
    assert.strictEqual(config.enabled, false, "Should handle uppercase FALSE");
  });

  test("VPN_BYPASS_RPC handles uppercase TRUE", () => {
    resetEnv();
    process.env.VPN_BYPASS_RPC = "TRUE";
    const config = getVpnBypassConfig();
    assert.strictEqual(config.enabled, true, "Should handle uppercase TRUE");
  });

  test("lowercase vpn_bypass_rpc is supported", () => {
    resetEnv();
    process.env.vpn_bypass_rpc = "false";
    const config = getVpnBypassConfig();
    assert.strictEqual(
      config.enabled,
      false,
      "Should support lowercase env var",
    );
  });

  test("RPC_URL is read from environment", () => {
    resetEnv();
    process.env.RPC_URL = "https://polygon-rpc.com";
    const config = getVpnBypassConfig();
    assert.strictEqual(config.rpcUrl, "https://polygon-rpc.com");
  });

  test("rpcUrl defaults to empty string when not set", () => {
    resetEnv();
    const config = getVpnBypassConfig();
    assert.strictEqual(config.rpcUrl, "");
  });

  test("empty VPN_BYPASS_RPC defaults to true", () => {
    resetEnv();
    process.env.VPN_BYPASS_RPC = "";
    const config = getVpnBypassConfig();
    assert.strictEqual(
      config.enabled,
      true,
      "Empty string should default to true",
    );
  });

  // Restore original environment after all tests
  after(() => {
    resetEnv();
    Object.assign(process.env, originalEnv);
  });
});
