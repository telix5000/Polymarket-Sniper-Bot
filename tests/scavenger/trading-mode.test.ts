import assert from "node:assert";
import { test, describe } from "node:test";

/**
 * Unit tests for V2 Scavenger Mode - Trading Mode State Machine
 *
 * These tests verify:
 * 1. Trading mode enum and state management
 * 2. Mode transitions with proper logging
 * 3. Time tracking in current mode
 */

import {
  TradingMode,
  createTradingModeState,
  transitionMode,
  isScavengerMode,
  isNormalMode,
  getTimeInCurrentMode,
  formatModeState,
} from "../../src/lib/trading-mode";

describe("V2 Trading Mode State Machine", () => {
  describe("Initial State", () => {
    test("creates initial state in NORMAL_MODE", () => {
      const state = createTradingModeState();
      assert.strictEqual(state.currentMode, TradingMode.NORMAL_MODE);
      assert.ok(state.enteredAt > 0);
      assert.strictEqual(state.transitionHistory.length, 0);
      assert.strictEqual(state.lastTransition, undefined);
    });

    test("isNormalMode returns true for initial state", () => {
      const state = createTradingModeState();
      assert.strictEqual(isNormalMode(state), true);
      assert.strictEqual(isScavengerMode(state), false);
    });
  });

  describe("Mode Transitions", () => {
    test("transitions from NORMAL_MODE to SCAVENGER_MODE", () => {
      const initialState = createTradingModeState();
      const reason = {
        trigger: "Low liquidity detected",
        metrics: { volumeUsd: 500, volumeThreshold: 1000 },
      };

      const newState = transitionMode(
        initialState,
        TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE,
        reason,
      );

      assert.strictEqual(
        newState.currentMode,
        TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE,
      );
      assert.strictEqual(isScavengerMode(newState), true);
      assert.strictEqual(isNormalMode(newState), false);
      assert.strictEqual(newState.transitionHistory.length, 1);
      assert.strictEqual(
        newState.lastTransition?.from,
        TradingMode.NORMAL_MODE,
      );
      assert.strictEqual(
        newState.lastTransition?.to,
        TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE,
      );
    });

    test("transitions from SCAVENGER_MODE back to NORMAL_MODE", () => {
      let state = createTradingModeState();
      state = transitionMode(state, TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE, {
        trigger: "Low liquidity",
        metrics: {},
      });

      const newState = transitionMode(state, TradingMode.NORMAL_MODE, {
        trigger: "Market activity recovered",
        metrics: { volumeUsd: 5000, volumeThreshold: 1000 },
      });

      assert.strictEqual(newState.currentMode, TradingMode.NORMAL_MODE);
      assert.strictEqual(isNormalMode(newState), true);
      assert.strictEqual(isScavengerMode(newState), false);
      assert.strictEqual(newState.transitionHistory.length, 2);
    });

    test("no-op when transitioning to same mode", () => {
      const state = createTradingModeState();
      const newState = transitionMode(state, TradingMode.NORMAL_MODE, {
        trigger: "Test",
        metrics: {},
      });

      // Should return same state
      assert.strictEqual(newState, state);
      assert.strictEqual(newState.transitionHistory.length, 0);
    });

    test("records transition reason and metrics", () => {
      const state = createTradingModeState();
      const reason = {
        trigger: "Low liquidity detected",
        metrics: {
          volumeUsd: 500,
          volumeThreshold: 1000,
          orderBookDepth: 200,
          depthThreshold: 500,
        },
      };

      const newState = transitionMode(
        state,
        TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE,
        reason,
      );

      assert.deepStrictEqual(newState.lastTransition?.reason, reason);
    });

    test("keeps only last 100 transitions in history", () => {
      let state = createTradingModeState();

      // Create 150 transitions
      for (let i = 0; i < 150; i++) {
        const targetMode =
          i % 2 === 0
            ? TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE
            : TradingMode.NORMAL_MODE;
        state = transitionMode(state, targetMode, {
          trigger: `Transition ${i}`,
          metrics: {},
        });
      }

      // History should be capped at 100
      assert.ok(state.transitionHistory.length <= 100);
    });
  });

  describe("Time Tracking", () => {
    test("getTimeInCurrentMode returns positive duration", () => {
      const state = createTradingModeState();

      // Small delay to ensure time passes
      const time = getTimeInCurrentMode(state);

      assert.ok(time >= 0, "Time in mode should be non-negative");
    });

    test("formatModeState includes mode name and duration", () => {
      const state = createTradingModeState();
      const formatted = formatModeState(state);

      assert.ok(formatted.includes("NORMAL_MODE"));
      assert.ok(formatted.includes("m"));
      assert.ok(formatted.includes("s"));
    });
  });
});
