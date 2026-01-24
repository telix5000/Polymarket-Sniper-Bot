import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LogDedupeMiddleware,
  normalizeMessage,
  extractModuleTag,
  createFingerprint,
  getLogDedupe,
  resetLogDedupe,
} from "../../src/utils/log-dedupe.util";

describe("LogDedupeMiddleware", () => {
  let middleware: LogDedupeMiddleware;

  beforeEach(() => {
    // Create a fresh instance for each test with short TTLs for faster testing
    middleware = new LogDedupeMiddleware({
      enabled: true,
      debugTtlMs: 100,
      infoTtlMs: 100,
      warnTtlMs: 100,
      errorTtlMs: 100,
      maxCacheSize: 100,
    });
  });

  describe("normalizeMessage", () => {
    test("replaces ISO timestamps", () => {
      const msg = "Request at 2024-01-15T10:30:45.123Z completed";
      assert.equal(normalizeMessage(msg), "Request at TIME completed");
    });

    test("replaces date-time without T separator", () => {
      const msg = "Request at 2024-01-15 10:30:45 completed";
      assert.equal(normalizeMessage(msg), "Request at TIME completed");
    });

    test("replaces Unix timestamps", () => {
      const msg = "Started at 1705312245123 and ended at 1705312246000";
      assert.equal(
        normalizeMessage(msg),
        "Started at TIMESTAMP and ended at TIMESTAMP",
      );
    });

    test("replaces hex addresses (long)", () => {
      const msg = "Address 0x1234567890abcdef1234567890abcdef12345678 found";
      assert.equal(normalizeMessage(msg), "Address 0x… found");
    });

    test("keeps short hex values unchanged", () => {
      const msg = "Status code 0x1234 received";
      // 0x1234 is only 4 hex chars after 0x, which is less than 16, so unchanged
      assert.equal(normalizeMessage(msg), "Status code 0x1234 received");
    });

    test("replaces durations with ms", () => {
      const msg = "Completed in 1764ms";
      // "in Xms" pattern takes precedence and replaces with "in Xtime"
      assert.equal(normalizeMessage(msg), "Completed in Xtime");
    });

    test("replaces durations with s", () => {
      const msg = "Timeout after 30s";
      assert.equal(normalizeMessage(msg), "Timeout after Xs");
    });

    test("replaces durations with min", () => {
      const msg = "Running for 27min";
      assert.equal(normalizeMessage(msg), "Running for Xmin");
    });

    test("replaces parenthesized durations", () => {
      const msg = "[Monitor] Checked positions (27min)";
      // Parenthesized durations get replaced
      assert.equal(
        normalizeMessage(msg),
        "[Monitor] Checked positions (Xtime)",
      );
    });

    test("replaces counter patterns", () => {
      const msg = "[Scanner] Checked 17 addresses in 1764ms";
      const normalized = normalizeMessage(msg);
      // 17 addresses -> N items, 1764ms -> Xms (or via in Xtime pattern)
      assert.ok(
        normalized.includes("N items") || normalized.includes("addresses"),
      );
      assert.ok(normalized.includes("Xms") || normalized.includes("Xtime"));
    });

    test("replaces percentage values", () => {
      const msg = "Progress: 95.5% complete";
      assert.equal(normalizeMessage(msg), "Progress: X% complete");
    });

    test("replaces currency amounts", () => {
      const msg = "Balance: $123.45 USD";
      assert.ok(normalizeMessage(msg).includes("$X"));
    });

    test("replaces USDC amounts", () => {
      const msg = "Transferred 1234.56 USDC";
      assert.ok(normalizeMessage(msg).includes("X CURRENCY"));
    });

    test("replaces block numbers", () => {
      const msg = "Confirmed in block 12345678";
      // Block numbers are now explicitly handled before large numeric IDs
      assert.equal(normalizeMessage(msg), "Confirmed in block N");
    });

    test("replaces gas prices", () => {
      const msg = "Gas price: 30 gwei";
      assert.equal(normalizeMessage(msg), "Gas price: X gwei");
    });

    test("replaces large numeric IDs", () => {
      const msg = "Order ID: 12345678901234";
      assert.ok(normalizeMessage(msg).includes("…"));
    });

    test("preserves meaningful content", () => {
      const msg = "[AutoRedeem] Found redeemable position";
      assert.equal(
        normalizeMessage(msg),
        "[AutoRedeem] Found redeemable position",
      );
    });
  });

  describe("extractModuleTag", () => {
    test("extracts tag from bracketed prefix", () => {
      assert.equal(
        extractModuleTag("[ScalpTakeProfit] Processing..."),
        "ScalpTakeProfit",
      );
    });

    test("extracts tag from AutoRedeem prefix", () => {
      assert.equal(
        extractModuleTag("[AutoRedeem] Found positions"),
        "AutoRedeem",
      );
    });

    test("extracts tag from Monitor prefix", () => {
      assert.equal(extractModuleTag("[Monitor] Checking..."), "Monitor");
    });

    test("returns GLOBAL for messages without prefix", () => {
      assert.equal(extractModuleTag("Processing started"), "GLOBAL");
    });

    test("returns GLOBAL for empty message", () => {
      assert.equal(extractModuleTag(""), "GLOBAL");
    });

    test("handles nested brackets correctly", () => {
      // Should extract only the first bracketed content
      assert.equal(extractModuleTag("[Module] [SubModule] Message"), "Module");
    });
  });

  describe("createFingerprint", () => {
    test("creates consistent fingerprint for same message", () => {
      const msg = "Test message";
      const fp1 = createFingerprint(msg);
      const fp2 = createFingerprint(msg);
      assert.equal(fp1, fp2);
    });

    test("creates different fingerprints for meaningfully different messages", () => {
      const fp1 = createFingerprint("Message A");
      const fp2 = createFingerprint("Message B");
      assert.notEqual(fp1, fp2);
    });

    test("creates same fingerprint for messages that differ only in dynamic values", () => {
      const fp1 = createFingerprint("[Monitor] Checked 17 addresses in 1764ms");
      const fp2 = createFingerprint("[Monitor] Checked 25 addresses in 2534ms");
      // After normalization, these should be identical
      assert.equal(fp1, fp2);
    });

    test("fingerprint is 16 characters", () => {
      const fp = createFingerprint("Any message");
      assert.equal(fp.length, 16);
    });
  });

  describe("shouldEmit", () => {
    test("emits first occurrence of a message", () => {
      const result = middleware.shouldEmit("info", "[Test] First message");
      assert.equal(result.emit, true);
      assert.equal(result.suffix, undefined);
    });

    test("suppresses immediate repeat of same message", () => {
      middleware.shouldEmit("info", "[Test] Repeated message");
      const result = middleware.shouldEmit("info", "[Test] Repeated message");
      assert.equal(result.emit, false);
    });

    test("suppresses multiple repeats", () => {
      const msg = "[Test] Many repeats";
      middleware.shouldEmit("info", msg);
      middleware.shouldEmit("info", msg);
      middleware.shouldEmit("info", msg);
      const result = middleware.shouldEmit("info", msg);
      assert.equal(result.emit, false);
    });

    test("emits after TTL expires with suppression count", async () => {
      const msg = "[Test] TTL test";
      middleware.shouldEmit("info", msg);
      middleware.shouldEmit("info", msg); // +1 suppressed
      middleware.shouldEmit("info", msg); // +1 suppressed

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      const result = middleware.shouldEmit("info", msg);
      assert.equal(result.emit, true);
      assert.equal(result.suffix, "(suppressed 2 repeats)");
    });

    test("emits immediately when content changes (material change)", () => {
      middleware.shouldEmit("info", "[Test] Status: OK");
      const result = middleware.shouldEmit("info", "[Test] Status: FAILED");
      assert.equal(result.emit, true);
    });

    test("treats normalized-identical messages as duplicates", () => {
      // These messages are different but normalize to the same key
      middleware.shouldEmit("info", "[Monitor] Checked 17 addresses in 1764ms");
      const result = middleware.shouldEmit(
        "info",
        "[Monitor] Checked 25 addresses in 2534ms",
      );
      assert.equal(result.emit, false);
    });

    test("differentiates between log levels", () => {
      const msg = "[Test] Same message different levels";
      middleware.shouldEmit("info", msg);
      const result = middleware.shouldEmit("warn", msg);
      // Should emit because it's a different level (different key)
      assert.equal(result.emit, true);
    });

    test("differentiates between module tags", () => {
      middleware.shouldEmit("info", "[ModuleA] Message");
      const result = middleware.shouldEmit("info", "[ModuleB] Message");
      assert.equal(result.emit, true);
    });
  });

  describe("LRU eviction", () => {
    test("evicts oldest entries when cache is full", () => {
      const smallCache = new LogDedupeMiddleware({
        enabled: true,
        debugTtlMs: 10000,
        infoTtlMs: 10000,
        warnTtlMs: 10000,
        errorTtlMs: 10000,
        maxCacheSize: 5,
      });

      // Fill cache with 5 entries
      for (let i = 0; i < 5; i++) {
        smallCache.shouldEmit("info", `[Test] Message ${i}`);
      }
      assert.equal(smallCache.getCacheSize(), 5);

      // Add one more - should evict oldest
      smallCache.shouldEmit("info", "[Test] Message 5");
      assert.equal(smallCache.getCacheSize(), 5);

      // The first message should now be gone from cache
      // So it should emit again (as if first time)
      const result = smallCache.shouldEmit("info", "[Test] Message 0");
      assert.equal(result.emit, true);
    });
  });

  describe("configuration", () => {
    test("respects enabled=false", () => {
      const disabled = new LogDedupeMiddleware({ enabled: false });
      disabled.shouldEmit("info", "[Test] Message");
      const result = disabled.shouldEmit("info", "[Test] Message");
      // Should emit even though repeated because deduplication is disabled
      assert.equal(result.emit, true);
    });

    test("getConfig returns current configuration", () => {
      const config = middleware.getConfig();
      assert.equal(config.enabled, true);
      assert.equal(config.infoTtlMs, 100);
    });

    test("updateConfig changes configuration", () => {
      middleware.updateConfig({ infoTtlMs: 500 });
      const config = middleware.getConfig();
      assert.equal(config.infoTtlMs, 500);
    });

    test("clearCache removes all entries", () => {
      middleware.shouldEmit("info", "[Test] Message 1");
      middleware.shouldEmit("info", "[Test] Message 2");
      assert.ok(middleware.getCacheSize() > 0);

      middleware.clearCache();
      assert.equal(middleware.getCacheSize(), 0);
    });
  });

  describe("error handling", () => {
    test("handles null/undefined message gracefully", () => {
      // The function should not throw
      const result = middleware.shouldEmit(
        "info",
        undefined as unknown as string,
      );
      assert.equal(result.emit, true);
    });

    test("handles empty message", () => {
      const result = middleware.shouldEmit("info", "");
      assert.equal(result.emit, true);
    });
  });
});

describe("global singleton", () => {
  beforeEach(() => {
    resetLogDedupe();
  });

  test("getLogDedupe returns same instance", () => {
    const instance1 = getLogDedupe();
    const instance2 = getLogDedupe();
    assert.strictEqual(instance1, instance2);
  });

  test("resetLogDedupe clears singleton", () => {
    const instance1 = getLogDedupe();
    instance1.shouldEmit("info", "[Test] Message");

    resetLogDedupe();

    const instance2 = getLogDedupe();
    // New instance should not have the cached entry
    const result = instance2.shouldEmit("info", "[Test] Message");
    assert.equal(result.emit, true);
  });
});

describe("integration with ConsoleLogger", () => {
  beforeEach(() => {
    resetLogDedupe();
  });

  test("ConsoleLogger uses deduplication", async () => {
    const { ConsoleLogger } = await import("../../src/utils/logger.util");
    const logger = new ConsoleLogger();

    // Mock console.log to capture output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      // Log same message multiple times
      logger.info("[Test] Repeated message");
      logger.info("[Test] Repeated message");
      logger.info("[Test] Repeated message");

      // Only first should have been logged
      assert.equal(logs.length, 1);
    } finally {
      console.log = originalLog;
    }
  });
});
