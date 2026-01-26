import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { ClobClient } from "@polymarket/clob-client";
import { postOrder } from "../../src/utils/post-order.util";
import {
  initializeApiCreds,
  resetApiCredsCache,
} from "../../src/infrastructure/clob-auth";

const baseOrderBook = {
  asks: [{ price: "1", size: "1" }],
  bids: [{ price: "1", size: "1" }],
};

afterEach(() => {
  resetApiCredsCache();
});

test("postOrder applies cached API creds before placing orders", async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
  const callOrder: string[] = [];
  let appliedCreds:
    | { key: string; secret: string; passphrase: string }
    | undefined;

  const client = {
    getOrderBook: async () => baseOrderBook,
    getBalanceAllowance: async () => ({ balance: "100", allowance: "100" }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      callOrder.push("post");
      return { success: true, order: { id: "order-1" }, status: 200 };
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, "creds", {
    set: (value: { key: string; secret: string; passphrase: string }) => {
      callOrder.push("set");
      appliedCreds = value;
    },
  });

  await initializeApiCreds(client, {
    key: "key",
    secret: "secret",
    passphrase: "pass",
  });

  try {
    await postOrder({
      client,
      tokenId: "token-1",
      outcome: "YES",
      side: "BUY",
      sizeUsd: 1,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }

  assert.ok(callOrder.indexOf("set") !== -1);
  assert.ok(callOrder.indexOf("post") !== -1);
  assert.ok(callOrder.indexOf("set") < callOrder.indexOf("post"));
  assert.deepEqual(appliedCreds, {
    key: "key",
    secret: "secret",
    passphrase: "pass",
  });
});

test("postOrder re-applies API creds and retries once on auth failure", async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";
  let postAttempts = 0;
  const setCalls: string[] = [];

  const client = {
    getOrderBook: async () => baseOrderBook,
    getBalanceAllowance: async () => ({ balance: "100", allowance: "100" }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      postAttempts += 1;
      if (postAttempts === 1) {
        const error = new Error("Unauthorized");
        (error as { response?: { status: number } }).response = { status: 401 };
        throw error;
      }
      return { success: true, order: { id: "order-2" }, status: 200 };
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, "creds", {
    set: () => {
      setCalls.push("set");
    },
  });

  await initializeApiCreds(client, {
    key: "key",
    secret: "secret",
    passphrase: "pass",
  });
  setCalls.length = 0;

  try {
    await postOrder({
      client,
      tokenId: "token-2",
      outcome: "YES",
      side: "BUY",
      sizeUsd: 1,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }

  assert.equal(postAttempts, 2);
  assert.equal(setCalls.length, 2);
});

test("postOrder returns skipped with NO_LIQUIDITY when orderbook has no bids for SELL", async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

  // Orderbook with asks but NO bids - simulates illiquid market for SELL
  const emptyBidsOrderBook = {
    asks: [{ price: "0.50", size: "100" }],
    bids: [], // No bids available
  };

  const client = {
    getOrderBook: async () => emptyBidsOrderBook,
    getBalanceAllowance: async () => ({ balance: "100", allowance: "100" }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      throw new Error("postOrder should not be called when no liquidity");
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, "creds", {
    set: () => {
      // no-op
    },
  });

  await initializeApiCreds(client, {
    key: "key",
    secret: "secret",
    passphrase: "pass",
  });

  try {
    const result = await postOrder({
      client,
      tokenId: "token-no-liquidity",
      outcome: "YES",
      side: "SELL",
      sizeUsd: 10,
      minAcceptablePrice: 0.4,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });

    // Should return skipped result, NOT throw
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "NO_LIQUIDITY");
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }
});

test("postOrder returns skipped with NO_LIQUIDITY when orderbook has no asks for BUY", async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

  // Orderbook with bids but NO asks - simulates illiquid market for BUY
  const emptyAsksOrderBook = {
    asks: [], // No asks available
    bids: [{ price: "0.50", size: "100" }],
  };

  const client = {
    getOrderBook: async () => emptyAsksOrderBook,
    getBalanceAllowance: async () => ({ balance: "100", allowance: "100" }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      throw new Error("postOrder should not be called when no liquidity");
    },
  } as unknown as ClobClient;

  Object.defineProperty(client, "creds", {
    set: () => {
      // no-op
    },
  });

  await initializeApiCreds(client, {
    key: "key",
    secret: "secret",
    passphrase: "pass",
  });

  try {
    const result = await postOrder({
      client,
      tokenId: "token-no-liquidity-buy",
      outcome: "YES",
      side: "BUY",
      sizeUsd: 10,
      maxAcceptablePrice: 0.6,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });

    // Should return skipped result, NOT throw
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "NO_LIQUIDITY");
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }
});

test("postOrder SELL proceeds with top bid even when bids are below computed limit price", async () => {
  // FIX (Jan 2026): SELL orders now use the top bid price directly (like upstream)
  // instead of failing when bids drop below a computed limit price.
  // This test verifies SELL orders proceed rather than returning NO_LIQUIDITY_AT_PRICE.
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

  // First call: orderbook with bids at 50¢ (for price protection validation)
  // Second call (in while loop): bids at 40¢
  // OLD BEHAVIOR: Would skip because 40¢ < minAcceptablePrice (0.475)
  // NEW BEHAVIOR: Uses 40¢ directly, proceeds to execute
  let orderbookCallCount = 0;
  let orderSubmittedAtPrice: string | undefined;
  
  const getOrderBook = async () => {
    orderbookCallCount++;
    if (orderbookCallCount === 1) {
      // First call: Good bids at 50¢
      return {
        asks: [{ price: "0.60", size: "100" }],
        bids: [{ price: "0.50", size: "100" }],
      };
    } else {
      // Second call (in while loop): Bids at 40¢
      return {
        asks: [{ price: "0.60", size: "100" }],
        bids: [
          { price: "0.40", size: "50" },
          { price: "0.35", size: "100" },
        ],
      };
    }
  };

  const client = {
    getOrderBook,
    getBalanceAllowance: async () => ({ balance: "100", allowance: "100" }),
    createMarketOrder: async (args: { side: string; tokenID: string; amount: number; price: number }) => {
      // Capture the price at which order was created
      orderSubmittedAtPrice = String(args.price);
      return { signed: true };
    },
    postOrder: async () => {
      return { success: true, order: { id: "order-1" }, status: 200 };
    },
  } as unknown as ClobClient;

  // Mock the wallet with a proper provider mock for ERC1155 approval check
  const mockProvider = {
    call: async () => {
      // Return true for isApprovedForAll (encoded as 0x01)
      return "0x0000000000000000000000000000000000000000000000000000000000000001";
    },
    getNetwork: async () => ({ chainId: 137n }),
  };
  
  Object.defineProperty(client, "wallet", {
    value: {
      address: "0x1234567890123456789012345678901234567890",
      provider: mockProvider,
    },
    writable: true,
  });

  Object.defineProperty(client, "creds", {
    set: () => {
      // no-op
    },
  });

  await initializeApiCreds(client, {
    key: "key",
    secret: "secret",
    passphrase: "pass",
  });

  try {
    const result = await postOrder({
      client,
      tokenId: "token-changing-bids",
      outcome: "YES",
      side: "SELL",
      sizeUsd: 10,
      // Use sellSlippagePct - this is now just for warning, not blocking
      sellSlippagePct: 5,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });

    // NEW BEHAVIOR: SELL proceeds with top bid (40¢) instead of skipping
    // The order should be submitted successfully
    assert.equal(result.status, "submitted", 
      "SELL order should be submitted successfully");
    assert.notEqual(result.reason, "NO_LIQUIDITY_AT_PRICE", 
      "SELL should not skip with NO_LIQUIDITY_AT_PRICE when bids exist");
    
    // Verify the order was submitted at the top bid price (40¢), not the old limit price
    if (orderSubmittedAtPrice !== undefined) {
      assert.equal(orderSubmittedAtPrice, "0.4", 
        "Order should be submitted at top bid price (40¢)");
    }
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }
});
