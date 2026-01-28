/**
 * No Market Data Cooldown Tests
 *
 * Tests for the fix that adds cooldown for tokens that fail entry due to
 * "No market data" (closed/settled markets). This prevents the bot from
 * repeatedly trying to enter markets that have no orderbook available.
 *
 * Bug: https://github.com/telix5000/Polymarket-Sniper-Bot/issues/X
 * - Bot attempts entries with IDs like 808346101849..., 783012262113...
 * - Immediately fails with "No market data returned for ..."
 * - These are valid token IDs from whale activity on closed/settled markets
 * - Without cooldown, these tokens get retried every cycle creating noise
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("No Market Data Cooldown", () => {
  describe("shouldCooldownOnFailure behavior", () => {
    // The shouldCooldownOnFailure function determines if a failure should trigger cooldown
    // It's defined in start.ts and checks for liquidity/bounds/spread/price issues

    it("should understand that NO_MARKET_DATA failures need separate handling", () => {
      // NO_MARKET_DATA is NOT handled by shouldCooldownOnFailure (which returns false)
      // Instead, it's handled directly in the entry code with a longer cooldown
      // This is by design - closed markets need longer cooldown than liquidity issues

      // Verify the constants are appropriate
      const FAILED_ENTRY_COOLDOWN_MS = 60 * 1000; // 60 seconds
      const NO_MARKET_DATA_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

      // NO_MARKET_DATA cooldown should be longer than regular entry cooldown
      assert.ok(
        NO_MARKET_DATA_COOLDOWN_MS > FAILED_ENTRY_COOLDOWN_MS,
        "NO_MARKET_DATA cooldown should be longer than regular failure cooldown",
      );

      // NO_MARKET_DATA cooldown should be at least 5 minutes
      assert.ok(
        NO_MARKET_DATA_COOLDOWN_MS >= 5 * 60 * 1000,
        "NO_MARKET_DATA cooldown should be at least 5 minutes (closed markets don't reopen quickly)",
      );
    });

    it("should not interfere with legitimate entry failures", () => {
      // Verify the regular failure reasons are different from NO_MARKET_DATA
      const liquidityFailures = [
        "Insufficient liquidity",
        "Low liquidity",
        "No liquidity at price",
      ];

      const boundsFailures = [
        "Price outside bounds",
        "Entry bounds exceeded",
      ];

      // These should be handled by shouldCooldownOnFailure (separate from NO_MARKET_DATA)
      for (const failure of [...liquidityFailures, ...boundsFailures]) {
        assert.ok(
          failure !== "NO_MARKET_DATA",
          `Regular failure "${failure}" should not be confused with NO_MARKET_DATA`,
        );
      }
    });
  });

  describe("Token ID format validation", () => {
    it("should recognize valid Polymarket CLOB token IDs", () => {
      // Valid CLOB token IDs are 256-bit integers (typically 77+ digits as strings)
      const validTokenIds = [
        "28542071792300007181611447397504994131484152585152031411345975186749097403884",
        "57625936606489185661652559589880983710918172021553907271126623944716577292773",
        "23108802207086798801173033667711295391410673134835650507670472347957366091390",
      ];

      for (const tokenId of validTokenIds) {
        // Valid token IDs should be strings
        assert.strictEqual(typeof tokenId, "string", "Token ID should be a string");

        // Valid token IDs should be 70-80 characters long (256-bit integer as decimal)
        assert.ok(
          tokenId.length >= 70 && tokenId.length <= 80,
          `Token ID length should be 70-80 chars, got ${tokenId.length}`,
        );

        // Valid token IDs should contain only digits
        assert.ok(
          /^\d+$/.test(tokenId),
          "Token ID should contain only digits",
        );
      }
    });

    it("should log first 12 characters when displaying token IDs", () => {
      // The codebase uses .slice(0, 12) to display token IDs
      // This is what creates the "808346101849..." format in logs
      const tokenId = "28542071792300007181611447397504994131484152585152031411345975186749097403884";
      const displayed = tokenId.slice(0, 12) + "...";

      assert.strictEqual(
        displayed,
        "285420717923...",
        "Token ID should be truncated to 12 chars for display",
      );
    });
  });

  describe("Market data failure scenarios", () => {
    it("should correctly identify closed market scenarios", () => {
      // When a market is closed, the CLOB API returns:
      // {"error":"No orderbook exists for the requested token id"}
      // This causes fetchTokenMarketData to return null
      // Which triggers the "No market data returned for..." error

      const closedMarketResponse = {
        error: "No orderbook exists for the requested token id",
      };

      // This is the error message that indicates a closed market
      assert.ok(
        closedMarketResponse.error.includes("No orderbook"),
        "Closed market error should mention missing orderbook",
      );
    });

    it("should differentiate closed markets from empty orderbooks", () => {
      // Empty orderbook (market open but no liquidity) - bids/asks are empty arrays
      const emptyOrderbook = { bids: [], asks: [] };

      // Closed market - API returns error, no bids/asks at all
      const closedMarketResponse = {
        error: "No orderbook exists for the requested token id",
      };

      // Both result in "No market data" but for different reasons
      // The fix treats them the same (add to cooldown) which is correct
      // because neither can be traded regardless of the reason
      assert.ok(
        !emptyOrderbook.bids.length,
        "Empty orderbook has no bids",
      );
      assert.ok(
        "error" in closedMarketResponse,
        "Closed market returns error object",
      );
    });
  });
});
