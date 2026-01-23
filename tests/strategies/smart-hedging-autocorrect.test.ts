import { test } from "node:test";
import assert from "node:assert/strict";
import { SmartHedgingStrategy, DEFAULT_SMART_HEDGING_CONFIG } from "../../src/strategies/smart-hedging";

// Mock logger that tracks messages
const createMockLogger = () => {
  const messages: string[] = [];
  return {
    info: (msg: string) => messages.push(`[INFO] ${msg}`),
    warn: (msg: string) => messages.push(`[WARN] ${msg}`),
    error: (msg: string) => messages.push(`[ERROR] ${msg}`),
    debug: (msg: string) => messages.push(`[DEBUG] ${msg}`),
    messages,
  };
};

// Mock position tracker
const mockPositionTracker = {
  getPositions: () => [],
  hasPosition: () => false,
} as any;

test("SmartHedgingStrategy auto-corrects maxHedgeUsd when absoluteMaxHedgeUsd is lower", () => {
  const mockLogger = createMockLogger();
  
  // Simulate user's config: aggressive preset (maxHedgeUsd=50) with absoluteMaxHedgeUsd=25
  const userConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    maxHedgeUsd: 50,  // From aggressive preset
    absoluteMaxHedgeUsd: 25,  // User's env override
  };

  // Should NOT throw - should auto-correct instead
  const strategy = new SmartHedgingStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: userConfig,
  });

  // Verify the config was auto-corrected
  const stats = strategy.getStats();
  // Note: getStats() doesn't expose maxHedgeUsd, so we verify via the logged message
  const autoAdjustMessage = mockLogger.messages.find(m => m.includes("Auto-adjusting maxHedgeUsd"));
  assert.ok(autoAdjustMessage, "Should log auto-adjustment message");
  assert.ok(autoAdjustMessage.includes("from $50 to $25"), "Should show correct values in message");
});

test("SmartHedgingStrategy does not auto-correct when absoluteMaxHedgeUsd is already >= maxHedgeUsd", () => {
  const mockLogger = createMockLogger();
  
  // Normal config where absoluteMaxHedgeUsd >= maxHedgeUsd
  const normalConfig = {
    ...DEFAULT_SMART_HEDGING_CONFIG,
    maxHedgeUsd: 10,
    absoluteMaxHedgeUsd: 100,
  };

  const strategy = new SmartHedgingStrategy({
    client: {} as any,
    logger: mockLogger as any,
    positionTracker: mockPositionTracker,
    config: normalConfig,
  });

  // Should NOT log auto-adjustment message
  const autoAdjustMessage = mockLogger.messages.find(m => m.includes("Auto-adjusting maxHedgeUsd"));
  assert.equal(autoAdjustMessage, undefined, "Should NOT log auto-adjustment message when config is valid");
});
