import assert from "node:assert";
import { test, describe, beforeEach, afterEach, mock } from "node:test";
import {
  initTradeNotificationService,
  setTradeNotificationPnLCallback,
  isTradeNotificationEnabled,
  notifyTrade,
  notifyBuy,
  notifySell,
  notifyHedge,
  notifyHedgeExit,
  notifyRedeem,
  notifyStack,
  notifyStopLoss,
  notifyScalp,
  notifyFrontrun,
} from "../../src/services/trade-notification.service";
import { TelegramService } from "../../src/services/telegram.service";

/**
 * Unit tests for Trade Notification Service
 *
 * These tests verify:
 * 1. Service initialization and enable state
 * 2. Notification functions for all trade types
 * 3. P&L callback integration
 */

// Mock logger
function createMockLogger() {
  return {
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
    debug: mock.fn(),
  };
}

// Helper to reset module state between tests
// Note: We can't truly reset the singleton, but we can re-initialize it

describe("Trade Notification Service", () => {
  let mockFetch: ReturnType<typeof mock.fn>;
  let originalFetch: typeof global.fetch;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = mock.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      } as Response),
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockLogger = createMockLogger();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("Service Initialization", () => {
    test("isTradeNotificationEnabled returns false when Telegram service is disabled", () => {
      // Initialize with a disabled service (no botToken or chatId)
      const disabledService = new TelegramService({}, mockLogger);
      initTradeNotificationService(disabledService, mockLogger);
      
      assert.strictEqual(isTradeNotificationEnabled(), false);
    });

    test("isTradeNotificationEnabled returns true after initialization with enabled service", () => {
      const enabledService = new TelegramService(
        { botToken: "test-token", chatId: "123456" },
        mockLogger,
      );
      initTradeNotificationService(enabledService, mockLogger);

      assert.strictEqual(isTradeNotificationEnabled(), true);
    });
  });

  describe("notifyTrade", () => {
    test("returns false when service is disabled", async () => {
      const disabledService = new TelegramService({}, mockLogger);
      initTradeNotificationService(disabledService, mockLogger);

      const result = await notifyTrade({
        type: "BUY",
        marketId: "0x123",
        tokenId: "token1",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
      });

      assert.strictEqual(result, false);
      assert.strictEqual(mockFetch.mock.calls.length, 0);
    });

    test("sends notification when service is enabled", async () => {
      const enabledService = new TelegramService(
        { botToken: "test-token", chatId: "123456" },
        mockLogger,
      );
      initTradeNotificationService(enabledService, mockLogger);

      const result = await notifyTrade({
        type: "BUY",
        marketId: "0x1234567890abcdef1234567890abcdef",
        tokenId: "token1",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
        marketQuestion: "Test market?",
        outcome: "Yes",
      });

      assert.strictEqual(result, true);
      assert.strictEqual(mockFetch.mock.calls.length, 1);
    });

    test("includes P&L snapshot when callback is set", async () => {
      const enabledService = new TelegramService(
        { botToken: "test-token", chatId: "123456" },
        mockLogger,
      );
      initTradeNotificationService(enabledService, mockLogger);
      
      // Set P&L callback
      setTradeNotificationPnLCallback(() => ({
        totalRealizedPnl: 100,
        totalUnrealizedPnl: 50,
        totalFees: 5,
        netPnl: 145,
        winningTrades: 8,
        losingTrades: 2,
        winRate: 0.8,
        avgWin: 15,
        avgLoss: -5,
        largestWin: 30,
        largestLoss: -10,
        byStrategy: new Map(),
      }));

      const result = await notifyTrade({
        type: "SELL",
        marketId: "0x1234567890abcdef1234567890abcdef",
        tokenId: "token1",
        size: 10,
        price: 0.7,
        sizeUsd: 7,
        pnl: 2,
      });

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      // Check P&L snapshot was included
      assert.ok(body.text.includes("Portfolio Update"));
      assert.ok(body.text.includes("$145.00")); // Net P&L
    });
  });

  describe("Convenience Functions", () => {
    beforeEach(() => {
      const enabledService = new TelegramService(
        { botToken: "test-token", chatId: "123456" },
        mockLogger,
      );
      initTradeNotificationService(enabledService, mockLogger);
    });

    test("notifyBuy sends BUY notification", async () => {
      const result = await notifyBuy(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        10,
        0.5,
        5,
        { marketQuestion: "Test?" },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Position Bought"));
    });

    test("notifySell sends SELL notification", async () => {
      const result = await notifySell(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        10,
        0.7,
        7,
        { entryPrice: 0.5, pnl: 2 },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Position Sold"));
    });

    test("notifyHedge sends HEDGE notification with strategy", async () => {
      const result = await notifyHedge(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        20,
        0.3,
        6,
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Hedge Placed"));
      assert.ok(body.text.includes("SmartHedging"));
    });

    test("notifyHedgeExit sends HEDGE_EXIT notification", async () => {
      const result = await notifyHedgeExit(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        20,
        0.6,
        12,
        { pnl: 6 },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Hedge Exited"));
    });

    test("notifyRedeem sends REDEEM notification", async () => {
      const result = await notifyRedeem(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        50,
        1.0,
        50,
        { txHash: "0xabc123" },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Position Redeemed"));
      assert.ok(body.text.includes("AutoRedeem"));
    });

    test("notifyStack sends STACK notification", async () => {
      const result = await notifyStack(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        25,
        0.75,
        18.75,
        { entryPrice: 0.55 },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Position Stacked"));
      assert.ok(body.text.includes("PositionStacking"));
    });

    test("notifyStopLoss sends STOP_LOSS notification", async () => {
      const result = await notifyStopLoss(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        30,
        0.4,
        12,
        { entryPrice: 0.6, pnl: -6 },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Stop-Loss Triggered"));
      assert.ok(body.text.includes("StopLoss"));
    });

    test("notifyScalp sends SCALP notification", async () => {
      const result = await notifyScalp(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        40,
        0.8,
        32,
        { entryPrice: 0.65, pnl: 6 },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Scalp Profit Taken"));
      assert.ok(body.text.includes("ScalpTrade"));
    });

    test("notifyFrontrun sends FRONTRUN notification", async () => {
      const result = await notifyFrontrun(
        "0x1234567890abcdef1234567890abcdef",
        "token1",
        15,
        0.55,
        8.25,
        { marketQuestion: "Will this happen?" },
      );

      assert.strictEqual(result, true);
      const [, options] = mockFetch.mock.calls[0].arguments;
      const body = JSON.parse(options.body);
      assert.ok(body.text.includes("Copy Trade Executed"));
      assert.ok(body.text.includes("Frontrun"));
    });
  });

  describe("Error Handling", () => {
    test("handles P&L callback errors gracefully", async () => {
      const enabledService = new TelegramService(
        { botToken: "test-token", chatId: "123456" },
        mockLogger,
      );
      initTradeNotificationService(enabledService, mockLogger);
      
      // Set P&L callback that throws
      setTradeNotificationPnLCallback(() => {
        throw new Error("P&L fetch failed");
      });

      // Should still send notification without P&L
      const result = await notifyTrade({
        type: "BUY",
        marketId: "0x1234567890abcdef1234567890abcdef",
        tokenId: "token1",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
      });

      assert.strictEqual(result, true);
      // Check that warning was logged
      const warnCalls = mockLogger.warn.mock.calls;
      const hasPnLWarning = warnCalls.some((call: { arguments: string[] }) =>
        call.arguments[0].includes("Failed to get P&L summary"),
      );
      assert.ok(hasPnLWarning);
    });

    test("handles Telegram API errors gracefully", async () => {
      mockFetch = mock.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
        } as Response),
      );
      global.fetch = mockFetch as unknown as typeof global.fetch;

      const enabledService = new TelegramService(
        { botToken: "test-token", chatId: "123456" },
        mockLogger,
      );
      initTradeNotificationService(enabledService, mockLogger);

      const result = await notifyTrade({
        type: "BUY",
        marketId: "0x1234567890abcdef1234567890abcdef",
        tokenId: "token1",
        size: 10,
        price: 0.5,
        sizeUsd: 5,
      });

      // Should return false on API error
      assert.strictEqual(result, false);
    });
  });
});
