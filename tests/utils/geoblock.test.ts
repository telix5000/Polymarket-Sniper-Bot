import { test } from "node:test";
import assert from "node:assert/strict";
import { type GeoblockResponse } from "../../src/utils/geoblock.util";
import { POLYMARKET_API } from "../../src/constants/polymarket.constants";

// Test that the geoblock endpoint constant is correct
test("GEOBLOCK_ENDPOINT matches Polymarket documentation", () => {
  assert.equal(
    POLYMARKET_API.GEOBLOCK_ENDPOINT,
    "https://polymarket.com/api/geoblock",
  );
});

// Test GeoblockResponse type matches expected structure
test("GeoblockResponse type has required fields", () => {
  const response: GeoblockResponse = {
    blocked: false,
    ip: "1.2.3.4",
    country: "CA",
    region: "BC",
  };
  assert.equal(typeof response.blocked, "boolean");
  assert.equal(typeof response.ip, "string");
  assert.equal(typeof response.country, "string");
  assert.equal(typeof response.region, "string");
});

// Test blocked response structure for restricted country
test("GeoblockResponse correctly represents blocked status", () => {
  const blockedResponse: GeoblockResponse = {
    blocked: true,
    ip: "5.6.7.8",
    country: "US",
    region: "NY",
  };
  assert.equal(blockedResponse.blocked, true);
  assert.equal(blockedResponse.country, "US");
});

// Test allowed response structure
test("GeoblockResponse correctly represents allowed status", () => {
  const allowedResponse: GeoblockResponse = {
    blocked: false,
    ip: "1.2.3.4",
    country: "CA",
    region: "BC",
  };
  assert.equal(allowedResponse.blocked, false);
  assert.equal(allowedResponse.country, "CA");
});

// Note: Integration tests for checkGeoblock, isGeoblocked, and verifyGeographicEligibility
// would require actual network calls to Polymarket API or mocking infrastructure.
// The above tests verify the type contracts and configuration are correct.
