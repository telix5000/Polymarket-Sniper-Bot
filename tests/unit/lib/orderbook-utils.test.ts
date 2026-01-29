import { describe, it } from "node:test";
import * as assert from "node:assert";

import {
  sortBidsDescending,
  sortAsksAscending,
  normalizeRestOrderbook,
  getBestPricesFromRaw,
  parseRawLevels,
} from "../../../src/lib/orderbook-utils";

describe("Orderbook Utils", () => {
  describe("sortBidsDescending", () => {
    it("should sort bids with highest price first", () => {
      const bids = [
        { price: 0.5, size: 100 },
        { price: 0.7, size: 200 },
        { price: 0.3, size: 50 },
      ];
      const sorted = sortBidsDescending(bids);
      assert.strictEqual(
        sorted[0].price,
        0.7,
        "Best bid (highest) should be first",
      );
      assert.strictEqual(sorted[1].price, 0.5, "Second bid should be 0.5");
      assert.strictEqual(sorted[2].price, 0.3, "Lowest bid should be last");
    });

    it("should not mutate original array", () => {
      const bids = [
        { price: 0.5, size: 100 },
        { price: 0.7, size: 200 },
      ];
      const original = [...bids];
      sortBidsDescending(bids);
      assert.deepStrictEqual(
        bids,
        original,
        "Original array should not be modified",
      );
    });
  });

  describe("sortAsksAscending", () => {
    it("should sort asks with lowest price first", () => {
      const asks = [
        { price: 0.8, size: 100 },
        { price: 0.6, size: 200 },
        { price: 0.9, size: 50 },
      ];
      const sorted = sortAsksAscending(asks);
      assert.strictEqual(
        sorted[0].price,
        0.6,
        "Best ask (lowest) should be first",
      );
      assert.strictEqual(sorted[1].price, 0.8, "Second ask should be 0.8");
      assert.strictEqual(sorted[2].price, 0.9, "Highest ask should be last");
    });
  });

  describe("parseRawLevels", () => {
    it("should parse string prices and sizes to numbers", () => {
      const raw = [
        { price: "0.5", size: "100" },
        { price: "0.7", size: "200" },
      ];
      const parsed = parseRawLevels(raw);
      assert.strictEqual(parsed.length, 2);
      assert.strictEqual(parsed[0].price, 0.5);
      assert.strictEqual(parsed[0].size, 100);
    });

    it("should filter out invalid entries", () => {
      const raw = [
        { price: "0.5", size: "100" },
        { price: "invalid", size: "200" },
        { price: "0.7", size: "0" }, // Zero size
        { price: "0.8", size: "-50" }, // Negative size
      ];
      const parsed = parseRawLevels(raw);
      assert.strictEqual(parsed.length, 1, "Should only keep valid entry");
      assert.strictEqual(parsed[0].price, 0.5);
    });

    it("should handle undefined input", () => {
      const parsed = parseRawLevels(undefined);
      assert.deepStrictEqual(parsed, []);
    });
  });

  describe("normalizeRestOrderbook", () => {
    it("should normalize Polymarket REST orderbook format", () => {
      // Polymarket REST returns bids ascending (worst first), asks descending (worst first)
      const restOrderbook = {
        bids: [
          { price: "0.001", size: "1000" },
          { price: "0.01", size: "500" },
          { price: "0.68", size: "100" },
        ],
        asks: [
          { price: "0.999", size: "1000" },
          { price: "0.99", size: "500" },
          { price: "0.72", size: "100" },
        ],
      };

      const { bids, asks } = normalizeRestOrderbook(restOrderbook);

      // After normalization: bids descending (best first), asks ascending (best first)
      assert.strictEqual(bids[0].price, 0.68, "Best bid should be 0.68");
      assert.strictEqual(
        bids[bids.length - 1].price,
        0.001,
        "Worst bid should be 0.001",
      );
      assert.strictEqual(asks[0].price, 0.72, "Best ask should be 0.72");
      assert.strictEqual(
        asks[asks.length - 1].price,
        0.999,
        "Worst ask should be 0.999",
      );
    });
  });

  describe("getBestPricesFromRaw", () => {
    it("should return correct best prices from raw orderbook", () => {
      // Simulating Polymarket REST API response with worst prices first
      const rawOrderbook = {
        bids: [
          { price: "0.001", size: "911061.5" },
          { price: "0.002", size: "2003552" },
          { price: "0.68", size: "5000" },
          { price: "0.681", size: "31597.3" },
          { price: "0.682", size: "8639.43" },
        ],
        asks: [
          { price: "0.999", size: "5006091.93" },
          { price: "0.998", size: "2000261.48" },
          { price: "0.687", size: "800" },
          { price: "0.685", size: "7163.17" },
          { price: "0.684", size: "176.42" },
        ],
      };

      const result = getBestPricesFromRaw(rawOrderbook);

      assert.strictEqual(result.bestBid, 0.682, "Best bid should be 0.682");
      assert.strictEqual(result.bestAsk, 0.684, "Best ask should be 0.684");
      assert.strictEqual(
        result.bestBidCents,
        68.2,
        "Best bid cents should be 68.2",
      );
      assert.strictEqual(
        result.bestAskCents,
        68.4,
        "Best ask cents should be 68.4",
      );
    });

    it("should NOT return dust prices for active market", () => {
      // This test ensures we don't get the old bug where we'd read bids[0]/asks[0]
      // and get 0.001/0.999 instead of the actual best prices
      const rawOrderbook = {
        bids: [
          { price: "0.001", size: "1000" },
          { price: "0.5", size: "100" },
        ],
        asks: [
          { price: "0.999", size: "1000" },
          { price: "0.55", size: "100" },
        ],
      };

      const result = getBestPricesFromRaw(rawOrderbook);

      // Should NOT be dust prices
      assert.notStrictEqual(
        result.bestBid,
        0.001,
        "Best bid should NOT be 0.001",
      );
      assert.notStrictEqual(
        result.bestAsk,
        0.999,
        "Best ask should NOT be 0.999",
      );

      // Should be the actual best prices
      assert.strictEqual(result.bestBid, 0.5, "Best bid should be 0.5");
      assert.strictEqual(result.bestAsk, 0.55, "Best ask should be 0.55");

      // Should NOT trigger dust book detection
      const isDustBook = result.bestBidCents <= 2 && result.bestAskCents >= 98;
      assert.strictEqual(
        isDustBook,
        false,
        "Should NOT be detected as dust book",
      );
    });

    it("should handle empty orderbook", () => {
      const result = getBestPricesFromRaw({ bids: [], asks: [] });
      assert.strictEqual(result.bestBid, null);
      assert.strictEqual(result.bestAsk, null);
    });
  });
});
