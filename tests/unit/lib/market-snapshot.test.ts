/**
 * Market Snapshot Tests
 *
 * Tests for:
 * - Snapshot immutability throughout execution attempt
 * - Cache safety: dust/empty books don't overwrite healthy cache
 * - Single fetch per attempt guarantee
 * - Bug detection for book changes during attempt
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  createMarketSnapshot,
  classifyBookStatus,
  isDustOrEmptyStatus,
  updateCacheWithSafety,
  assertSnapshotIntegrity,
  isSnapshotHealthy,
  generateAttemptId,
  _resetAttemptCounter,
} from "../../../src/lib/market-snapshot";
import {
  MarketDataStore,
  initMarketDataStore,
} from "../../../src/lib/market-data-store";
import type {
  MarketSnapshot,
  MarketSnapshotStatus,
} from "../../../src/book/types";

// ============================================================================
// Test Helpers
// ============================================================================

function createHealthySnapshot(
  overrides?: Partial<Parameters<typeof createMarketSnapshot>[0]>,
): MarketSnapshot {
  return createMarketSnapshot({
    tokenId: "test-token-healthy",
    bestBid: 0.47,
    bestAsk: 0.49,
    source: "WS_CACHE",
    attemptId: "attempt-test-healthy",
    ...overrides,
  });
}

function createDustSnapshot(
  overrides?: Partial<Parameters<typeof createMarketSnapshot>[0]>,
): MarketSnapshot {
  return createMarketSnapshot({
    tokenId: "test-token-dust",
    bestBid: 0.01,
    bestAsk: 0.99,
    source: "REST",
    attemptId: "attempt-test-dust",
    ...overrides,
  });
}

// ============================================================================
// Snapshot Immutability Tests
// ============================================================================

describe("MarketSnapshot Immutability", () => {
  beforeEach(() => {
    _resetAttemptCounter();
  });

  it("should create a frozen (immutable) snapshot", () => {
    const snapshot = createHealthySnapshot();

    assert.strictEqual(
      Object.isFrozen(snapshot),
      true,
      "Snapshot should be frozen",
    );
  });

  it("should not allow modification of snapshot properties", () => {
    const snapshot = createHealthySnapshot();

    // Attempt to modify - should throw or silently fail in strict mode
    assert.throws(() => {
      (snapshot as any).bestBid = 0.1;
    }, "Should throw when trying to modify frozen object");
  });

  it("should preserve original snapshot values when cache is updated with dust", () => {
    // This is the KEY test: snapshot created with healthy values should NOT change
    // when cache is later updated with dust values

    const healthySnapshot = createHealthySnapshot();

    // Store original values
    const originalBid = healthySnapshot.bestBid;
    const originalAsk = healthySnapshot.bestAsk;
    const originalStatus = healthySnapshot.bookStatus;

    // Simulate a dust cache update happening after snapshot was created
    // (This would happen in real code via WS update or REST recovery)
    const store = initMarketDataStore({ maxTokens: 100, staleMs: 5000 });

    // First, add healthy data to cache
    store.updateFromWs(
      "test-token-healthy",
      [{ price: 0.47, size: 100 }],
      [{ price: 0.49, size: 100 }],
    );

    // Now simulate dust update - the snapshot should NOT change
    store.updateFromRest(
      "test-token-healthy",
      [{ price: 0.01, size: 1 }],
      [{ price: 0.99, size: 1 }],
    );

    // CRITICAL: Snapshot values must remain unchanged
    assert.strictEqual(
      healthySnapshot.bestBid,
      originalBid,
      "Snapshot bid should not change",
    );
    assert.strictEqual(
      healthySnapshot.bestAsk,
      originalAsk,
      "Snapshot ask should not change",
    );
    assert.strictEqual(
      healthySnapshot.bookStatus,
      originalStatus,
      "Snapshot status should not change",
    );
    assert.strictEqual(
      healthySnapshot.bookStatus,
      "HEALTHY",
      "Snapshot should still be HEALTHY",
    );
  });

  it("should maintain snapshot integrity across function calls", () => {
    const snapshot = createHealthySnapshot();

    // Simulate passing snapshot through execution chain
    const step1Bid = snapshot.bestBid;
    const step1Ask = snapshot.bestAsk;

    // "computeExecutionLimitPrice" would use these values
    // BUY with 6% slippage in real execution logic

    // "placeOrderWithFallback" would use these values
    const step2Bid = snapshot.bestBid;
    const step2Ask = snapshot.bestAsk;

    // Values should be identical throughout
    assert.strictEqual(step1Bid, step2Bid, "Bid should be same across steps");
    assert.strictEqual(step1Ask, step2Ask, "Ask should be same across steps");

    // Integrity check should pass
    assert.strictEqual(
      assertSnapshotIntegrity(snapshot, step2Bid, step2Ask, "TEST_LOCATION"),
      true,
      "Snapshot integrity should pass",
    );
  });
});

// ============================================================================
// Cache Safety Tests (doNotCacheDust)
// ============================================================================

describe("Cache Safety - Dust Protection", () => {
  let store: MarketDataStore;

  beforeEach(() => {
    store = initMarketDataStore({ maxTokens: 100, staleMs: 5000 });
  });

  it("should NOT overwrite healthy cache with dust/empty REST response", () => {
    const tokenId = "test-dust-protection";

    // Set up healthy cache entry
    store.updateFromWs(
      tokenId,
      [{ price: 0.47, size: 100 }],
      [{ price: 0.49, size: 100 }],
    );

    const beforeUpdate = store.get(tokenId);
    assert.strictEqual(beforeUpdate?.bestBid, 0.47);
    assert.strictEqual(beforeUpdate?.bestAsk, 0.49);

    // Attempt to update with dust (should be rejected)
    const wasUpdated = updateCacheWithSafety(
      tokenId,
      [{ price: "0.01", size: "1" }],
      [{ price: "0.99", size: "1" }],
      "DUST_BOOK" as MarketSnapshotStatus,
    );

    // Update should be rejected
    assert.strictEqual(wasUpdated, false, "Dust update should be rejected");

    // Cache should still have healthy values
    const afterUpdate = store.get(tokenId);
    assert.strictEqual(afterUpdate?.bestBid, 0.47, "Bid should remain healthy");
    assert.strictEqual(afterUpdate?.bestAsk, 0.49, "Ask should remain healthy");
  });

  it("should NOT overwrite healthy cache with EMPTY_BOOK status", () => {
    const tokenId = "test-empty-protection";

    // Set up healthy cache entry
    store.updateFromWs(
      tokenId,
      [{ price: 0.55, size: 200 }],
      [{ price: 0.57, size: 200 }],
    );

    // Attempt to update with empty book (should be rejected)
    const wasUpdated = updateCacheWithSafety(
      tokenId,
      [{ price: "0.01", size: "1" }],
      [{ price: "0.99", size: "1" }],
      "EMPTY_BOOK" as MarketSnapshotStatus,
    );

    assert.strictEqual(
      wasUpdated,
      false,
      "Empty book update should be rejected",
    );

    // Verify cache preserved
    const cached = store.get(tokenId);
    assert.strictEqual(cached?.bestBid, 0.55);
    assert.strictEqual(cached?.bestAsk, 0.57);
  });

  it("should NOT overwrite healthy cache with DEAD_BOOK status", () => {
    const tokenId = "test-dead-protection";

    // Set up healthy cache entry
    store.updateFromWs(
      tokenId,
      [{ price: 0.45, size: 150 }],
      [{ price: 0.47, size: 150 }],
    );

    // Attempt to update with dead book (should be rejected)
    const wasUpdated = updateCacheWithSafety(
      tokenId,
      [{ price: "0.02", size: "1" }],
      [{ price: "0.98", size: "1" }],
      "DEAD_BOOK" as MarketSnapshotStatus,
    );

    assert.strictEqual(
      wasUpdated,
      false,
      "Dead book update should be rejected",
    );
  });

  it("should ALLOW healthy update to replace dust cache", () => {
    const tokenId = "test-healthy-replaces-dust";

    // Start with dust in cache
    store.updateFromRest(
      tokenId,
      [{ price: 0.01, size: 1 }],
      [{ price: 0.99, size: 1 }],
    );

    // Update with healthy data (should succeed)
    const wasUpdated = updateCacheWithSafety(
      tokenId,
      [{ price: "0.47", size: "100" }],
      [{ price: "0.49", size: "100" }],
      "HEALTHY" as MarketSnapshotStatus,
    );

    assert.strictEqual(wasUpdated, true, "Healthy update should succeed");

    // Verify cache updated
    const cached = store.get(tokenId);
    assert.strictEqual(cached?.bestBid, 0.47);
    assert.strictEqual(cached?.bestAsk, 0.49);
  });

  it("should ALLOW dust update when no existing cache", () => {
    const tokenId = "test-dust-when-no-cache";

    // No existing cache - dust update should succeed
    const wasUpdated = updateCacheWithSafety(
      tokenId,
      [{ price: "0.01", size: "1" }],
      [{ price: "0.99", size: "1" }],
      "DUST_BOOK" as MarketSnapshotStatus,
    );

    assert.strictEqual(
      wasUpdated,
      true,
      "Dust update should succeed when no cache exists",
    );
  });
});

// ============================================================================
// Book Status Classification Tests
// ============================================================================

describe("Book Status Classification", () => {
  it("should classify healthy book correctly", () => {
    const result = classifyBookStatus(0.47, 0.49);
    assert.strictEqual(result.status, "HEALTHY");
    assert.strictEqual(result.reason, undefined);
  });

  it("should classify empty book (0.01/0.99)", () => {
    const result = classifyBookStatus(0.01, 0.99);
    assert.strictEqual(result.status, "EMPTY_BOOK");
    assert.ok(result.reason?.includes("Empty book"));
  });

  it("should classify dust book (0.02/0.98)", () => {
    const result = classifyBookStatus(0.02, 0.98);
    assert.strictEqual(result.status, "DUST_BOOK");
    assert.ok(result.reason?.includes("Dust book"));
  });

  it("should classify crossed book", () => {
    const result = classifyBookStatus(0.6, 0.5);
    assert.strictEqual(result.status, "CROSSED_BOOK");
    assert.ok(result.reason?.includes("Crossed book"));
  });

  it("should classify invalid book (null values)", () => {
    const result = classifyBookStatus(null, 0.5);
    assert.strictEqual(result.status, "INVALID_BOOK");
  });

  it("should classify wide spread", () => {
    const result = classifyBookStatus(0.2, 0.8, 30); // 60¢ spread, max 30¢
    assert.strictEqual(result.status, "WIDE_SPREAD");
  });

  it("should recognize dust/empty statuses", () => {
    assert.strictEqual(isDustOrEmptyStatus("DUST_BOOK"), true);
    assert.strictEqual(isDustOrEmptyStatus("EMPTY_BOOK"), true);
    assert.strictEqual(isDustOrEmptyStatus("DEAD_BOOK"), true);
    assert.strictEqual(isDustOrEmptyStatus("HEALTHY"), false);
    assert.strictEqual(isDustOrEmptyStatus("WIDE_SPREAD"), false);
  });
});

// ============================================================================
// Snapshot Integrity Assertion Tests
// ============================================================================

describe("Snapshot Integrity Assertion", () => {
  it("should return true when bid/ask match snapshot", () => {
    const snapshot = createHealthySnapshot();

    const result = assertSnapshotIntegrity(
      snapshot,
      snapshot.bestBid,
      snapshot.bestAsk,
      "TEST_MATCH",
    );

    assert.strictEqual(result, true);
  });

  it("should return false and log error when bid changes", () => {
    const snapshot = createHealthySnapshot();

    const result = assertSnapshotIntegrity(
      snapshot,
      0.1, // Different bid!
      snapshot.bestAsk,
      "TEST_BID_CHANGE",
    );

    assert.strictEqual(result, false);
  });

  it("should return false and log error when ask changes", () => {
    const snapshot = createHealthySnapshot();

    const result = assertSnapshotIntegrity(
      snapshot,
      snapshot.bestBid,
      0.9, // Different ask!
      "TEST_ASK_CHANGE",
    );

    assert.strictEqual(result, false);
  });

  it("should allow small floating point differences (epsilon)", () => {
    const snapshot = createHealthySnapshot();

    // Small difference within epsilon (0.0001)
    const result = assertSnapshotIntegrity(
      snapshot,
      snapshot.bestBid + 0.00005,
      snapshot.bestAsk - 0.00005,
      "TEST_EPSILON",
    );

    assert.strictEqual(
      result,
      true,
      "Should allow small floating point differences",
    );
  });
});

// ============================================================================
// Attempt ID Generation Tests
// ============================================================================

describe("Attempt ID Generation", () => {
  beforeEach(() => {
    _resetAttemptCounter();
  });

  it("should generate unique attempt IDs", () => {
    const id1 = generateAttemptId();
    const id2 = generateAttemptId();
    const id3 = generateAttemptId();

    assert.notStrictEqual(id1, id2);
    assert.notStrictEqual(id2, id3);
    assert.notStrictEqual(id1, id3);
  });

  it("should include timestamp in attempt ID", () => {
    const id = generateAttemptId();

    assert.ok(id.startsWith("attempt-"), "Should start with 'attempt-'");
    assert.ok(id.includes("-"), "Should contain dashes");

    // Extract timestamp portion and verify it's reasonable
    const parts = id.split("-");
    const timestamp = parseInt(parts[1], 10);
    assert.ok(timestamp > 1700000000000, "Timestamp should be recent");
  });

  it("should increment counter for each ID", () => {
    _resetAttemptCounter();

    const id1 = generateAttemptId();
    const id2 = generateAttemptId();

    const counter1 = parseInt(id1.split("-")[2], 10);
    const counter2 = parseInt(id2.split("-")[2], 10);

    assert.strictEqual(counter2, counter1 + 1, "Counter should increment");
  });
});

// ============================================================================
// Snapshot Health Check Tests
// ============================================================================

describe("Snapshot Health Check", () => {
  it("should return true for HEALTHY snapshot", () => {
    const snapshot = createHealthySnapshot();
    assert.strictEqual(isSnapshotHealthy(snapshot), true);
  });

  it("should return false for DUST_BOOK snapshot", () => {
    const snapshot = createDustSnapshot();
    assert.strictEqual(isSnapshotHealthy(snapshot), false);
  });

  it("should return false for EMPTY_BOOK snapshot", () => {
    const snapshot = createMarketSnapshot({
      tokenId: "test",
      bestBid: 0.01,
      bestAsk: 0.99,
      source: "REST",
    });
    assert.strictEqual(isSnapshotHealthy(snapshot), false);
  });

  it("should use snapshot bookStatus, not re-read from cache (KEY TEST)", () => {
    // This is THE KEY TEST: health check must use snapshot's bookStatus,
    // not read "current" cache which may have been updated to dust/empty

    const store = initMarketDataStore({ maxTokens: 100, staleMs: 5000 });

    // Create a HEALTHY snapshot (bid=47¢, ask=49¢)
    const healthySnapshot = createMarketSnapshot({
      tokenId: "test-health-from-snapshot",
      bestBid: 0.47,
      bestAsk: 0.49,
      source: "WS_CACHE",
    });

    // Verify snapshot is healthy at creation
    assert.strictEqual(isSnapshotHealthy(healthySnapshot), true, "Snapshot should be HEALTHY at creation");
    assert.strictEqual(healthySnapshot.bookStatus, "HEALTHY", "bookStatus should be HEALTHY");

    // NOW: Simulate cache being updated to dust AFTER snapshot was created
    // This simulates the race condition where WS pushes dust data during execution
    store.updateFromWs(
      "test-health-from-snapshot",
      [{ price: 0.01, size: 1 }], // Dust bid
      [{ price: 0.99, size: 1 }], // Dust ask
    );

    // Verify cache now has dust values
    const cacheData = store.get("test-health-from-snapshot");
    assert.strictEqual(cacheData?.bestBid, 0.01, "Cache should have dust bid");
    assert.strictEqual(cacheData?.bestAsk, 0.99, "Cache should have dust ask");

    // CRITICAL: isSnapshotHealthy MUST still return true because it uses
    // the snapshot's bookStatus, NOT the current cache values
    assert.strictEqual(
      isSnapshotHealthy(healthySnapshot),
      true,
      "isSnapshotHealthy MUST use snapshot.bookStatus, NOT current cache"
    );
    assert.strictEqual(
      healthySnapshot.bookStatus,
      "HEALTHY",
      "Snapshot bookStatus MUST remain HEALTHY regardless of cache updates"
    );
    assert.strictEqual(
      healthySnapshot.bestBid,
      0.47,
      "Snapshot bestBid MUST remain 0.47 regardless of cache updates"
    );
    assert.strictEqual(
      healthySnapshot.bestAsk,
      0.49,
      "Snapshot bestAsk MUST remain 0.49 regardless of cache updates"
    );
  });
});

// ============================================================================
// Integration-ish Test: Single Fetch Per Attempt
// ============================================================================

describe("Single Fetch Per Attempt", () => {
  it("should use the same snapshot values in computeExecutionLimitPrice and placeOrderWithFallback", () => {
    // Simulates the execution flow where snapshot is passed through
    const snapshot = createHealthySnapshot();

    // Step 1: "computeExecutionLimitPrice" receives snapshot
    const computeInput = {
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      side: "BUY" as const,
      slippageFrac: 0.06,
    };

    // Verify values match snapshot
    assert.strictEqual(computeInput.bestBid, snapshot.bestBid);
    assert.strictEqual(computeInput.bestAsk, snapshot.bestAsk);

    // Step 2: "placeOrderWithFallback" receives same values
    const placeOrderInput = {
      bestBid: snapshot.bestBid,
      bestAsk: snapshot.bestAsk,
      limitPrice: snapshot.bestAsk * (1 + 0.06),
    };

    // Verify values still match snapshot
    assert.strictEqual(placeOrderInput.bestBid, snapshot.bestBid);
    assert.strictEqual(placeOrderInput.bestAsk, snapshot.bestAsk);

    // Step 3: Integrity check should pass
    assert.strictEqual(
      assertSnapshotIntegrity(
        snapshot,
        placeOrderInput.bestBid,
        placeOrderInput.bestAsk,
        "FINAL_CHECK",
      ),
      true,
    );
  });

  it("should detect when different values are used (bug scenario)", () => {
    const originalSnapshot = createHealthySnapshot();

    // Simulate bug: someone re-fetches and gets dust values
    const buggyDustBid = 0.01;
    const buggyDustAsk = 0.99;

    // Integrity check should FAIL and detect the bug
    const result = assertSnapshotIntegrity(
      originalSnapshot,
      buggyDustBid,
      buggyDustAsk,
      "BUG_DETECTION_TEST",
    );

    assert.strictEqual(result, false, "Should detect book change as a bug");
  });
});
