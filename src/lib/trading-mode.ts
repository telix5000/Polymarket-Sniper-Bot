/**
 * V2 Trading Mode - State machine for trading mode management
 *
 * Supports switching between NORMAL_MODE and LOW_LIQUIDITY_SCAVENGE_MODE
 * based on market conditions.
 */

import type { Logger } from "./types";

/**
 * Trading mode enum
 */
export enum TradingMode {
  NORMAL_MODE = "NORMAL_MODE",
  LOW_LIQUIDITY_SCAVENGE_MODE = "LOW_LIQUIDITY_SCAVENGE_MODE",
}

/**
 * Reason for mode transition
 */
export interface ModeTransitionReason {
  trigger: string;
  metrics: {
    volumeUsd?: number;
    volumeThreshold?: number;
    orderBookDepth?: number;
    depthThreshold?: number;
    activeTargets?: number;
    totalTargets?: number;
    staleDurationMs?: number;
    staleThresholdMs?: number;
  };
}

/**
 * Mode transition event
 */
export interface ModeTransition {
  from: TradingMode;
  to: TradingMode;
  reason: ModeTransitionReason;
  timestamp: number;
}

/**
 * Trading mode state
 */
export interface TradingModeState {
  currentMode: TradingMode;
  enteredAt: number;
  lastTransition?: ModeTransition;
  transitionHistory: ModeTransition[];
}

/**
 * Create initial trading mode state
 */
export function createTradingModeState(): TradingModeState {
  return {
    currentMode: TradingMode.NORMAL_MODE,
    enteredAt: Date.now(),
    transitionHistory: [],
  };
}

/**
 * Transition to a new trading mode
 */
export function transitionMode(
  state: TradingModeState,
  newMode: TradingMode,
  reason: ModeTransitionReason,
  logger?: Logger,
): TradingModeState {
  if (state.currentMode === newMode) {
    return state;
  }

  const transition: ModeTransition = {
    from: state.currentMode,
    to: newMode,
    reason,
    timestamp: Date.now(),
  };

  // Log the transition
  const metricsStr = Object.entries(reason.metrics)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : v}`)
    .join(", ");

  logger?.info?.(
    `🔄 MODE TRANSITION: ${state.currentMode} → ${newMode} | Trigger: ${reason.trigger} | ${metricsStr}`,
  );

  // Keep only last 100 transitions
  const history = [...state.transitionHistory, transition].slice(-100);

  return {
    currentMode: newMode,
    enteredAt: Date.now(),
    lastTransition: transition,
    transitionHistory: history,
  };
}

/**
 * Check if currently in scavenger mode
 */
export function isScavengerMode(state: TradingModeState): boolean {
  return state.currentMode === TradingMode.LOW_LIQUIDITY_SCAVENGE_MODE;
}

/**
 * Check if currently in normal mode
 */
export function isNormalMode(state: TradingModeState): boolean {
  return state.currentMode === TradingMode.NORMAL_MODE;
}

/**
 * Get time spent in current mode (ms)
 */
export function getTimeInCurrentMode(state: TradingModeState): number {
  return Date.now() - state.enteredAt;
}

/**
 * Format mode state for logging
 */
export function formatModeState(state: TradingModeState): string {
  const durationMs = getTimeInCurrentMode(state);
  const durationMin = Math.floor(durationMs / 60000);
  const durationSec = Math.floor((durationMs % 60000) / 1000);

  return `Mode: ${state.currentMode} (${durationMin}m ${durationSec}s)`;
}
