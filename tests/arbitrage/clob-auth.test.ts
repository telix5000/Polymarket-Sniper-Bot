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
        minOrderUsd: 0,
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
        minOrderUsd: 0,
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
        minOrderUsd: 0,
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
        minOrderUsd: 0,
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

test("postOrder returns skipped with NO_LIQUIDITY_AT_PRICE when orderbook bids drop below limit during execution", async () => {
  const previousLiveTrading = process.env.ARB_LIVE_TRADING;
  process.env.ARB_LIVE_TRADING = "I_UNDERSTAND_THE_RISKS";

  // First call: orderbook with bids at 50¢ (passes price protection)
  // Second call (in while loop): bids drop to 40¢ (below limit price)
  // This simulates market movement between orderbook fetches
  let orderbookCallCount = 0;
  const getOrderBook = async () => {
    orderbookCallCount++;
    if (orderbookCallCount === 1) {
      // First call: Good bids at 50¢
      return {
        asks: [{ price: "0.60", size: "100" }],
        bids: [{ price: "0.50", size: "100" }],
      };
    } else {
      // Second call (in while loop): Bids dropped to 40¢
      return {
        asks: [{ price: "0.60", size: "100" }],
        bids: [
          { price: "0.40", size: "50" }, // Below limit
          { price: "0.35", size: "100" }, // Below limit
        ],
      };
    }
  };

  const client = {
    getOrderBook,
    getBalanceAllowance: async () => ({ balance: "100", allowance: "100" }),
    createMarketOrder: async () => ({ signed: true }),
    postOrder: async () => {
      throw new Error(
        "postOrder should not be called when no liquidity at price",
      );
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
      tokenId: "token-changing-bids",
      outcome: "YES",
      side: "SELL",
      sizeUsd: 10,
      // Use sellSlippagePct instead of explicit minAcceptablePrice
      // This computes minAcceptablePrice = bestBid * (1 - 5/100) = 0.50 * 0.95 = 0.475
      sellSlippagePct: 5,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      orderConfig: {
        minOrderUsd: 5,
        orderSubmitMinIntervalMs: 0,
        orderSubmitMaxPerHour: 1000,
        orderSubmitMarketCooldownSeconds: 0,
        cloudflareCooldownSeconds: 0,
      },
    });

    // Should return skipped with NO_LIQUIDITY_AT_PRICE because:
    // - Price protection passed (first orderbook had bestBid=0.50 >= minAcceptable=0.475)
    // - But in while loop, second orderbook has bids at 0.40, all below minAcceptable=0.475
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "NO_LIQUIDITY_AT_PRICE");
  } finally {
    process.env.ARB_LIVE_TRADING = previousLiveTrading;
  }
});
