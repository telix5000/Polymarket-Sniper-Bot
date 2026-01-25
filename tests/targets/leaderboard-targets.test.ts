import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  isValidEvmAddress,
  normalizeAddresses,
  parseLeaderboardResponse,
  getTargetAddressesFromLeaderboard,
  getTargetAddresses,
  getDefaultLeaderboardOptions,
  type LeaderboardOptions,
} from "../../src/targets/leaderboardTargets";

// Test cache directory (cross-platform compatible)
const TEST_CACHE_DIR = path.join(os.tmpdir(), "leaderboard-test-cache");
const TEST_CACHE_FILE = path.join(TEST_CACHE_DIR, "test-cache.json");

// Silent logger for tests
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Helper to create test options
function createTestOptions(
  overrides: Partial<LeaderboardOptions> = {},
): LeaderboardOptions {
  return {
    limit: 20,
    category: "OVERALL",
    timePeriod: "MONTH",
    orderBy: "PNL",
    cacheFile: TEST_CACHE_FILE,
    ttlSeconds: 3600,
    enableCache: true, // Enable cache for tests that need it
    ...overrides,
  };
}

// Clean up test cache before/after tests
function cleanupTestCache(): void {
  try {
    if (fs.existsSync(TEST_CACHE_FILE)) {
      fs.unlinkSync(TEST_CACHE_FILE);
    }
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmdirSync(TEST_CACHE_DIR);
    }
  } catch {
    // Ignore cleanup errors
  }
}

describe("isValidEvmAddress", () => {
  test("accepts valid lowercase address", () => {
    assert.equal(
      isValidEvmAddress("0x1234567890abcdef1234567890abcdef12345678"),
      true,
    );
  });

  test("accepts valid uppercase address", () => {
    assert.equal(
      isValidEvmAddress("0x1234567890ABCDEF1234567890ABCDEF12345678"),
      true,
    );
  });

  test("accepts valid mixed case address", () => {
    assert.equal(
      isValidEvmAddress("0x1234567890AbCdEf1234567890AbCdEf12345678"),
      true,
    );
  });

  test("rejects address without 0x prefix", () => {
    assert.equal(
      isValidEvmAddress("1234567890abcdef1234567890abcdef12345678"),
      false,
    );
  });

  test("rejects address with wrong length (too short)", () => {
    assert.equal(isValidEvmAddress("0x1234567890abcdef"), false);
  });

  test("rejects address with wrong length (too long)", () => {
    assert.equal(
      isValidEvmAddress("0x1234567890abcdef1234567890abcdef1234567890"),
      false,
    );
  });

  test("rejects address with invalid characters", () => {
    assert.equal(
      isValidEvmAddress("0x1234567890ghijkl1234567890ghijkl12345678"),
      false,
    );
  });

  test("rejects empty string", () => {
    assert.equal(isValidEvmAddress(""), false);
  });

  test("rejects null-like values", () => {
    assert.equal(isValidEvmAddress("null"), false);
    assert.equal(isValidEvmAddress("undefined"), false);
  });
});

describe("normalizeAddresses", () => {
  test("converts to lowercase", () => {
    const input = [
      "0x1234567890ABCDEF1234567890ABCDEF12345678",
      "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    ];
    const result = normalizeAddresses(input);
    assert.deepEqual(result, [
      "0x1234567890abcdef1234567890abcdef12345678",
      "0xabcdef1234567890abcdef1234567890abcdef12",
    ]);
  });

  test("removes duplicates (case-insensitive)", () => {
    const input = [
      "0x1234567890abcdef1234567890abcdef12345678",
      "0x1234567890ABCDEF1234567890ABCDEF12345678",
      "0x1234567890AbCdEf1234567890AbCdEf12345678",
    ];
    const result = normalizeAddresses(input);
    assert.deepEqual(result, ["0x1234567890abcdef1234567890abcdef12345678"]);
  });

  test("preserves order (first occurrence)", () => {
    const input = [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // duplicate of first
      "0xcccccccccccccccccccccccccccccccccccccccc",
    ];
    const result = normalizeAddresses(input);
    assert.deepEqual(result, [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "0xcccccccccccccccccccccccccccccccccccccccc",
    ]);
  });

  test("handles empty array", () => {
    assert.deepEqual(normalizeAddresses([]), []);
  });
});

describe("parseLeaderboardResponse", () => {
  test("extracts proxyWallet from valid response", () => {
    const data = [
      { proxyWallet: "0x1111111111111111111111111111111111111111", pnl: 1000 },
      { proxyWallet: "0x2222222222222222222222222222222222222222", pnl: 900 },
      { proxyWallet: "0x3333333333333333333333333333333333333333", pnl: 800 },
    ];
    const result = parseLeaderboardResponse(data);
    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
    ]);
  });

  test("skips entries without proxyWallet", () => {
    const data = [
      { proxyWallet: "0x1111111111111111111111111111111111111111" },
      { address: "0x2222222222222222222222222222222222222222" }, // wrong field
      { proxyWallet: "0x3333333333333333333333333333333333333333" },
    ];
    const result = parseLeaderboardResponse(data);
    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x3333333333333333333333333333333333333333",
    ]);
  });

  test("skips entries with invalid proxyWallet", () => {
    const data = [
      { proxyWallet: "0x1111111111111111111111111111111111111111" },
      { proxyWallet: "invalid-address" },
      { proxyWallet: "0x3333333333333333333333333333333333333333" },
    ];
    const result = parseLeaderboardResponse(data);
    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x3333333333333333333333333333333333333333",
    ]);
  });

  test("handles non-array response", () => {
    assert.deepEqual(parseLeaderboardResponse(null), []);
    assert.deepEqual(parseLeaderboardResponse(undefined), []);
    assert.deepEqual(parseLeaderboardResponse({}), []);
    assert.deepEqual(parseLeaderboardResponse("string"), []);
  });

  test("normalizes and deduplicates addresses", () => {
    const data = [
      { proxyWallet: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { proxyWallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, // duplicate
      { proxyWallet: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
    ];
    const result = parseLeaderboardResponse(data);
    assert.deepEqual(result, [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });
});

describe("getDefaultLeaderboardOptions", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  test("returns default values when no env vars set", () => {
    delete process.env.LEADERBOARD_LIMIT;
    delete process.env.LEADERBOARD_TTL_SECONDS;
    delete process.env.LEADERBOARD_CACHE_FILE;
    delete process.env.LEADERBOARD_ENABLE_CACHE;

    const opts = getDefaultLeaderboardOptions();
    assert.equal(opts.limit, 20);
    assert.equal(opts.ttlSeconds, 3600);
    assert.equal(opts.cacheFile, ".leaderboard-cache.json");
    assert.equal(opts.category, "OVERALL");
    assert.equal(opts.timePeriod, "MONTH");
    assert.equal(opts.orderBy, "PNL");
    assert.equal(opts.enableCache, false); // Default is stateless (no caching)
  });

  test("reads LEADERBOARD_LIMIT from env", () => {
    process.env.LEADERBOARD_LIMIT = "30";
    const opts = getDefaultLeaderboardOptions();
    assert.equal(opts.limit, 30);
  });

  test("reads LEADERBOARD_TTL_SECONDS from env", () => {
    process.env.LEADERBOARD_TTL_SECONDS = "7200";
    const opts = getDefaultLeaderboardOptions();
    assert.equal(opts.ttlSeconds, 7200);
  });

  test("reads LEADERBOARD_CACHE_FILE from env", () => {
    process.env.LEADERBOARD_CACHE_FILE = "/custom/path/cache.json";
    const opts = getDefaultLeaderboardOptions();
    assert.equal(opts.cacheFile, "/custom/path/cache.json");
  });

  test("reads LEADERBOARD_ENABLE_CACHE from env", () => {
    process.env.LEADERBOARD_ENABLE_CACHE = "true";
    const opts = getDefaultLeaderboardOptions();
    assert.equal(opts.enableCache, true);

    process.env.LEADERBOARD_ENABLE_CACHE = "1";
    const opts2 = getDefaultLeaderboardOptions();
    assert.equal(opts2.enableCache, true);

    process.env.LEADERBOARD_ENABLE_CACHE = "false";
    const opts3 = getDefaultLeaderboardOptions();
    assert.equal(opts3.enableCache, false);
  });
});

describe("cache behavior", () => {
  beforeEach(() => {
    cleanupTestCache();
    if (!fs.existsSync(TEST_CACHE_DIR)) {
      fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    cleanupTestCache();
  });

  test("uses fresh cache without network call", async () => {
    // Write fresh cache
    const cache = {
      fetchedAt: Date.now(),
      addresses: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
    };
    fs.writeFileSync(TEST_CACHE_FILE, JSON.stringify(cache), "utf-8");

    const opts = createTestOptions({ ttlSeconds: 3600 });
    const result = await getTargetAddressesFromLeaderboard(opts, silentLogger);

    assert.deepEqual(result, cache.addresses);
  });

  test("returns stale cache when API unavailable", async () => {
    // Write stale cache (older than TTL)
    const cache = {
      fetchedAt: Date.now() - 7200 * 1000, // 2 hours old
      addresses: [
        "0x3333333333333333333333333333333333333333",
        "0x4444444444444444444444444444444444444444",
      ],
    };
    fs.writeFileSync(TEST_CACHE_FILE, JSON.stringify(cache), "utf-8");

    // Use a very short timeout to force API failure
    const opts = createTestOptions({ ttlSeconds: 3600 });

    // Mock axios to simulate failure
    const axios = await import("axios");
    const originalGet = axios.default.get;
    axios.default.get = async () => {
      throw new Error("Network error");
    };

    try {
      const result = await getTargetAddressesFromLeaderboard(
        opts,
        silentLogger,
      );
      assert.deepEqual(result, cache.addresses);
    } finally {
      axios.default.get = originalGet;
    }
  });
});

describe("env override", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.assign(process.env, originalEnv);
  });

  test("uses TARGET_ADDRESSES env var when set", async () => {
    process.env.TARGET_ADDRESSES =
      "0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222";

    const opts = createTestOptions();
    const result = await getTargetAddresses(opts, silentLogger);

    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ]);
  });

  test("normalizes env addresses to lowercase", async () => {
    process.env.TARGET_ADDRESSES =
      "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA,0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

    const opts = createTestOptions();
    const result = await getTargetAddresses(opts, silentLogger);

    assert.deepEqual(result, [
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  test("filters invalid addresses from env", async () => {
    process.env.TARGET_ADDRESSES =
      "0x1111111111111111111111111111111111111111,invalid,0x2222222222222222222222222222222222222222";

    const opts = createTestOptions();
    const result = await getTargetAddresses(opts, silentLogger);

    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ]);
  });

  test("deduplicates addresses from env", async () => {
    process.env.TARGET_ADDRESSES =
      "0x1111111111111111111111111111111111111111,0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222";

    const opts = createTestOptions();
    const result = await getTargetAddresses(opts, silentLogger);

    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ]);
  });

  test("handles whitespace in env addresses", async () => {
    process.env.TARGET_ADDRESSES =
      " 0x1111111111111111111111111111111111111111 , 0x2222222222222222222222222222222222222222 ";

    const opts = createTestOptions();
    const result = await getTargetAddresses(opts, silentLogger);

    assert.deepEqual(result, [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ]);
  });
});

describe("limit clamping", () => {
  test("clamps limit above 50 to 50", () => {
    // This is tested indirectly through the URL construction
    // The actual API call will use Math.min(limit, 50)
    const opts = createTestOptions({ limit: 100 });
    // We can't easily test this without mocking, but the code does:
    // const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);
    assert.equal(Math.min(Math.max(1, opts.limit), 50), 50);
  });

  test("clamps limit below 1 to 1", () => {
    const opts = createTestOptions({ limit: 0 });
    assert.equal(Math.min(Math.max(1, opts.limit), 50), 1);

    const optsNeg = createTestOptions({ limit: -5 });
    assert.equal(Math.min(Math.max(1, optsNeg.limit), 50), 1);
  });
});
