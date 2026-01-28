/**
 * Diagnostic Workflow Runner
 *
 * Executes the 4-step diagnostic workflow:
 * 1. WHALE_BUY: Wait for whale signal, attempt BUY of 1 share
 * 2. WHALE_SELL: Attempt SELL of 1 share (same market)
 * 3. SCAN_BUY: Run market scan once, attempt BUY of 1 share
 * 4. SCAN_SELL: Attempt SELL of 1 share (same market)
 *
 * Then EXIT (do not resume normal operations).
 */

import type { ClobClient } from "@polymarket/clob-client";
import {
  DiagTracer,
  DiagModeConfig,
  DiagWorkflowResult,
  DiagStepResult,
  DiagStep,
  DiagReason,
  ghGroup,
  ghEndGroup,
  ghNotice,
  ghError,
  withTimeout,
  DiagTimeoutError,
  mapErrorToReason,
  parseDiagModeConfig,
  isGitHubActions,
} from "./diag-mode";
import { postOrder } from "./order";
import type { Logger } from "./types";
import { getPositions, invalidatePositions } from "./positions";
import { smartSell } from "./smart-sell";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Dependencies required by the diagnostic workflow
 */
export interface DiagWorkflowDeps {
  /** CLOB client for order execution */
  client: ClobClient;
  /** Wallet address */
  address: string;
  /** Logger instance */
  logger: Logger;
  /** Function to wait for whale signal with timeout */
  waitForWhaleSignal: (timeoutMs: number) => Promise<{
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    price?: number;
  } | null>;
  /** Function to run market scan once */
  runMarketScan: () => Promise<{
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    price?: number;
  } | null>;
  /** Function to get market data for a token */
  getMarketData?: (tokenId: string) => Promise<{
    bid?: number;
    ask?: number;
    mid?: number;
    spread?: number;
  } | null>;
}

/**
 * Context passed between diagnostic steps
 */
interface DiagContext {
  whaleBuy?: {
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    executedShares?: number;
  };
  scanBuy?: {
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    executedShares?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW RUNNER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the diagnostic workflow
 *
 * @param deps - Dependencies required for the workflow
 * @param config - Optional config override (defaults to env vars)
 * @returns Workflow result with trace events
 */
export async function runDiagWorkflow(
  deps: DiagWorkflowDeps,
  config?: DiagModeConfig,
): Promise<DiagWorkflowResult> {
  const cfg = config ?? parseDiagModeConfig();
  const tracer = new DiagTracer();
  const startTime = new Date();
  const ctx: DiagContext = {};
  const steps: DiagStepResult[] = [];

  console.log("");
  console.log("═".repeat(60));
  console.log("  🔬 DIAGNOSTIC MODE");
  console.log("═".repeat(60));
  console.log(`  Trace ID: ${tracer.getTraceId()}`);
  console.log(`  Whale Timeout: ${cfg.whaleTimeoutSec}s`);
  console.log(`  Order Timeout: ${cfg.orderTimeoutSec}s`);
  console.log(`  Force Shares: ${cfg.forceShares}`);
  console.log(`  GitHub Actions: ${isGitHubActions() ? "YES" : "NO"}`);
  console.log("═".repeat(60));
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1: WHALE_BUY
  // ─────────────────────────────────────────────────────────────────────────
  const whaleBuyResult = await runWhaleBuyStep(deps, cfg, tracer, ctx);
  steps.push(whaleBuyResult);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2: WHALE_SELL
  // ─────────────────────────────────────────────────────────────────────────
  const whaleSellResult = await runWhaleSellStep(deps, cfg, tracer, ctx);
  steps.push(whaleSellResult);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3: SCAN_BUY
  // ─────────────────────────────────────────────────────────────────────────
  const scanBuyResult = await runScanBuyStep(deps, cfg, tracer, ctx);
  steps.push(scanBuyResult);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: SCAN_SELL
  // ─────────────────────────────────────────────────────────────────────────
  const scanSellResult = await runScanSellStep(deps, cfg, tracer, ctx);
  steps.push(scanSellResult);

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();

  console.log("");
  console.log("═".repeat(60));
  console.log("  📊 DIAGNOSTIC SUMMARY");
  console.log("═".repeat(60));
  console.log(`  Trace ID: ${tracer.getTraceId()}`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log("");

  for (const step of steps) {
    const icon =
      step.result === "OK"
        ? "✅"
        : step.result === "SKIPPED"
          ? "⏭️"
          : step.result === "REJECTED"
            ? "🚫"
            : "❌";
    const reasonStr = step.reason ? ` (${step.reason})` : "";
    console.log(`  ${icon} ${step.step}: ${step.result}${reasonStr}`);
  }

  console.log("");
  console.log("═".repeat(60));
  console.log("");

  // Exit code: 0 for completed workflow, 1 only for uncaught errors
  // All steps completing (even with REJECTED/SKIPPED) is considered success
  const exitCode = 0;

  if (isGitHubActions()) {
    ghNotice(
      `Diagnostic workflow completed in ${(durationMs / 1000).toFixed(1)}s`,
    );
  }

  return {
    traceId: tracer.getTraceId(),
    startTime,
    endTime,
    steps,
    exitCode,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * STEP 1: WHALE_BUY
 * Wait for whale signal and attempt to buy 1 share
 */
async function runWhaleBuyStep(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  ctx: DiagContext,
): Promise<DiagStepResult> {
  const step: DiagStep = "WHALE_BUY";
  const groupTitle = `DIAG ${step} (trace: ${tracer.getTraceId().slice(0, 8)}...)`;

  ghGroup(groupTitle);

  tracer.trace({
    step,
    action: "step_started",
    result: "OK",
    detail: { whaleTimeoutSec: cfg.whaleTimeoutSec },
  });

  try {
    // Wait for whale signal with timeout
    console.log(
      `⏳ Waiting for whale signal (timeout: ${cfg.whaleTimeoutSec}s)...`,
    );

    const signal = await withTimeout(
      deps.waitForWhaleSignal(cfg.whaleTimeoutSec * 1000),
      cfg.whaleTimeoutSec * 1000,
      "timeout_waiting_for_whale",
    );

    if (!signal) {
      tracer.trace({
        step,
        action: "no_signal_received",
        result: "SKIPPED",
        reason: "timeout_waiting_for_whale",
      });

      ghEndGroup();
      return {
        step,
        result: "SKIPPED",
        reason: "timeout_waiting_for_whale",
        traceEvents: tracer.getStepEvents(step),
      };
    }

    tracer.trace({
      step,
      action: "signal_received",
      result: "OK",
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      outcomeLabel: signal.outcomeLabel,
      detail: { price: signal.price },
    });

    console.log(`🐋 Whale signal received: ${signal.tokenId?.slice(0, 16)}...`);

    // Attempt BUY order
    const buyResult = await attemptDiagBuy(deps, cfg, tracer, step, signal);

    if (buyResult.success) {
      ctx.whaleBuy = {
        tokenId: signal.tokenId,
        marketId: signal.marketId,
        outcomeLabel: signal.outcomeLabel,
        executedShares: cfg.forceShares,
      };

      ghEndGroup();
      return {
        step,
        result: "OK",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcomeLabel: signal.outcomeLabel,
        detail: buyResult.detail,
        traceEvents: tracer.getStepEvents(step),
      };
    }

    ghEndGroup();
    return {
      step,
      result: "REJECTED",
      reason: buyResult.reason,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      outcomeLabel: signal.outcomeLabel,
      detail: buyResult.detail,
      traceEvents: tracer.getStepEvents(step),
    };
  } catch (err) {
    const reason = mapErrorToReason(err);

    tracer.trace({
      step,
      action: "step_error",
      result: "ERROR",
      reason,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });

    ghError(`WHALE_BUY failed: ${reason}`);
    ghEndGroup();

    return {
      step,
      result: err instanceof DiagTimeoutError ? "SKIPPED" : "ERROR",
      reason,
      traceEvents: tracer.getStepEvents(step),
    };
  }
}

/**
 * STEP 2: WHALE_SELL
 * Attempt to sell 1 share from whale buy position
 */
async function runWhaleSellStep(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  ctx: DiagContext,
): Promise<DiagStepResult> {
  const step: DiagStep = "WHALE_SELL";
  const groupTitle = `DIAG ${step} (trace: ${tracer.getTraceId().slice(0, 8)}...)`;

  ghGroup(groupTitle);

  tracer.trace({
    step,
    action: "step_started",
    result: "OK",
  });

  // Check if whale buy was executed
  if (!ctx.whaleBuy) {
    tracer.trace({
      step,
      action: "skipped_no_buy",
      result: "SKIPPED",
      reason: "sell_skipped_no_buy",
    });

    console.log("⏭️ Skipping WHALE_SELL - no whale buy was executed");

    ghEndGroup();
    return {
      step,
      result: "SKIPPED",
      reason: "sell_skipped_no_buy",
      traceEvents: tracer.getStepEvents(step),
    };
  }

  try {
    const sellResult = await attemptDiagSell(
      deps,
      cfg,
      tracer,
      step,
      ctx.whaleBuy.tokenId,
      ctx.whaleBuy.marketId,
      ctx.whaleBuy.outcomeLabel,
    );

    ghEndGroup();

    if (sellResult.success) {
      return {
        step,
        result: "OK",
        marketId: ctx.whaleBuy.marketId,
        tokenId: ctx.whaleBuy.tokenId,
        outcomeLabel: ctx.whaleBuy.outcomeLabel,
        detail: sellResult.detail,
        traceEvents: tracer.getStepEvents(step),
      };
    }

    return {
      step,
      result: "REJECTED",
      reason: sellResult.reason,
      marketId: ctx.whaleBuy.marketId,
      tokenId: ctx.whaleBuy.tokenId,
      outcomeLabel: ctx.whaleBuy.outcomeLabel,
      detail: sellResult.detail,
      traceEvents: tracer.getStepEvents(step),
    };
  } catch (err) {
    const reason = mapErrorToReason(err);

    tracer.trace({
      step,
      action: "step_error",
      result: "ERROR",
      reason,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });

    ghError(`WHALE_SELL failed: ${reason}`);
    ghEndGroup();

    return {
      step,
      result: "ERROR",
      reason,
      marketId: ctx.whaleBuy.marketId,
      tokenId: ctx.whaleBuy.tokenId,
      traceEvents: tracer.getStepEvents(step),
    };
  }
}

/**
 * STEP 3: SCAN_BUY
 * Run market scan once and attempt to buy 1 share
 */
async function runScanBuyStep(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  ctx: DiagContext,
): Promise<DiagStepResult> {
  const step: DiagStep = "SCAN_BUY";
  const groupTitle = `DIAG ${step} (trace: ${tracer.getTraceId().slice(0, 8)}...)`;

  ghGroup(groupTitle);

  tracer.trace({
    step,
    action: "step_started",
    result: "OK",
  });

  try {
    // Run market scan once
    console.log("🔍 Running market scan...");

    const scanResult = await withTimeout(
      deps.runMarketScan(),
      cfg.orderTimeoutSec * 1000,
      "order_timeout",
    );

    if (!scanResult) {
      tracer.trace({
        step,
        action: "no_candidate_found",
        result: "SKIPPED",
        reason: "insufficient_liquidity",
      });

      console.log("⏭️ No eligible market found in scan");

      ghEndGroup();
      return {
        step,
        result: "SKIPPED",
        reason: "insufficient_liquidity",
        traceEvents: tracer.getStepEvents(step),
      };
    }

    tracer.trace({
      step,
      action: "candidate_found",
      result: "OK",
      marketId: scanResult.marketId,
      tokenId: scanResult.tokenId,
      outcomeLabel: scanResult.outcomeLabel,
      detail: { price: scanResult.price },
    });

    console.log(`📊 Scan candidate: ${scanResult.tokenId?.slice(0, 16)}...`);

    // Attempt BUY order
    const buyResult = await attemptDiagBuy(deps, cfg, tracer, step, scanResult);

    if (buyResult.success) {
      ctx.scanBuy = {
        tokenId: scanResult.tokenId,
        marketId: scanResult.marketId,
        outcomeLabel: scanResult.outcomeLabel,
        executedShares: cfg.forceShares,
      };

      ghEndGroup();
      return {
        step,
        result: "OK",
        marketId: scanResult.marketId,
        tokenId: scanResult.tokenId,
        outcomeLabel: scanResult.outcomeLabel,
        detail: buyResult.detail,
        traceEvents: tracer.getStepEvents(step),
      };
    }

    ghEndGroup();
    return {
      step,
      result: "REJECTED",
      reason: buyResult.reason,
      marketId: scanResult.marketId,
      tokenId: scanResult.tokenId,
      outcomeLabel: scanResult.outcomeLabel,
      detail: buyResult.detail,
      traceEvents: tracer.getStepEvents(step),
    };
  } catch (err) {
    const reason = mapErrorToReason(err);

    tracer.trace({
      step,
      action: "step_error",
      result: "ERROR",
      reason,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });

    ghError(`SCAN_BUY failed: ${reason}`);
    ghEndGroup();

    return {
      step,
      result: "ERROR",
      reason,
      traceEvents: tracer.getStepEvents(step),
    };
  }
}

/**
 * STEP 4: SCAN_SELL
 * Attempt to sell 1 share from scan buy position
 */
async function runScanSellStep(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  ctx: DiagContext,
): Promise<DiagStepResult> {
  const step: DiagStep = "SCAN_SELL";
  const groupTitle = `DIAG ${step} (trace: ${tracer.getTraceId().slice(0, 8)}...)`;

  ghGroup(groupTitle);

  tracer.trace({
    step,
    action: "step_started",
    result: "OK",
  });

  // Check if scan buy was executed
  if (!ctx.scanBuy) {
    tracer.trace({
      step,
      action: "skipped_no_buy",
      result: "SKIPPED",
      reason: "sell_skipped_no_buy",
    });

    console.log("⏭️ Skipping SCAN_SELL - no scan buy was executed");

    ghEndGroup();
    return {
      step,
      result: "SKIPPED",
      reason: "sell_skipped_no_buy",
      traceEvents: tracer.getStepEvents(step),
    };
  }

  try {
    const sellResult = await attemptDiagSell(
      deps,
      cfg,
      tracer,
      step,
      ctx.scanBuy.tokenId,
      ctx.scanBuy.marketId,
      ctx.scanBuy.outcomeLabel,
    );

    ghEndGroup();

    if (sellResult.success) {
      return {
        step,
        result: "OK",
        marketId: ctx.scanBuy.marketId,
        tokenId: ctx.scanBuy.tokenId,
        outcomeLabel: ctx.scanBuy.outcomeLabel,
        detail: sellResult.detail,
        traceEvents: tracer.getStepEvents(step),
      };
    }

    return {
      step,
      result: "REJECTED",
      reason: sellResult.reason,
      marketId: ctx.scanBuy.marketId,
      tokenId: ctx.scanBuy.tokenId,
      outcomeLabel: ctx.scanBuy.outcomeLabel,
      detail: sellResult.detail,
      traceEvents: tracer.getStepEvents(step),
    };
  } catch (err) {
    const reason = mapErrorToReason(err);

    tracer.trace({
      step,
      action: "step_error",
      result: "ERROR",
      reason,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });

    ghError(`SCAN_SELL failed: ${reason}`);
    ghEndGroup();

    return {
      step,
      result: "ERROR",
      reason,
      marketId: ctx.scanBuy.marketId,
      tokenId: ctx.scanBuy.tokenId,
      traceEvents: tracer.getStepEvents(step),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ORDER HELPERS
// ═══════════════════════════════════════════════════════════════════════════

interface DiagOrderResult {
  success: boolean;
  reason?: DiagReason;
  detail?: Record<string, unknown>;
}

/**
 * Attempt a diagnostic BUY order
 */
async function attemptDiagBuy(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  step: DiagStep,
  signal: {
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    price?: number;
  },
): Promise<DiagOrderResult> {
  tracer.trace({
    step,
    action: "buy_attempt_started",
    result: "OK",
    marketId: signal.marketId,
    tokenId: signal.tokenId,
    outcomeLabel: signal.outcomeLabel,
    detail: {
      forceShares: cfg.forceShares,
      price: signal.price,
    },
  });

  console.log(`📈 Attempting BUY of ${cfg.forceShares} share(s)...`);

  try {
    // Calculate USD value for 1 share at current price
    const price = signal.price ?? 0.5; // Default to 50¢ if no price
    const sizeUsd = cfg.forceShares * price;

    const result = await withTimeout(
      postOrder({
        client: deps.client,
        tokenId: signal.tokenId,
        outcome: (signal.outcomeLabel as "YES" | "NO") ?? "YES",
        side: "BUY",
        sizeUsd,
        marketId: signal.marketId,
        maxAcceptablePrice: price * 1.1, // Allow 10% slippage
        logger: deps.logger,
      }),
      cfg.orderTimeoutSec * 1000,
      "order_timeout",
    );

    if (result.success) {
      tracer.trace({
        step,
        action: "buy_executed",
        result: "OK",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcomeLabel: signal.outcomeLabel,
        detail: {
          orderId: result.orderId,
          filledUsd: result.filledUsd,
          avgPrice: result.avgPrice,
        },
      });

      console.log(
        `✅ BUY executed: $${result.filledUsd?.toFixed(4)} @ ${result.avgPrice?.toFixed(4)}`,
      );

      // Invalidate position cache so sell step can see the new position
      invalidatePositions();

      return {
        success: true,
        detail: {
          orderId: result.orderId,
          filledUsd: result.filledUsd,
          avgPrice: result.avgPrice,
        },
      };
    }

    // Order rejected
    const reason = mapOrderFailureReason(result.reason);

    tracer.trace({
      step,
      action: "buy_rejected",
      result: "REJECTED",
      reason,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      outcomeLabel: signal.outcomeLabel,
      detail: { orderReason: result.reason },
    });

    console.log(`🚫 BUY rejected: ${reason}`);

    return {
      success: false,
      reason,
      detail: { orderReason: result.reason },
    };
  } catch (err) {
    const reason = mapErrorToReason(err);

    tracer.trace({
      step,
      action: "buy_error",
      result: "ERROR",
      reason,
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });

    console.log(`❌ BUY error: ${reason}`);

    return {
      success: false,
      reason,
      detail: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Attempt a diagnostic SELL order
 */
async function attemptDiagSell(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  step: DiagStep,
  tokenId: string,
  marketId?: string,
  outcomeLabel?: string,
): Promise<DiagOrderResult> {
  tracer.trace({
    step,
    action: "sell_attempt_started",
    result: "OK",
    marketId,
    tokenId,
    outcomeLabel,
    detail: { forceShares: cfg.forceShares },
  });

  console.log(`📉 Attempting SELL of ${cfg.forceShares} share(s)...`);

  try {
    // First check if we have a position to sell
    const positions = await getPositions(deps.address, true);
    const position = positions.find((p) => p.tokenId === tokenId);

    if (!position || position.size < cfg.forceShares) {
      tracer.trace({
        step,
        action: "no_position",
        result: "SKIPPED",
        reason: "no_position_to_sell",
        marketId,
        tokenId,
        detail: { positionSize: position?.size ?? 0 },
      });

      console.log(`⏭️ No position to sell (size: ${position?.size ?? 0})`);

      return {
        success: false,
        reason: "no_position_to_sell",
        detail: { positionSize: position?.size ?? 0 },
      };
    }

    // Use smartSell for safer execution
    const result = await withTimeout(
      smartSell(deps.client, position, {
        maxSlippagePct: 10, // Allow 10% slippage in diag mode
        forceSell: true,
        logger: deps.logger,
      }),
      cfg.orderTimeoutSec * 1000,
      "order_timeout",
    );

    if (result.success) {
      tracer.trace({
        step,
        action: "sell_executed",
        result: "OK",
        marketId,
        tokenId,
        outcomeLabel,
        detail: {
          orderId: result.orderId,
          filledUsd: result.filledUsd,
          avgPrice: result.actualPrice ?? result.avgPrice,
        },
      });

      console.log(
        `✅ SELL executed: $${result.filledUsd?.toFixed(4)} @ ${(result.actualPrice ?? result.avgPrice)?.toFixed(4)}`,
      );

      // Invalidate position cache
      invalidatePositions();

      return {
        success: true,
        detail: {
          orderId: result.orderId,
          filledUsd: result.filledUsd,
          avgPrice: result.actualPrice ?? result.avgPrice,
        },
      };
    }

    // Order rejected
    const reason = mapOrderFailureReason(result.reason);

    tracer.trace({
      step,
      action: "sell_rejected",
      result: "REJECTED",
      reason,
      marketId,
      tokenId,
      outcomeLabel,
      detail: { orderReason: result.reason },
    });

    console.log(`🚫 SELL rejected: ${reason}`);

    return {
      success: false,
      reason,
      detail: { orderReason: result.reason },
    };
  } catch (err) {
    const reason = mapErrorToReason(err);

    tracer.trace({
      step,
      action: "sell_error",
      result: "ERROR",
      reason,
      marketId,
      tokenId,
      detail: { error: err instanceof Error ? err.message : String(err) },
    });

    console.log(`❌ SELL error: ${reason}`);

    return {
      success: false,
      reason,
      detail: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Map order failure reason string to DiagReason
 */
function mapOrderFailureReason(reason?: string): DiagReason {
  if (!reason) return "unknown_error";

  const lower = reason.toLowerCase();

  if (lower.includes("live trading") || lower.includes("simulation")) {
    return "no_wallet_credentials";
  }
  if (lower.includes("liquidity") || lower.includes("depth")) {
    return "insufficient_liquidity";
  }
  if (
    lower.includes("price") &&
    (lower.includes("range") || lower.includes("protection"))
  ) {
    return "price_out_of_range";
  }
  if (lower.includes("orderbook")) {
    return "orderbook_unavailable";
  }
  if (lower.includes("cooldown")) {
    return "cooldown_active";
  }
  if (lower.includes("risk")) {
    return "risk_limits_blocked";
  }
  if (lower.includes("timeout")) {
    return "order_timeout";
  }
  if (lower.includes("api") || lower.includes("network")) {
    return "api_error";
  }

  return "unknown_error";
}
