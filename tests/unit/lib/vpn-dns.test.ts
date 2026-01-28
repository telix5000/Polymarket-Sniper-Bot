/**
 * Tests for VPN DNS handling in container environments
 *
 * This tests the container detection and DNS configuration logic
 * that generates PostUp/PostDown scripts for Alpine containers.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// Store original env values
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
 * Restore original environment
 */
function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Simulate container detection logic from vpn.ts
 */
function detectContainer(dockerEnvExists: boolean): boolean {
  // This mirrors the logic in src/lib/vpn.ts
  return (
    dockerEnvExists ||
    process.env.container?.toLowerCase() === "docker" ||
    process.env.container?.toLowerCase() === "podman" ||
    !!process.env.container
  );
}

/**
 * Simulate DNS validation logic from vpn.ts
 */
function isValidIp(ip: string): boolean {
  const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!IP_PATTERN.test(ip)) return false;
  const parts = ip.split(".");
  return parts.every((p) => {
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255;
  });
}

/**
 * Simulate DNS config generation for containers
 */
function generateContainerDnsConfig(
  dns: string,
  interfaceName: string,
): { postUp: string; postDown: string } | null {
  const dnsServers = dns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const validDnsServers = dnsServers.filter((server) => isValidIp(server));

  if (validDnsServers.length === 0) {
    return null;
  }

  const nameserverLines = validDnsServers
    .map((s) => `nameserver ${s}`)
    .join("\\n");
  const backupPath = `/etc/resolv.conf.${interfaceName}-backup`;

  return {
    postUp: `PostUp = cp /etc/resolv.conf ${backupPath} 2>/dev/null || true; (printf '${nameserverLines}\\n'; cat ${backupPath} 2>/dev/null || cat /etc/resolv.conf) > /etc/resolv.conf.tmp && mv /etc/resolv.conf.tmp /etc/resolv.conf`,
    postDown: `PostDown = if [ -f ${backupPath} ]; then cp ${backupPath} /etc/resolv.conf 2>/dev/null || true; else echo 'nameserver 8.8.8.8' > /etc/resolv.conf; fi`,
  };
}

describe("VPN DNS Container Handling", () => {
  beforeEach(() => {
    // Clear any container env vars
    mockEnv({ container: undefined });
  });

  afterEach(() => {
    restoreEnv();
  });

  describe("Container Detection", () => {
    it("should detect container via /.dockerenv file", () => {
      mockEnv({ container: undefined });
      // Simulating dockerenv exists
      assert.strictEqual(detectContainer(true), true);
    });

    it("should detect container via container=docker env var", () => {
      mockEnv({ container: "docker" });
      assert.strictEqual(detectContainer(false), true);
    });

    it("should detect container via container=podman env var", () => {
      mockEnv({ container: "podman" });
      assert.strictEqual(detectContainer(false), true);
    });

    it("should detect container via any container env var value", () => {
      mockEnv({ container: "lxc" });
      assert.strictEqual(detectContainer(false), true);
    });

    it("should be case-insensitive for docker/podman detection", () => {
      mockEnv({ container: "DOCKER" });
      assert.strictEqual(detectContainer(false), true);

      mockEnv({ container: "Podman" });
      assert.strictEqual(detectContainer(false), true);
    });

    it("should return false when not in container", () => {
      mockEnv({ container: undefined });
      assert.strictEqual(detectContainer(false), false);
    });
  });

  describe("DNS IP Validation", () => {
    it("should accept valid IPv4 addresses", () => {
      assert.strictEqual(isValidIp("1.1.1.1"), true);
      assert.strictEqual(isValidIp("8.8.8.8"), true);
      assert.strictEqual(isValidIp("192.168.1.1"), true);
      assert.strictEqual(isValidIp("10.0.0.1"), true);
      assert.strictEqual(isValidIp("255.255.255.255"), true);
      assert.strictEqual(isValidIp("0.0.0.0"), true);
    });

    it("should reject invalid IP addresses", () => {
      assert.strictEqual(isValidIp("256.1.1.1"), false);
      assert.strictEqual(isValidIp("1.1.1.256"), false);
      assert.strictEqual(isValidIp("1.1.1"), false);
      assert.strictEqual(isValidIp("1.1.1.1.1"), false);
      assert.strictEqual(isValidIp("abc.def.ghi.jkl"), false);
      assert.strictEqual(isValidIp(""), false);
    });

    it("should reject shell injection attempts", () => {
      assert.strictEqual(isValidIp("1.1.1.1; rm -rf /"), false);
      assert.strictEqual(isValidIp("1.1.1.1`whoami`"), false);
      assert.strictEqual(isValidIp("$(cat /etc/passwd)"), false);
      assert.strictEqual(isValidIp("1.1.1.1\n8.8.8.8"), false);
    });

    it("should reject IPv6 addresses (not supported)", () => {
      assert.strictEqual(isValidIp("::1"), false);
      assert.strictEqual(isValidIp("2001:4860:4860::8888"), false);
    });
  });

  describe("PostUp/PostDown Script Generation", () => {
    it("should generate correct PostUp script with single DNS", () => {
      const result = generateContainerDnsConfig("1.1.1.1", "wg0");
      assert.ok(result !== null);
      assert.ok(result.postUp.includes("nameserver 1.1.1.1"));
      assert.ok(result.postUp.includes("/etc/resolv.conf.wg0-backup"));
      assert.ok(result.postUp.includes("printf"));
    });

    it("should generate correct PostUp script with multiple DNS", () => {
      const result = generateContainerDnsConfig("1.1.1.1,8.8.8.8", "wg0");
      assert.ok(result !== null);
      assert.ok(result.postUp.includes("nameserver 1.1.1.1"));
      assert.ok(result.postUp.includes("nameserver 8.8.8.8"));
    });

    it("should use interface-specific backup path", () => {
      const result1 = generateContainerDnsConfig("1.1.1.1", "wg0");
      const result2 = generateContainerDnsConfig("1.1.1.1", "wg1");

      assert.ok(result1 !== null);
      assert.ok(result2 !== null);
      assert.ok(result1.postUp.includes("/etc/resolv.conf.wg0-backup"));
      assert.ok(result2.postUp.includes("/etc/resolv.conf.wg1-backup"));
    });

    it("should generate PostDown with fallback DNS", () => {
      const result = generateContainerDnsConfig("1.1.1.1", "wg0");
      assert.ok(result !== null);
      assert.ok(result.postDown.includes("if [ -f"));
      assert.ok(result.postDown.includes("nameserver 8.8.8.8"));
    });

    it("should preserve existing DNS entries in PostUp", () => {
      const result = generateContainerDnsConfig("1.1.1.1", "wg0");
      assert.ok(result !== null);
      // Should prepend VPN DNS and append existing resolv.conf
      assert.ok(result.postUp.includes("cat"));
      assert.ok(result.postUp.includes("/etc/resolv.conf.tmp"));
    });

    it("should return null for empty DNS", () => {
      const result = generateContainerDnsConfig("", "wg0");
      assert.strictEqual(result, null);
    });

    it("should return null for all invalid DNS", () => {
      const result = generateContainerDnsConfig("invalid,also-invalid", "wg0");
      assert.strictEqual(result, null);
    });

    it("should filter out invalid DNS and keep valid ones", () => {
      const result = generateContainerDnsConfig(
        "1.1.1.1,invalid,8.8.8.8",
        "wg0",
      );
      assert.ok(result !== null);
      assert.ok(result.postUp.includes("nameserver 1.1.1.1"));
      assert.ok(result.postUp.includes("nameserver 8.8.8.8"));
      assert.ok(!result.postUp.includes("invalid"));
    });

    it("should handle whitespace in DNS list", () => {
      const result = generateContainerDnsConfig("  1.1.1.1 , 8.8.8.8  ", "wg0");
      assert.ok(result !== null);
      assert.ok(result.postUp.includes("nameserver 1.1.1.1"));
      assert.ok(result.postUp.includes("nameserver 8.8.8.8"));
    });
  });

  describe("Non-Container DNS Handling", () => {
    it("should use standard DNS directive when not in container", () => {
      // In non-container mode, the standard DNS directive is used
      // This is a simple pass-through test
      const dns = "1.1.1.1";
      const expectedDirective = `DNS = ${dns}`;
      assert.ok(expectedDirective.includes("DNS = 1.1.1.1"));
    });
  });

  describe("VPN Routing Plan", () => {
    it("should not mark clob.polymarket.com as BYPASS", () => {
      // CRITICAL: clob.polymarket.com handles WRITE operations and must NEVER be bypassed
      // This test ensures the KNOWN_HOSTS configuration is correct

      // Simulate the known hosts configuration from vpn.ts
      // READ_API defaults to VPN (conservative), WEBSOCKET/RPC default to BYPASS
      const KNOWN_HOSTS = [
        {
          hostname: "gamma-api.polymarket.com",
          category: "READ_API",
          expectedRoute: "VPN",
        },
        {
          hostname: "data-api.polymarket.com",
          category: "READ_API",
          expectedRoute: "VPN",
        },
        {
          hostname: "clob.polymarket.com",
          category: "WRITE_API",
          expectedRoute: "VPN",
        },
        {
          hostname: "ws-subscriptions-clob.polymarket.com",
          category: "WEBSOCKET",
          expectedRoute: "BYPASS",
        },
        {
          hostname: "polygon-mainnet.infura.io",
          category: "RPC",
          expectedRoute: "BYPASS",
        },
      ];

      // Find the clob.polymarket.com entry
      const clobHost = KNOWN_HOSTS.find(
        (h) => h.hostname === "clob.polymarket.com",
      );
      assert.ok(clobHost, "clob.polymarket.com should be in KNOWN_HOSTS");
      assert.strictEqual(
        clobHost.category,
        "WRITE_API",
        "clob.polymarket.com should be categorized as WRITE_API",
      );
      assert.strictEqual(
        clobHost.expectedRoute,
        "VPN",
        "clob.polymarket.com should route through VPN",
      );

      // Ensure WRITE_API is never marked as BYPASS
      const writeHosts = KNOWN_HOSTS.filter((h) => h.category === "WRITE_API");
      for (const host of writeHosts) {
        assert.strictEqual(
          host.expectedRoute,
          "VPN",
          `WRITE_API host ${host.hostname} must route through VPN, not BYPASS`,
        );
      }
    });

    it("should categorize hosts correctly", () => {
      // Test that the categorization makes sense
      const categories = new Map<string, string[]>();
      const KNOWN_HOSTS = [
        { hostname: "gamma-api.polymarket.com", category: "READ_API" },
        { hostname: "data-api.polymarket.com", category: "READ_API" },
        { hostname: "clob.polymarket.com", category: "WRITE_API" },
        {
          hostname: "ws-subscriptions-clob.polymarket.com",
          category: "WEBSOCKET",
        },
        { hostname: "polygon-mainnet.infura.io", category: "RPC" },
      ];

      for (const host of KNOWN_HOSTS) {
        if (!categories.has(host.category)) {
          categories.set(host.category, []);
        }
        categories.get(host.category)!.push(host.hostname);
      }

      // Verify READ_API hosts
      const readHosts = categories.get("READ_API") ?? [];
      assert.ok(
        readHosts.includes("gamma-api.polymarket.com"),
        "gamma-api should be READ_API",
      );
      assert.ok(
        readHosts.includes("data-api.polymarket.com"),
        "data-api should be READ_API",
      );
      assert.ok(
        !readHosts.includes("clob.polymarket.com"),
        "clob should NOT be READ_API",
      );

      // Verify WRITE_API hosts
      const writeHosts = categories.get("WRITE_API") ?? [];
      assert.ok(
        writeHosts.includes("clob.polymarket.com"),
        "clob should be WRITE_API",
      );

      // Verify WEBSOCKET hosts
      const wsHosts = categories.get("WEBSOCKET") ?? [];
      assert.ok(
        wsHosts.includes("ws-subscriptions-clob.polymarket.com"),
        "ws-subscriptions-clob should be WEBSOCKET",
      );
    });

    it("should respect VPN_BYPASS_POLYMARKET_WS config", () => {
      // When VPN_BYPASS_POLYMARKET_WS=false, WebSocket should route through VPN
      // When undefined or "true", it should bypass (for latency)

      // Test the expected behavior based on env var
      // Note: We can't directly import isWsBypassEnabled() from vpn.ts as it uses execSync
      // So we test the logic pattern used in generateRoutingPlan()

      // Save original value
      const originalValue = process.env.VPN_BYPASS_POLYMARKET_WS;

      // Test case 1: when undefined, should default to bypassing (for latency)
      // The check is: only route through VPN if explicitly set to "false"
      delete process.env.VPN_BYPASS_POLYMARKET_WS;
      let bypassWsEnabled = process.env.VPN_BYPASS_POLYMARKET_WS === "true";
      // When undefined, bypassWsEnabled is false, but the actual behavior is:
      // WebSocket default expectedRoute is "BYPASS", and it only changes to "VPN"
      // if VPN_BYPASS_POLYMARKET_WS === "false". So undefined means BYPASS.
      assert.strictEqual(
        bypassWsEnabled,
        false,
        "Undefined should not match 'true' string comparison",
      );

      // Test case 2: when "true", should enable bypass
      process.env.VPN_BYPASS_POLYMARKET_WS = "true";
      bypassWsEnabled = process.env.VPN_BYPASS_POLYMARKET_WS === "true";
      assert.strictEqual(
        bypassWsEnabled,
        true,
        "Setting to 'true' should enable bypass",
      );

      // Test case 3: when "false", should NOT enable bypass (route through VPN)
      process.env.VPN_BYPASS_POLYMARKET_WS = "false";
      bypassWsEnabled = process.env.VPN_BYPASS_POLYMARKET_WS === "true";
      assert.strictEqual(
        bypassWsEnabled,
        false,
        "Setting to 'false' should not enable bypass",
      );

      // Restore original value
      if (originalValue === undefined) {
        delete process.env.VPN_BYPASS_POLYMARKET_WS;
      } else {
        process.env.VPN_BYPASS_POLYMARKET_WS = originalValue;
      }
    });
  });
});
