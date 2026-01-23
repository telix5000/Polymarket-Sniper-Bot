/**
 * Enterprise Trading System
 *
 * A complete, risk-managed trading system for Polymarket.
 *
 * Key features:
 * - Centralized RiskManager with circuit breakers and exposure limits
 * - MarketSelector for universe filtering (liquidity, spread, activity)
 * - ExecutionEngine with cooldown awareness and retry logic
 * - PnLLedger for deterministic accounting
 * - EnterpriseSmartHedge for capital-aware, non-blocking hedging
 * - Sequential orchestration (no stack issues)
 *
 * Usage:
 * ```typescript
 * import { createEnterpriseOrchestrator } from './enterprise';
 *
 * const orchestrator = createEnterpriseOrchestrator(clobClient, logger, 'balanced');
 * await orchestrator.start();
 * ```
 *
 * Configuration via ENV (all optional, sensible defaults):
 * - ENTERPRISE_MODE: "conservative" | "balanced" | "aggressive"
 * - MAX_EXPOSURE_USD: Total portfolio exposure limit
 * - MAX_DRAWDOWN_PCT: Max drawdown before circuit breaker
 * - MAX_SLIPPAGE_CENTS: Maximum acceptable slippage
 * - KILL_SWITCH_FILE: Path to kill switch file
 */

// Types
export * from "./types";

// Core components
export {
  RiskManager,
  createRiskManager,
  type RiskManagerConfig,
} from "./risk-manager";
export {
  MarketSelector,
  createMarketSelector,
  type MarketSelectorConfig,
  MARKET_SELECTOR_PRESETS,
} from "./market-selector";
export {
  ExecutionEngine,
  createExecutionEngine,
  type ExecutionEngineConfig,
  EXECUTION_PRESETS,
} from "./execution-engine";
export {
  PnLLedger,
  type Trade,
  type PositionPnL,
  type LedgerSummary,
} from "./pnl-ledger";

// Smart Hedge
export {
  EnterpriseSmartHedge,
  DEFAULT_SMART_HEDGE_CONFIG,
  loadSmartHedgeConfigFromEnv,
  type EnterpriseSmartHedgeConfig,
  type HedgeDecision,
  type HedgeReason,
  type HedgeOutcome,
  type MarketConditions,
} from "./smart-hedge";

// Configuration
export {
  loadEnterpriseConfig,
  formatEnterpriseConfig,
  ENTERPRISE_PRESETS,
  type EnterpriseMode,
  type EnterpriseSystemConfig,
} from "./config";

// Orchestrator
export {
  EnterpriseOrchestrator,
  createEnterpriseOrchestrator,
  type OrchestratorState,
} from "./orchestrator";
