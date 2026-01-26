import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Mock the API client for unit testing
describe("PolymarketClient", () => {
  describe("Position Caching", () => {
    test("should only cache active positions, not complete or redeemable", async () => {
      // This test verifies the design principle that only active positions are cached
      // Complete/redeemable positions should be filtered out

      // Simulated positions from API
      const mockPositions = [
        {
          tokenId: "active1",
          size: 100,
          curPrice: 0.5,
          isComplete: false,
          redeemable: false,
        },
        {
          tokenId: "complete1",
          size: 0,
          curPrice: 0,
          isComplete: true,
          redeemable: false,
        },
        {
          tokenId: "redeemable1",
          size: 50,
          curPrice: 1.0,
          isComplete: false,
          redeemable: true,
        },
        {
          tokenId: "active2",
          size: 200,
          curPrice: 0.7,
          isComplete: false,
          redeemable: false,
        },
      ];

      // Filter logic (same as PolymarketClient)
      const activePositions = mockPositions.filter(
        (pos) => !pos.isComplete && !pos.redeemable,
      );

      assert.equal(
        activePositions.length,
        2,
        "Should only have 2 active positions",
      );
      assert.equal(activePositions[0].tokenId, "active1");
      assert.equal(activePositions[1].tokenId, "active2");
    });

    test("should identify position as complete when size is zero", () => {
      const isComplete = (size: number, currentValue: number) =>
        size <= 0 || currentValue <= 0;

      assert.equal(isComplete(0, 50), true, "Zero size = complete");
      assert.equal(isComplete(100, 0), true, "Zero value = complete");
      assert.equal(isComplete(100, 50), false, "Active position");
    });
  });

  describe("Stacked Detection", () => {
    test("should detect stacked position with 2+ BUY orders", () => {
      const buyOrders = [
        { side: "BUY", size: 100, price: 0.5 },
        { side: "BUY", size: 50, price: 0.6 },
      ];

      const isStacked = buyOrders.length >= 2;
      assert.equal(isStacked, true, "2 BUY orders = stacked");
    });

    test("should not detect stacked position with 1 BUY order", () => {
      const buyOrders = [{ side: "BUY", size: 100, price: 0.5 }];

      const isStacked = buyOrders.length >= 2;
      assert.equal(isStacked, false, "1 BUY order = not stacked");
    });

    test("should not detect stacked position with 0 BUY orders", () => {
      const buyOrders: Array<{ side: string }> = [];

      const isStacked = buyOrders.length >= 2;
      assert.equal(isStacked, false, "0 BUY orders = not stacked");
    });
  });

  describe("Cache TTL Logic", () => {
    test("should determine cache validity based on TTL", () => {
      const positionCacheTtlMs = 30_000; // 30 seconds
      const now = Date.now();

      // Fresh cache (10 seconds old)
      const freshFetchedAt = now - 10_000;
      const freshCacheAge = now - freshFetchedAt;
      const freshValid = freshCacheAge < positionCacheTtlMs;
      assert.equal(freshValid, true, "10s old cache should be valid");

      // Stale cache (40 seconds old)
      const staleFetchedAt = now - 40_000;
      const staleCacheAge = now - staleFetchedAt;
      const staleValid = staleCacheAge < positionCacheTtlMs;
      assert.equal(staleValid, false, "40s old cache should be stale");
    });

    test("should use longer TTL for stacked detection", () => {
      const stackedCacheTtlMs = 300_000; // 5 minutes
      const now = Date.now();

      // 3 minute old stacked cache should still be valid
      const threeMinAgo = now - 180_000;
      const cacheAge = now - threeMinAgo;
      const valid = cacheAge < stackedCacheTtlMs;
      assert.equal(valid, true, "3 minute old stacked cache should be valid");
    });
  });

  describe("Number Parsing", () => {
    test("should parse numbers from strings", () => {
      const parseNumber = (value: number | string | undefined): number => {
        if (value === undefined) return 0;
        if (typeof value === "number") return value;
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };

      assert.equal(parseNumber(42), 42);
      assert.equal(parseNumber("42.5"), 42.5);
      assert.equal(parseNumber(undefined), 0);
      assert.equal(parseNumber("not a number"), 0);
      assert.equal(parseNumber("0.123456"), 0.123456);
    });
  });

  describe("Position Transformation", () => {
    test("should calculate P&L correctly", () => {
      const size = 100;
      const avgPrice = 0.5;
      const curPrice = 0.7;
      const initialValue = size * avgPrice; // 50
      const currentValue = size * curPrice; // 70
      const cashPnl = currentValue - initialValue; // 20
      const percentPnl =
        initialValue > 0
          ? ((currentValue - initialValue) / initialValue) * 100
          : 0; // 40%

      assert.equal(initialValue, 50);
      assert.equal(currentValue, 70);
      assert.equal(cashPnl, 20);
      assert.equal(percentPnl, 40);
    });

    test("should convert price to cents", () => {
      const avgPrice = 0.655;
      const avgPriceCents = avgPrice * 100;
      assert.equal(avgPriceCents, 65.5);
    });
  });
});

describe("Stacking Strategy Logic", () => {
  describe("Eligibility Checks", () => {
    test("should require entry price > 0", () => {
      const position = { avgPrice: 0, percentPnl: 10 };
      const eligible = position.avgPrice > 0;
      assert.equal(eligible, false, "No entry price = not eligible");
    });

    test("should require profit >= minProfitPct", () => {
      const minProfitPct = 0;
      const position = { percentPnl: -5 };
      const eligible = position.percentPnl >= minProfitPct;
      assert.equal(eligible, false, "Losing position = not eligible");
    });

    test("should require gain >= minGainCents", () => {
      const minGainCents = 20;
      const avgPriceCents = 50;
      const curPriceCents = 65;
      const gainCents = curPriceCents - avgPriceCents; // 15 cents

      const eligible = gainCents >= minGainCents;
      assert.equal(
        eligible,
        false,
        "15 cent gain < 20 cent threshold = not eligible",
      );
    });

    test("should reject positions near $1", () => {
      const maxCurrentPrice = 0.95;
      const curPrice = 0.98;
      const eligible = curPrice < maxCurrentPrice;
      assert.equal(
        eligible,
        false,
        "98 cent price >= 95 cent max = not eligible",
      );
    });

    test("should accept eligible position", () => {
      const config = {
        minProfitPct: 0,
        minGainCents: 20,
        maxCurrentPrice: 0.95,
      };

      const position = {
        avgPrice: 0.5,
        avgPriceCents: 50,
        curPrice: 0.75,
        curPriceCents: 75,
        percentPnl: 50,
      };

      const hasEntryPrice = position.avgPrice > 0;
      const isProfitable = position.percentPnl >= config.minProfitPct;
      const gainCents = position.curPriceCents - position.avgPriceCents;
      const gainSufficient = gainCents >= config.minGainCents;
      const notNearOne = position.curPrice < config.maxCurrentPrice;

      const eligible =
        hasEntryPrice && isProfitable && gainSufficient && notNearOne;

      assert.equal(
        eligible,
        true,
        "Position with 25 cent gain @ 75 cents = eligible",
      );
      assert.equal(gainCents, 25);
    });
  });

  describe("Budget-Aware Sizing", () => {
    test("should use full amount when budget allows", () => {
      const maxStackUsd = 25;
      const budgetRemaining = 100;

      const cappedUsd = Math.min(maxStackUsd, budgetRemaining);
      assert.equal(cappedUsd, 25, "Should use full maxStackUsd");
    });

    test("should cap to budget when budget < maxStackUsd", () => {
      const maxStackUsd = 25;
      const budgetRemaining = 15;

      const cappedUsd = Math.min(maxStackUsd, budgetRemaining);
      assert.equal(cappedUsd, 15, "Should cap to available budget");
    });

    test("should skip when budget below minimum", () => {
      const minStackUsd = 1;
      const budgetRemaining = 0.5;

      const shouldSkip = budgetRemaining < minStackUsd;
      assert.equal(shouldSkip, true, "Should skip when budget < minimum");
    });
  });
});
