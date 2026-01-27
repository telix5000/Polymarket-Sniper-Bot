import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  analyzeLiquidity,
  calculateOptimalSlippage,
  determineOrderType,
  type OrderBookLevel,
} from "../../src/lib/smart-sell";
import { SELL } from "../../src/lib/constants";
import type { Position } from "../../src/lib/types";

// Helper to create a mock position
function createMockPosition(overrides: Partial<Position> = {}): Position {
  return {
    tokenId: "test-token-id",
    conditionId: "test-condition-id",
    outcome: "YES",
    size: 100,
    avgPrice: 0.5,
    curPrice: 0.55,
    pnlPct: 10,
    pnlUsd: 5,
    gainCents: 5,
    value: 55,
    ...overrides,
  };
}

describe("Smart Sell - Liquidity Analysis", () => {
  describe("analyzeLiquidity", () => {
    it("returns empty analysis for no bids", () => {
      const result = analyzeLiquidity([], 100, 2);

      assert.strictEqual(result.bestBid, 0);
      assert.strictEqual(result.canFill, false);
      assert.strictEqual(result.liquidityAtSlippage, 0);
    });

    it("calculates correct values for single bid level", () => {
      const bids: OrderBookLevel[] = [{ price: 0.5, size: 200 }];

      const result = analyzeLiquidity(bids, 100, 2);

      assert.strictEqual(result.bestBid, 0.5);
      assert.strictEqual(result.canFill, true);
      assert.strictEqual(result.expectedAvgPrice, 0.5);
      assert.strictEqual(result.expectedSlippagePct, 0);
      assert.strictEqual(result.levelsNeeded, 1);
    });

    it("calculates weighted average price across multiple levels", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.5, size: 50 }, // 50 shares at $0.50
        { price: 0.48, size: 50 }, // 50 shares at $0.48
      ];

      const result = analyzeLiquidity(bids, 100, 5);

      assert.strictEqual(result.bestBid, 0.5);
      assert.strictEqual(result.canFill, true);
      // Expected avg: (50*0.5 + 50*0.48) / 100 = 0.49
      assert.strictEqual(result.expectedAvgPrice, 0.49);
      assert.strictEqual(result.levelsNeeded, 2);
    });

    it("respects slippage tolerance when selecting levels", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.5, size: 50 },
        { price: 0.48, size: 50 }, // 4% slippage from best bid
        { price: 0.40, size: 100 }, // 20% slippage - should be excluded
      ];

      const result = analyzeLiquidity(bids, 100, 5); // 5% max slippage

      assert.strictEqual(result.bestBid, 0.5);
      // Should only use first two levels (within 5% slippage)
      assert.strictEqual(result.levelsNeeded, 2);
      // Can't fill full amount within slippage
      assert.strictEqual(result.canFill, true);
    });

    it("reports canFill=false when insufficient liquidity within slippage", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.5, size: 10 }, // Only 10 shares available
      ];

      const result = analyzeLiquidity(bids, 100, 2);

      assert.strictEqual(result.canFill, false); // 10/100 = 10% < MIN_FILL_RATIO (80%)
    });

    it("reports canFill=true when enough liquidity at MIN_FILL_RATIO", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.5, size: 85 }, // 85% of needed amount
      ];

      const result = analyzeLiquidity(bids, 100, 2);

      assert.strictEqual(result.canFill, true); // 85/100 = 85% >= MIN_FILL_RATIO (80%)
    });

    it("calculates expected slippage correctly", () => {
      const bids: OrderBookLevel[] = [
        { price: 0.5, size: 50 },
        { price: 0.45, size: 50 }, // 10% below best bid
      ];

      const result = analyzeLiquidity(bids, 100, 15);

      // Expected avg: (50*0.5 + 50*0.45) / 100 = 0.475
      // Slippage: (0.5 - 0.475) / 0.5 * 100 = 5%
      assert.ok(
        Math.abs(result.expectedSlippagePct - 5) < 0.0001,
        `Expected slippage near 5%, got ${result.expectedSlippagePct}`,
      );
    });
  });
});

describe("Smart Sell - Optimal Slippage Calculation", () => {
  describe("calculateOptimalSlippage", () => {
    it("returns max slippage when forceSell is true", () => {
      const position = createMockPosition();
      const result = calculateOptimalSlippage(position, { forceSell: true });

      assert.strictEqual(result, SELL.MAX_SLIPPAGE_PCT);
    });

    it("uses provided maxSlippagePct when specified", () => {
      const position = createMockPosition();
      const result = calculateOptimalSlippage(position, { maxSlippagePct: 3 });

      assert.strictEqual(result, 3);
    });

    it("caps provided slippage at MAX_SLIPPAGE_PCT", () => {
      const position = createMockPosition();
      const result = calculateOptimalSlippage(position, { maxSlippagePct: 100 });

      assert.strictEqual(result, SELL.MAX_SLIPPAGE_PCT);
    });

    it("uses tight slippage for high price positions (near $1)", () => {
      const position = createMockPosition({ curPrice: 0.96 });
      const result = calculateOptimalSlippage(position);

      assert.strictEqual(result, SELL.HIGH_PRICE_SLIPPAGE_PCT);
    });

    it("uses loss slippage for significant losses", () => {
      const position = createMockPosition({ pnlPct: -25 }); // -25% loss
      const result = calculateOptimalSlippage(position);

      assert.strictEqual(result, SELL.LOSS_SLIPPAGE_PCT);
    });

    it("uses default slippage for normal positions", () => {
      const position = createMockPosition({ curPrice: 0.55, pnlPct: 5 });
      const result = calculateOptimalSlippage(position);

      assert.strictEqual(result, SELL.DEFAULT_SLIPPAGE_PCT);
    });
  });
});

describe("Smart Sell - Order Type Selection", () => {
  describe("determineOrderType", () => {
    it("returns explicit orderType when specified", () => {
      const analysis = {
        bestBid: 0.5,
        liquidityAtSlippage: 100,
        liquidityAtBestBid: 100,
        expectedAvgPrice: 0.5,
        expectedSlippagePct: 0,
        canFill: true,
        levelsNeeded: 1,
        levels: [],
      };

      const result = determineOrderType(analysis, 100, { orderType: "GTC" });

      assert.strictEqual(result, "GTC");
    });

    it("returns FOK for forceSell", () => {
      const analysis = {
        bestBid: 0.5,
        liquidityAtSlippage: 50, // Low liquidity
        liquidityAtBestBid: 50,
        expectedAvgPrice: 0.45,
        expectedSlippagePct: 10,
        canFill: false,
        levelsNeeded: 3,
        levels: [],
      };

      const result = determineOrderType(analysis, 100, { forceSell: true });

      assert.strictEqual(result, "FOK");
    });

    it("returns FOK when liquidity is good and can fill easily", () => {
      const analysis = {
        bestBid: 0.5,
        liquidityAtSlippage: 100,
        liquidityAtBestBid: 50, // Double the minimum
        expectedAvgPrice: 0.5,
        expectedSlippagePct: 0,
        canFill: true,
        levelsNeeded: 1,
        levels: [],
      };

      const result = determineOrderType(analysis, 100);

      assert.strictEqual(result, "FOK");
    });

    it("returns GTC when orderbook is thin", () => {
      const analysis = {
        bestBid: 0.5,
        liquidityAtSlippage: 100,
        liquidityAtBestBid: 5, // Below MIN_LIQUIDITY_USD
        expectedAvgPrice: 0.48,
        expectedSlippagePct: 4,
        canFill: true,
        levelsNeeded: 5,
        levels: [],
      };

      const result = determineOrderType(analysis, 100);

      assert.strictEqual(result, "GTC");
    });

    it("returns GTC when multiple levels needed", () => {
      const analysis = {
        bestBid: 0.5,
        liquidityAtSlippage: 100,
        liquidityAtBestBid: 30,
        expectedAvgPrice: 0.48,
        expectedSlippagePct: 4,
        canFill: true,
        levelsNeeded: 5, // More than 2 levels
        levels: [],
      };

      const result = determineOrderType(analysis, 100);

      assert.strictEqual(result, "GTC");
    });
  });
});
