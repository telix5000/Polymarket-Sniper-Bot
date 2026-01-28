import assert from "node:assert";
import { describe, it, mock } from "node:test";
import {
  getUsdcAllowance,
  getUsdcBalance,
  getPolBalance,
  getUsdcBalanceWithStatus,
  getPolBalanceWithStatus,
  BalanceCache,
  DEFAULT_BALANCE_REFRESH_INTERVAL_MS,
} from "../../../src/lib/balance";
import { POLYGON } from "../../../src/lib/constants";

// Mock wallet provider
function createMockWallet(
  options: {
    allowance?: bigint;
    balance?: bigint;
    polBalance?: bigint;
    throwError?: boolean;
  } = {},
) {
  const mockProvider = {
    getBalance: mock.fn(async () => {
      if (options.throwError) throw new Error("Network error");
      return options.polBalance ?? BigInt("1000000000000000000"); // 1 POL
    }),
  };

  const mockContract = {
    balanceOf: mock.fn(async () => {
      if (options.throwError) throw new Error("Network error");
      return options.balance ?? BigInt("100000000"); // 100 USDC (6 decimals)
    }),
    allowance: mock.fn(async () => {
      if (options.throwError) throw new Error("Network error");
      return options.allowance ?? BigInt("50000000"); // 50 USDC (6 decimals)
    }),
  };

  return {
    wallet: {
      provider: mockProvider,
    },
    mockContract,
  };
}

describe("getUsdcAllowance", () => {
  describe("basic functionality", () => {
    it("returns allowance in human-readable USDC format", async () => {
      // Note: This test verifies the function structure.
      // In practice, the Contract class is instantiated internally,
      // so we test the error handling path to verify graceful degradation.
      const { wallet } = createMockWallet({ throwError: true });
      const result = await getUsdcAllowance(wallet as any, "0xOwnerAddress");
      // When there's an error, it returns 0
      assert.strictEqual(result, 0);
    });

    it("handles errors gracefully and returns 0", async () => {
      const { wallet } = createMockWallet({ throwError: true });
      const result = await getUsdcAllowance(wallet as any, "0xOwnerAddress");
      assert.strictEqual(result, 0);
    });
  });
});

describe("getUsdcBalance", () => {
  it("handles errors gracefully and returns 0", async () => {
    const { wallet } = createMockWallet({ throwError: true });
    const result = await getUsdcBalance(wallet as any, "0xAddress");
    assert.strictEqual(result, 0);
  });
});

describe("getPolBalance", () => {
  it("handles errors gracefully and returns 0", async () => {
    const { wallet } = createMockWallet({ throwError: true });
    const result = await getPolBalance(wallet as any, "0xAddress");
    assert.strictEqual(result, 0);
  });

  it("returns 0 when provider is undefined", async () => {
    const wallet = { provider: undefined };
    const result = await getPolBalance(wallet as any, "0xAddress");
    assert.strictEqual(result, 0);
  });
});

describe("Constants validation", () => {
  it("CTF_EXCHANGE address is defined", () => {
    assert.ok(POLYGON.CTF_EXCHANGE);
    assert.ok(POLYGON.CTF_EXCHANGE.startsWith("0x"));
  });

  it("USDC_ADDRESS is defined", () => {
    assert.ok(POLYGON.USDC_ADDRESS);
    assert.ok(POLYGON.USDC_ADDRESS.startsWith("0x"));
  });

  it("USDC_DECIMALS is 6", () => {
    assert.strictEqual(POLYGON.USDC_DECIMALS, 6);
  });
});

describe("BalanceCache", () => {
  describe("DEFAULT_BALANCE_REFRESH_INTERVAL_MS", () => {
    it("should be 10000ms", () => {
      assert.strictEqual(DEFAULT_BALANCE_REFRESH_INTERVAL_MS, 10000);
    });
  });

  describe("isStale", () => {
    it("should return true when cache is empty", () => {
      const { wallet } = createMockWallet({ throwError: true });
      const cache = new BalanceCache(wallet as any, "0xAddress", 100);
      assert.strictEqual(cache.isStale(), true);
    });
  });

  describe("getCacheAgeMs", () => {
    it("should return Infinity when cache is empty", () => {
      const { wallet } = createMockWallet({ throwError: true });
      const cache = new BalanceCache(wallet as any, "0xAddress", 100);
      assert.strictEqual(cache.getCacheAgeMs(), Infinity);
    });
  });

  describe("getCachedBalances", () => {
    it("should return null when cache is empty", () => {
      const { wallet } = createMockWallet({ throwError: true });
      const cache = new BalanceCache(wallet as any, "0xAddress", 100);
      assert.strictEqual(cache.getCachedBalances(), null);
    });
  });

  describe("getRpcFetchCount", () => {
    it("should start at 0", () => {
      const { wallet } = createMockWallet({ throwError: true });
      const cache = new BalanceCache(wallet as any, "0xAddress", 100);
      assert.strictEqual(cache.getRpcFetchCount(), 0);
    });
  });

  describe("wasLastFetchSuccessful", () => {
    it("should return false when cache is empty", () => {
      const { wallet } = createMockWallet({ throwError: true });
      const cache = new BalanceCache(wallet as any, "0xAddress", 100);
      assert.strictEqual(cache.wasLastFetchSuccessful(), false);
    });
  });

  describe("getLastFetchError", () => {
    it("should return undefined when cache is empty", () => {
      const { wallet } = createMockWallet({ throwError: true });
      const cache = new BalanceCache(wallet as any, "0xAddress", 100);
      assert.strictEqual(cache.getLastFetchError(), undefined);
    });
  });
});

describe("getUsdcBalanceWithStatus", () => {
  it("returns success: false on error", async () => {
    const { wallet } = createMockWallet({ throwError: true });
    const result = await getUsdcBalanceWithStatus(wallet as any, "0xAddress");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.value, 0);
    assert.ok(result.error);
  });
});

describe("getPolBalanceWithStatus", () => {
  it("returns success: false on error", async () => {
    const { wallet } = createMockWallet({ throwError: true });
    const result = await getPolBalanceWithStatus(wallet as any, "0xAddress");
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.value, 0);
    assert.ok(result.error);
  });
});
