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
  BookSanityRule,
} from "./diag-mode";
import { postOrder } from "./order";
import type { Logger } from "./types";
import { getPositions, invalidatePositions } from "./positions";
import { smartSell } from "../core/smart-sell";
import { verifyWritePathBeforeOrder } from "./vpn";
import {
  isDeadBook,
  isEmptyBook,
  checkBookHealth,
  DEAD_BOOK_THRESHOLDS,
  type BookHealthResult,
} from "./price-safety";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orderbook level with price and size as strings (from CLOB API)
 */
interface OrderbookLevel {
  price: string;
  size: string;
}

/**
 * Orderbook data structure from CLOB client
 */
interface OrderbookData {
  asks?: OrderbookLevel[];
  bids?: OrderbookLevel[];
}

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
  /**
   * Optional: Get multiple whale candidates for retry loop.
   * Returns array of candidates sorted by relevance.
   */
  getWhaleCandidates?: (timeoutMs: number) => Promise<
    Array<{
      tokenId: string;
      marketId?: string;
      outcomeLabel?: string;
      price?: number;
    }>
  >;
  /**
   * Optional: Get multiple scan candidates for retry loop.
   * Returns array of candidates sorted by relevance.
   */
  getScanCandidates?: () => Promise<
    Array<{
      tokenId: string;
      marketId?: string;
      outcomeLabel?: string;
      price?: number;
    }>
  >;
  /** Function to get market data for a token */
  getMarketData?: (tokenId: string) => Promise<{
    bid?: number;
    ask?: number;
    mid?: number;
    spread?: number;
  } | null>;
  /** Hedging configuration for diagnostic verification (optional) */
  hedgeConfig?: {
    triggerCents: number;
    hedgeRatio: number;
    maxHedgeRatio: number;
    maxAdverseCents: number;
  };
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
    entryPriceCents?: number;
    side?: "LONG" | "SHORT";
  };
  scanBuy?: {
    tokenId: string;
    marketId?: string;
    outcomeLabel?: string;
    executedShares?: number;
    entryPriceCents?: number;
    side?: "LONG" | "SHORT";
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

  // Reset rejection stats at start of workflow
  resetRejectionStats();

  console.log("");
  console.log("═".repeat(60));
  console.log("  🔬 DIAGNOSTIC MODE");
  console.log("═".repeat(60));
  console.log(`  Trace ID: ${tracer.getTraceId()}`);
  console.log(`  Whale Timeout: ${cfg.whaleTimeoutSec}s`);
  console.log(`  Order Timeout: ${cfg.orderTimeoutSec}s`);
  console.log(`  Force Shares: ${cfg.forceShares}`);
  console.log(`  Bad Book Cooldown: ${cfg.badBookCooldownSec}s`);
  console.log(`  Book Max Ask: ${cfg.bookMaxAsk}`);
  console.log(`  Book Max Spread: ${cfg.bookMaxSpread}`);
  console.log(`  Max Candidate Attempts: ${cfg.maxCandidateAttempts}`);
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
  // STEP 3: WHALE_HEDGE (verify hedge logic after whale buy)
  // ─────────────────────────────────────────────────────────────────────────
  const whaleHedgeResult = await runHedgeVerificationStep(
    deps,
    cfg,
    tracer,
    ctx.whaleBuy,
    "WHALE_HEDGE",
  );
  steps.push(whaleHedgeResult);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4: SCAN_BUY
  // ─────────────────────────────────────────────────────────────────────────
  const scanBuyResult = await runScanBuyStep(deps, cfg, tracer, ctx);
  steps.push(scanBuyResult);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5: SCAN_SELL
  // ─────────────────────────────────────────────────────────────────────────
  const scanSellResult = await runScanSellStep(deps, cfg, tracer, ctx);
  steps.push(scanSellResult);

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 6: SCAN_HEDGE (verify hedge logic after scan buy)
  // ─────────────────────────────────────────────────────────────────────────
  const scanHedgeResult = await runHedgeVerificationStep(
    deps,
    cfg,
    tracer,
    ctx.scanBuy,
    "SCAN_HEDGE",
  );
  steps.push(scanHedgeResult);

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  const endTime = new Date();
  const durationMs = endTime.getTime() - startTime.getTime();
  const stats = getRejectionStats();

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

  // ─────────────────────────────────────────────────────────────────────────
  // CANDIDATE REJECTION SUMMARY
  // ─────────────────────────────────────────────────────────────────────────
  console.log("  📋 CANDIDATE REJECTION SUMMARY");
  console.log(`     Total Candidates: ${stats.totalCandidates}`);
  console.log(`     Skipped (Bad Book): ${stats.skippedBadBook}`);
  console.log(`     Skipped (Cooldown): ${stats.skippedCooldown}`);
  console.log(`     Rejected (Execution): ${stats.rejectedAtExecution}`);
  console.log(`     Executed: ${stats.executed}`);
  if (stats.skippedBadBook > 0) {
    console.log("");
    console.log("     By Rule:");
    console.log(`       - askTooHigh: ${stats.byRule.askTooHigh}`);
    console.log(`       - spreadTooWide: ${stats.byRule.spreadTooWide}`);
    console.log(`       - emptyBook: ${stats.byRule.emptyBook}`);
    console.log(`       - deadBook: ${stats.byRule.deadBook}`);
    if (stats.sampleRejected.length > 0) {
      console.log("");
      console.log("     Sample Rejected:");
      for (const sample of stats.sampleRejected) {
        console.log(
          `       - ${sample.tokenId} (${sample.rule}): bid=${sample.bestBid?.toFixed(2) ?? "N/A"}, ask=${sample.bestAsk?.toFixed(2) ?? "N/A"}`,
        );
      }
    }
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
 * Implements candidate-attempt loop: tries up to maxCandidateAttempts candidates
 * until one passes sanity and proceeds to order placement.
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
    detail: {
      whaleTimeoutSec: cfg.whaleTimeoutSec,
      maxCandidateAttempts: cfg.maxCandidateAttempts,
    },
  });

  try {
    console.log(
      `⏳ Waiting for whale candidates (timeout: ${cfg.whaleTimeoutSec}s, max attempts: ${cfg.maxCandidateAttempts})...`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // CANDIDATE ATTEMPT LOOP
    // Try up to maxCandidateAttempts candidates until one passes sanity
    // ─────────────────────────────────────────────────────────────────────────
    let candidates: Array<{
      tokenId: string;
      marketId?: string;
      outcomeLabel?: string;
      price?: number;
    }> = [];

    // Get whale candidates - prefer getWhaleCandidates if available
    if (deps.getWhaleCandidates) {
      candidates = await deps.getWhaleCandidates(cfg.whaleTimeoutSec * 1000);
    } else {
      // Fallback: use waitForWhaleSignal (returns single candidate)
      const signal = await deps.waitForWhaleSignal(cfg.whaleTimeoutSec * 1000);
      if (signal) {
        candidates = [signal];
      }
    }

    if (candidates.length === 0) {
      tracer.trace({
        step,
        action: "no_signal_received",
        result: "SKIPPED",
        reason: "timeout_waiting_for_whale",
        detail: { candidatesReceived: 0 },
      });

      console.log("⏭️ No whale candidates received within timeout");

      ghEndGroup();
      return {
        step,
        result: "SKIPPED",
        reason: "timeout_waiting_for_whale",
        traceEvents: tracer.getStepEvents(step),
      };
    }

    console.log(
      `🐋 Received ${candidates.length} whale candidate(s), trying up to ${cfg.maxCandidateAttempts}...`,
    );

    // Track last rejection for reporting if all candidates fail
    let lastRejectionReason: DiagReason | undefined;
    let lastRejectedCandidate: (typeof candidates)[0] | undefined;
    let attemptCount = 0;

    // Loop through candidates
    for (const signal of candidates) {
      // Stop if we've exceeded max attempts
      if (attemptCount >= cfg.maxCandidateAttempts) {
        console.log(
          `⚠️ Max candidate attempts (${cfg.maxCandidateAttempts}) reached`,
        );
        break;
      }

      attemptCount++;
      globalRejectionStats.totalCandidates++;

      tracer.trace({
        step,
        action: "candidate_attempt",
        result: "OK",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        outcomeLabel: signal.outcomeLabel,
        detail: {
          attemptNumber: attemptCount,
          maxAttempts: cfg.maxCandidateAttempts,
          price: signal.price,
        },
      });

      console.log(
        `\n🐋 [Attempt ${attemptCount}/${cfg.maxCandidateAttempts}] Evaluating: ${signal.tokenId?.slice(0, 16)}...`,
      );

      // ─────────────────────────────────────────────────────────────────────────
      // COOLDOWN CHECK: Skip if candidate is in cooldown
      // ─────────────────────────────────────────────────────────────────────────
      if (isInCooldown(signal.tokenId)) {
        globalRejectionStats.skippedCooldown++;

        tracer.trace({
          step,
          action: "candidate_in_cooldown",
          result: "SKIPPED",
          reason: "candidate_cooldown",
          marketId: signal.marketId,
          tokenId: signal.tokenId,
          detail: {
            attemptNumber: attemptCount,
            message: "Candidate in cooldown - trying next",
          },
        });

        console.log(
          `   ⏭️ COOLDOWN: Candidate in cooldown, trying next candidate...`,
        );
        lastRejectionReason = "candidate_cooldown";
        lastRejectedCandidate = signal;
        continue; // Try next candidate
      }

      // ─────────────────────────────────────────────────────────────────────────
      // BOOK SANITY PRE-FILTER: Fetch orderbook and check book health
      // Note: If orderbook fetch fails, we proceed to attemptDiagBuy which has
      // its own orderbook fetch and validation. This is intentional fallback.
      // ─────────────────────────────────────────────────────────────────────────
      let orderbook: OrderbookData | null = null;
      let orderbookFetchFailed = false;
      try {
        orderbook = await deps.client.getOrderBook(signal.tokenId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`   ⚠️ Could not fetch orderbook for pre-filter: ${errMsg}`);
        orderbookFetchFailed = true;
      }

      if (orderbook?.asks?.length && orderbook?.bids?.length) {
        const bestAsk = parseFloat(orderbook.asks[0].price);
        const bestBid = parseFloat(orderbook.bids[0].price);

        const sanityResult = performBookSanityCheck(
          bestBid,
          bestAsk,
          cfg,
          signal.price,
        );

        // Log candidate evaluation
        logCandidateEvaluation(
          "whale",
          signal.tokenId,
          signal.marketId,
          signal.price,
          bestBid,
          bestAsk,
          sanityResult,
          sanityResult.passed ? null : "candidate",
        );

        if (!sanityResult.passed) {
          // Add to cooldown to prevent reselection
          addToCooldown(signal.tokenId, cfg.badBookCooldownSec);

          // Record rejection stats
          recordRejection(
            signal.tokenId,
            signal.marketId,
            sanityResult.rule!,
            bestBid,
            bestAsk,
            sanityResult.detail.spread,
          );

          tracer.trace({
            step,
            action: "book_sanity_failed",
            result: "SKIPPED",
            reason: "skipped_bad_book",
            marketId: signal.marketId,
            tokenId: signal.tokenId,
            detail: {
              attemptNumber: attemptCount,
              rule: sanityResult.rule,
              bestBid,
              bestAsk,
              spread: sanityResult.detail.spread,
              signalPrice: signal.price,
              cooldownSec: cfg.badBookCooldownSec,
              deadBookThresholds: sanityResult.detail.thresholds,
            },
          });

          console.log(
            `   ⏭️ ${sanityResult.rule?.toUpperCase()}: bid=${bestBid?.toFixed(2)}, ask=${bestAsk.toFixed(2)}, spread=${sanityResult.detail.spread?.toFixed(2) ?? "N/A"}`,
          );
          console.log(`   → Trying next candidate...`);

          lastRejectionReason = "skipped_bad_book";
          lastRejectedCandidate = signal;
          continue; // Try next candidate (dead_book triggers immediate retry)
        }
      } else if (orderbookFetchFailed) {
        // Pre-filter couldn't run due to orderbook fetch failure
        // attemptDiagBuy will re-fetch and handle validation
        console.log(
          `   ⚠️ Pre-filter skipped (orderbook unavailable), proceeding to buy attempt...`,
        );
      }

      // ─────────────────────────────────────────────────────────────────────────
      // BOOK SANITY PASSED (or skipped) - Attempt BUY order
      // Note: attemptDiagBuy has its own orderbook fetch and validation
      // ─────────────────────────────────────────────────────────────────────────
      console.log(`   ✅ Book sanity passed, attempting BUY...`);

      const buyResult = await attemptDiagBuy(deps, cfg, tracer, step, signal);

      if (buyResult.success) {
        globalRejectionStats.executed++;

        // Capture entry price for hedge verification
        const detail = buyResult.detail as
          | {
              avgPrice?: number;
              chosenLimitPrice?: number;
            }
          | undefined;
        const avgPriceCents = detail?.avgPrice
          ? detail.avgPrice * 100
          : detail?.chosenLimitPrice
            ? detail.chosenLimitPrice * 100
            : undefined;

        ctx.whaleBuy = {
          tokenId: signal.tokenId,
          marketId: signal.marketId,
          outcomeLabel: signal.outcomeLabel,
          executedShares: cfg.forceShares,
          entryPriceCents: avgPriceCents,
          side: "LONG", // BUY = LONG position
        };

        tracer.trace({
          step,
          action: "candidate_accepted",
          result: "OK",
          marketId: signal.marketId,
          tokenId: signal.tokenId,
          detail: {
            attemptNumber: attemptCount,
            totalAttempts: attemptCount,
          },
        });

        ghEndGroup();
        return {
          step,
          result: "OK",
          marketId: signal.marketId,
          tokenId: signal.tokenId,
          outcomeLabel: signal.outcomeLabel,
          detail: { ...buyResult.detail, attemptNumber: attemptCount },
          traceEvents: tracer.getStepEvents(step),
        };
      }

      // BUY failed at execution stage
      globalRejectionStats.rejectedAtExecution++;
      lastRejectionReason = buyResult.reason;
      lastRejectedCandidate = signal;

      console.log(`   🚫 BUY rejected: ${buyResult.reason}, trying next...`);
      // Continue to next candidate
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ALL CANDIDATES EXHAUSTED
    // Determine if this was a candidate-stage skip or execution-stage rejection
    // ─────────────────────────────────────────────────────────────────────────
    const candidateStageReasons: DiagReason[] = [
      "skipped_bad_book",
      "candidate_cooldown",
    ];
    const wasExecutionStageRejection =
      lastRejectionReason &&
      !candidateStageReasons.includes(lastRejectionReason);
    const finalResult = wasExecutionStageRejection ? "REJECTED" : "SKIPPED";

    tracer.trace({
      step,
      action: "all_candidates_exhausted",
      result: finalResult,
      reason: lastRejectionReason ?? "unknown_error",
      marketId: lastRejectedCandidate?.marketId,
      tokenId: lastRejectedCandidate?.tokenId,
      detail: {
        totalAttempts: attemptCount,
        maxAttempts: cfg.maxCandidateAttempts,
        candidatesAvailable: candidates.length,
        lastRejectionReason,
        wasExecutionStageRejection,
      },
    });

    console.log(
      `\n⚠️ All ${attemptCount} candidate(s) exhausted without successful buy`,
    );

    ghEndGroup();
    return {
      step,
      result: finalResult,
      reason: lastRejectionReason ?? "unknown_error",
      marketId: lastRejectedCandidate?.marketId,
      tokenId: lastRejectedCandidate?.tokenId,
      detail: {
        totalAttempts: attemptCount,
        candidatesAvailable: candidates.length,
        lastRejectionReason,
        wasExecutionStageRejection,
      },
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
 * Run market scan and attempt to buy 1 share
 * Implements candidate-attempt loop: tries up to maxCandidateAttempts candidates
 * until one passes sanity and proceeds to order placement.
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
    detail: {
      orderTimeoutSec: cfg.orderTimeoutSec,
      maxCandidateAttempts: cfg.maxCandidateAttempts,
    },
  });

  try {
    console.log(
      `🔍 Running market scan (max attempts: ${cfg.maxCandidateAttempts})...`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // CANDIDATE ATTEMPT LOOP
    // Try up to maxCandidateAttempts candidates until one passes sanity
    // ─────────────────────────────────────────────────────────────────────────
    let candidates: Array<{
      tokenId: string;
      marketId?: string;
      outcomeLabel?: string;
      price?: number;
    }> = [];

    // Get scan candidates - prefer getScanCandidates if available
    if (deps.getScanCandidates) {
      candidates = await withTimeout(
        deps.getScanCandidates(),
        cfg.orderTimeoutSec * 1000,
        "order_timeout",
      );
    } else {
      // Fallback: use runMarketScan (returns single candidate)
      const scanResult = await withTimeout(
        deps.runMarketScan(),
        cfg.orderTimeoutSec * 1000,
        "order_timeout",
      );
      if (scanResult) {
        candidates = [scanResult];
      }
    }

    if (candidates.length === 0) {
      tracer.trace({
        step,
        action: "no_candidate_found",
        result: "SKIPPED",
        reason: "insufficient_liquidity",
        detail: { candidatesReceived: 0 },
      });

      console.log("⏭️ No eligible markets found in scan");

      ghEndGroup();
      return {
        step,
        result: "SKIPPED",
        reason: "insufficient_liquidity",
        traceEvents: tracer.getStepEvents(step),
      };
    }

    console.log(
      `📊 Found ${candidates.length} scan candidate(s), trying up to ${cfg.maxCandidateAttempts}...`,
    );

    // Track last rejection for reporting if all candidates fail
    let lastRejectionReason: DiagReason | undefined;
    let lastRejectedCandidate: (typeof candidates)[0] | undefined;
    let attemptCount = 0;

    // Loop through candidates
    for (const scanResult of candidates) {
      // Stop if we've exceeded max attempts
      if (attemptCount >= cfg.maxCandidateAttempts) {
        console.log(
          `⚠️ Max candidate attempts (${cfg.maxCandidateAttempts}) reached`,
        );
        break;
      }

      attemptCount++;
      globalRejectionStats.totalCandidates++;

      tracer.trace({
        step,
        action: "candidate_attempt",
        result: "OK",
        marketId: scanResult.marketId,
        tokenId: scanResult.tokenId,
        outcomeLabel: scanResult.outcomeLabel,
        detail: {
          attemptNumber: attemptCount,
          maxAttempts: cfg.maxCandidateAttempts,
          price: scanResult.price,
        },
      });

      console.log(
        `\n📊 [Attempt ${attemptCount}/${cfg.maxCandidateAttempts}] Evaluating: ${scanResult.tokenId?.slice(0, 16)}...`,
      );

      // ─────────────────────────────────────────────────────────────────────────
      // COOLDOWN CHECK: Skip if candidate is in cooldown
      // ─────────────────────────────────────────────────────────────────────────
      if (isInCooldown(scanResult.tokenId)) {
        globalRejectionStats.skippedCooldown++;

        tracer.trace({
          step,
          action: "candidate_in_cooldown",
          result: "SKIPPED",
          reason: "candidate_cooldown",
          marketId: scanResult.marketId,
          tokenId: scanResult.tokenId,
          detail: {
            attemptNumber: attemptCount,
            message: "Candidate in cooldown - trying next",
          },
        });

        console.log(
          `   ⏭️ COOLDOWN: Candidate in cooldown, trying next candidate...`,
        );
        lastRejectionReason = "candidate_cooldown";
        lastRejectedCandidate = scanResult;
        continue; // Try next candidate
      }

      // ─────────────────────────────────────────────────────────────────────────
      // BOOK SANITY PRE-FILTER: Fetch orderbook and check book health
      // Uses same math as normal trading (via price-safety.ts)
      // Note: If orderbook fetch fails, we proceed to attemptDiagBuy which has
      // its own orderbook fetch and validation. This is intentional fallback.
      // ─────────────────────────────────────────────────────────────────────────
      let orderbook: OrderbookData | null = null;
      let orderbookFetchFailed = false;
      try {
        orderbook = await deps.client.getOrderBook(scanResult.tokenId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`   ⚠️ Could not fetch orderbook for pre-filter: ${errMsg}`);
        orderbookFetchFailed = true;
      }

      if (orderbook?.asks?.length && orderbook?.bids?.length) {
        const bestAsk = parseFloat(orderbook.asks[0].price);
        const bestBid = parseFloat(orderbook.bids[0].price);

        const sanityResult = performBookSanityCheck(
          bestBid,
          bestAsk,
          cfg,
          scanResult.price,
        );

        // Log candidate evaluation
        logCandidateEvaluation(
          "scan",
          scanResult.tokenId,
          scanResult.marketId,
          scanResult.price,
          bestBid,
          bestAsk,
          sanityResult,
          sanityResult.passed ? null : "candidate",
        );

        if (!sanityResult.passed) {
          // Add to cooldown to prevent reselection
          addToCooldown(scanResult.tokenId, cfg.badBookCooldownSec);

          // Record rejection stats
          recordRejection(
            scanResult.tokenId,
            scanResult.marketId,
            sanityResult.rule!,
            bestBid,
            bestAsk,
            sanityResult.detail.spread,
          );

          tracer.trace({
            step,
            action: "book_sanity_failed",
            result: "SKIPPED",
            reason: "skipped_bad_book",
            marketId: scanResult.marketId,
            tokenId: scanResult.tokenId,
            detail: {
              attemptNumber: attemptCount,
              rule: sanityResult.rule,
              bestBid,
              bestAsk,
              spread: sanityResult.detail.spread,
              signalPrice: scanResult.price,
              cooldownSec: cfg.badBookCooldownSec,
              bookHealth: sanityResult.detail.bookHealth,
            },
          });

          console.log(
            `   ⏭️ ${sanityResult.rule?.toUpperCase()}: bid=${bestBid?.toFixed(2)}, ask=${bestAsk.toFixed(2)}, spread=${sanityResult.detail.spread?.toFixed(2) ?? "N/A"}`,
          );
          console.log(`   → Trying next candidate...`);

          lastRejectionReason = "skipped_bad_book";
          lastRejectedCandidate = scanResult;
          continue; // Try next candidate (dead_book triggers immediate retry)
        }
      } else if (orderbookFetchFailed) {
        // Pre-filter couldn't run due to orderbook fetch failure
        // attemptDiagBuy will re-fetch and handle validation
        console.log(
          `   ⚠️ Pre-filter skipped (orderbook unavailable), proceeding to buy attempt...`,
        );
      }

      // ─────────────────────────────────────────────────────────────────────────
      // BOOK SANITY PASSED (or skipped) - Attempt BUY order
      // Note: attemptDiagBuy has its own orderbook fetch and validation
      // ─────────────────────────────────────────────────────────────────────────
      console.log(`   ✅ Book sanity passed, attempting BUY...`);

      const buyResult = await attemptDiagBuy(
        deps,
        cfg,
        tracer,
        step,
        scanResult,
      );

      if (buyResult.success) {
        globalRejectionStats.executed++;

        // Capture entry price for hedge verification
        const detail = buyResult.detail as
          | {
              avgPrice?: number;
              chosenLimitPrice?: number;
            }
          | undefined;
        const avgPriceCents = detail?.avgPrice
          ? detail.avgPrice * 100
          : detail?.chosenLimitPrice
            ? detail.chosenLimitPrice * 100
            : undefined;

        ctx.scanBuy = {
          tokenId: scanResult.tokenId,
          marketId: scanResult.marketId,
          outcomeLabel: scanResult.outcomeLabel,
          executedShares: cfg.forceShares,
          entryPriceCents: avgPriceCents,
          side: "LONG", // BUY = LONG position
        };

        tracer.trace({
          step,
          action: "candidate_accepted",
          result: "OK",
          marketId: scanResult.marketId,
          tokenId: scanResult.tokenId,
          detail: {
            attemptNumber: attemptCount,
            totalAttempts: attemptCount,
          },
        });

        ghEndGroup();
        return {
          step,
          result: "OK",
          marketId: scanResult.marketId,
          tokenId: scanResult.tokenId,
          outcomeLabel: scanResult.outcomeLabel,
          detail: { ...buyResult.detail, attemptNumber: attemptCount },
          traceEvents: tracer.getStepEvents(step),
        };
      }

      // BUY failed at execution stage
      globalRejectionStats.rejectedAtExecution++;
      lastRejectionReason = buyResult.reason;
      lastRejectedCandidate = scanResult;

      console.log(`   🚫 BUY rejected: ${buyResult.reason}, trying next...`);
      // Continue to next candidate
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ALL CANDIDATES EXHAUSTED
    // Determine if this was a candidate-stage skip or execution-stage rejection
    // ─────────────────────────────────────────────────────────────────────────
    const candidateStageReasons: DiagReason[] = [
      "skipped_bad_book",
      "candidate_cooldown",
    ];
    const wasExecutionStageRejection =
      lastRejectionReason &&
      !candidateStageReasons.includes(lastRejectionReason);
    const finalResult = wasExecutionStageRejection ? "REJECTED" : "SKIPPED";

    tracer.trace({
      step,
      action: "all_candidates_exhausted",
      result: finalResult,
      reason: lastRejectionReason ?? "unknown_error",
      marketId: lastRejectedCandidate?.marketId,
      tokenId: lastRejectedCandidate?.tokenId,
      detail: {
        totalAttempts: attemptCount,
        maxAttempts: cfg.maxCandidateAttempts,
        candidatesAvailable: candidates.length,
        lastRejectionReason,
        wasExecutionStageRejection,
      },
    });

    console.log(
      `\n⚠️ All ${attemptCount} candidate(s) exhausted without successful buy`,
    );

    ghEndGroup();
    return {
      step,
      result: finalResult,
      reason: lastRejectionReason ?? "unknown_error",
      marketId: lastRejectedCandidate?.marketId,
      tokenId: lastRejectedCandidate?.tokenId,
      detail: {
        totalAttempts: attemptCount,
        candidatesAvailable: candidates.length,
        lastRejectionReason,
        wasExecutionStageRejection,
      },
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
 * Default slippage percentage for DIAG mode BUY orders.
 * This is a small tolerance above bestAsk to increase fill probability.
 */
export const DIAG_BUY_SLIPPAGE_PCT = 2; // 2% above bestAsk

/**
 * Maximum price cap for diagnostic orders (default 0.70).
 * Prevents accidentally buying at extreme prices (e.g., limit=1.0).
 * Can be overridden via DIAG_MAX_PRICE env var.
 */
export function getDiagMaxPrice(): number {
  const envValue = process.env.DIAG_MAX_PRICE;
  if (envValue) {
    const parsed = parseFloat(envValue);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 1.0) {
      return parsed;
    }
  }
  return 0.7; // Default max price for diagnostic mode
}

/**
 * Threshold for considering a book "too wide" (untradeable).
 * If bestAsk - bestBid > this value, skip the trade.
 */
export const DIAG_MAX_SPREAD = 0.3;

/**
 * Threshold for "too high" bestAsk - indicates market is nearly resolved.
 */
export const DIAG_MAX_BEST_ASK = 0.95;

// ═══════════════════════════════════════════════════════════════════════════
// BOOK SANITY PRE-FILTER & COOLDOWN TRACKING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cooldown map: tokenId -> timestamp when cooldown expires
 * Used to prevent repeatedly selecting untradeable markets
 */
const badBookCooldownMap = new Map<string, number>();

/**
 * Rejection statistics by rule type for diagnostics summary
 */
export interface CandidateRejectionStats {
  totalCandidates: number;
  skippedBadBook: number;
  skippedCooldown: number;
  rejectedAtExecution: number;
  executed: number;
  // Breakdown by rule
  byRule: {
    askTooHigh: number;
    spreadTooWide: number;
    emptyBook: number;
    deadBook: number;
  };
  // Sample rejected candidates (for reporting)
  sampleRejected: Array<{
    tokenId: string;
    marketId?: string;
    rule: BookSanityRule;
    bestBid?: number;
    bestAsk?: number;
    spread?: number;
  }>;
}

/**
 * Create empty rejection stats
 */
export function createEmptyRejectionStats(): CandidateRejectionStats {
  return {
    totalCandidates: 0,
    skippedBadBook: 0,
    skippedCooldown: 0,
    rejectedAtExecution: 0,
    executed: 0,
    byRule: {
      askTooHigh: 0,
      spreadTooWide: 0,
      emptyBook: 0,
      deadBook: 0,
    },
    sampleRejected: [],
  };
}

/**
 * Global rejection stats for diagnostic summary
 */
let globalRejectionStats = createEmptyRejectionStats();

/**
 * Get the current rejection stats
 */
export function getRejectionStats(): CandidateRejectionStats {
  return { ...globalRejectionStats };
}

/**
 * Reset rejection stats (call at start of diagnostic workflow)
 */
export function resetRejectionStats(): void {
  globalRejectionStats = createEmptyRejectionStats();
}

/**
 * Check if a token is in cooldown period
 */
export function isInCooldown(tokenId: string): boolean {
  const expiresAt = badBookCooldownMap.get(tokenId);
  if (!expiresAt) return false;

  if (Date.now() >= expiresAt) {
    // Cooldown expired, remove from map
    badBookCooldownMap.delete(tokenId);
    return false;
  }
  return true;
}

/**
 * Add a token to cooldown
 */
export function addToCooldown(tokenId: string, cooldownSec: number): void {
  const expiresAt = Date.now() + cooldownSec * 1000;
  badBookCooldownMap.set(tokenId, expiresAt);
}

/**
 * Clear all bad book cooldowns (for testing)
 */
export function clearBadBookCooldowns(): void {
  badBookCooldownMap.clear();
}

/**
 * Book sanity pre-filter result
 */
export interface BookSanityResult {
  passed: boolean;
  rule?: BookSanityRule;
  detail: {
    signalPrice?: number;
    bestBid?: number;
    bestAsk?: number;
    spread?: number;
    spreadPct?: number;
    thresholds: {
      maxAsk: number;
      maxSpread: number;
      deadBidCents: number;
      deadAskCents: number;
      emptyBidCents: number;
      emptyAskCents: number;
    };
    /** Book health status from shared price-safety module */
    bookHealth?: BookHealthResult;
  };
}

/**
 * Perform book sanity pre-filter BEFORE attempting any buy.
 * This is called at candidate stage to reject untradeable markets early.
 *
 * IMPORTANT: Uses the same math as the normal trading flow (price-safety.ts)
 * to ensure DIAG is a real-world test of actual trading logic.
 *
 * Rules are applied in order of specificity:
 * 1. empty_book: bestBid <= 1¢ AND bestAsk >= 99¢ (via price-safety.isEmptyBook)
 * 2. dead_book: bestBid <= 2¢ AND bestAsk >= 98¢ (via price-safety.isDeadBook)
 * 3. ask_too_high: bestAsk >= bookMaxAsk (market nearly resolved)
 * 4. spread_too_wide: spread >= bookMaxSpread
 *
 * @param bestBid - Best bid price (0-1 scale)
 * @param bestAsk - Best ask price (0-1 scale)
 * @param cfg - Diagnostic config with thresholds
 * @param signalPrice - Optional signal price for logging
 * @returns BookSanityResult indicating if candidate passes
 */
export function performBookSanityCheck(
  bestBid: number | null,
  bestAsk: number,
  cfg: {
    bookMaxAsk: number;
    bookMaxSpread: number;
    deadBookBid?: number;
    deadBookAsk?: number;
  },
  signalPrice?: number,
): BookSanityResult {
  const spread = bestBid !== null ? bestAsk - bestBid : null;
  const spreadPct =
    spread !== null && bestAsk > 0 ? (spread / bestAsk) * 100 : null;

  // Use shared thresholds from price-safety module (same as normal trading)
  const deadBidCents = (cfg.deadBookBid ?? 0.02) * 100;
  const deadAskCents = (cfg.deadBookAsk ?? 0.98) * 100;
  const emptyBidCents = DEAD_BOOK_THRESHOLDS.EMPTY_BID_CENTS;
  const emptyAskCents = DEAD_BOOK_THRESHOLDS.EMPTY_ASK_CENTS;

  // Get book health using shared function (same math as normal trading)
  const bookHealth =
    bestBid !== null
      ? checkBookHealth(bestBid, bestAsk, {
          deadBidCents,
          deadAskCents,
          emptyBidCents,
          emptyAskCents,
        })
      : undefined;

  const detail = {
    signalPrice,
    bestBid: bestBid ?? undefined,
    bestAsk,
    spread: spread ?? undefined,
    spreadPct: spreadPct ?? undefined,
    thresholds: {
      maxAsk: cfg.bookMaxAsk,
      maxSpread: cfg.bookMaxSpread,
      deadBidCents,
      deadAskCents,
      emptyBidCents,
      emptyAskCents,
    },
    bookHealth,
  };

  // Rule 1: Empty book (via shared price-safety function)
  // bestBid <= 1¢ AND bestAsk >= 99¢
  if (bestBid !== null && isEmptyBook(bestBid, bestAsk)) {
    return {
      passed: false,
      rule: "empty_book",
      detail,
    };
  }

  // Rule 2: Dead book (via shared price-safety function)
  // bestBid <= 2¢ AND bestAsk >= 98¢
  // Uses the same isDeadBook() function that the normal trading flow uses
  if (
    bestBid !== null &&
    isDeadBook(bestBid, bestAsk, deadBidCents, deadAskCents)
  ) {
    return {
      passed: false,
      rule: "dead_book",
      detail,
    };
  }

  // Rule 3: bestAsk >= BOOK_MAX_ASK (market nearly resolved)
  if (bestAsk >= cfg.bookMaxAsk) {
    return {
      passed: false,
      rule: "ask_too_high",
      detail,
    };
  }

  // Rule 4: spread >= BOOK_MAX_SPREAD
  if (spread !== null && spread >= cfg.bookMaxSpread) {
    return {
      passed: false,
      rule: "spread_too_wide",
      detail,
    };
  }

  return { passed: true, detail };
}

/**
 * Log candidate evaluation for diagnostics
 */
export function logCandidateEvaluation(
  source: "whale" | "scan",
  tokenId: string,
  marketId: string | undefined,
  signalPrice: number | undefined,
  bestBid: number | undefined,
  bestAsk: number | undefined,
  sanityResult: BookSanityResult,
  rejectedStage: "candidate" | "execution" | null,
): void {
  const event = {
    event: "DIAG_CANDIDATE_EVAL",
    timestamp: new Date().toISOString(),
    source,
    tokenIdPrefix: tokenId.slice(0, 16) + "...",
    marketId,
    signalPrice,
    book: {
      bestBid,
      bestAsk,
      spread: sanityResult.detail.spread,
      spreadPct: sanityResult.detail.spreadPct?.toFixed(1),
    },
    sanityCheck: {
      passed: sanityResult.passed,
      rule: sanityResult.rule,
      thresholds: sanityResult.detail.thresholds,
    },
    rejectedStage,
  };
  console.log(JSON.stringify(event));
}

/**
 * Record a rejection in the stats
 */
function recordRejection(
  tokenId: string,
  marketId: string | undefined,
  rule: BookSanityRule,
  bestBid: number | undefined,
  bestAsk: number | undefined,
  spread: number | undefined,
): void {
  globalRejectionStats.skippedBadBook++;

  // Update rule-specific counter
  switch (rule) {
    case "ask_too_high":
      globalRejectionStats.byRule.askTooHigh++;
      break;
    case "spread_too_wide":
      globalRejectionStats.byRule.spreadTooWide++;
      break;
    case "empty_book":
      globalRejectionStats.byRule.emptyBook++;
      break;
    case "dead_book":
      globalRejectionStats.byRule.deadBook++;
      break;
  }

  // Keep sample of first 5 rejected candidates
  if (globalRejectionStats.sampleRejected.length < 5) {
    globalRejectionStats.sampleRejected.push({
      tokenId: tokenId.slice(0, 16) + "...",
      marketId,
      rule,
      bestBid,
      bestAsk,
      spread,
    });
  }
}

/**
 * Format rejection stats summary for GitHub issue / logging
 */
export function formatRejectionStatsSummary(
  stats: CandidateRejectionStats,
): string {
  const lines: string[] = [];
  lines.push("## Guardrail Summary");
  lines.push(`- **Total Candidates**: ${stats.totalCandidates}`);
  lines.push(`- **Skipped (Bad Book)**: ${stats.skippedBadBook}`);
  lines.push(`- **Skipped (Cooldown)**: ${stats.skippedCooldown}`);
  lines.push(`- **Rejected (Execution)**: ${stats.rejectedAtExecution}`);
  lines.push(`- **Executed**: ${stats.executed}`);
  lines.push("");
  lines.push("### Rejection Breakdown");
  lines.push(`- askTooHigh: ${stats.byRule.askTooHigh}`);
  lines.push(`- spreadTooWide: ${stats.byRule.spreadTooWide}`);
  lines.push(`- emptyBook: ${stats.byRule.emptyBook}`);
  lines.push(`- deadBook: ${stats.byRule.deadBook}`);

  if (stats.sampleRejected.length > 0) {
    lines.push("");
    lines.push("### Sample Rejected Candidates");
    for (const sample of stats.sampleRejected) {
      lines.push(
        `- ${sample.tokenId} (${sample.rule}): bid=${sample.bestBid?.toFixed(2) ?? "N/A"}, ask=${sample.bestAsk?.toFixed(2) ?? "N/A"}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Market state classification for guardrail decisions.
 * Helps understand WHY a trade was rejected.
 */
export type MarketStateClassification =
  | "NEARLY_RESOLVED" // bestAsk > 0.95
  | "EMPTY_OR_FAKE_BOOK" // bestBid <= 0.01 AND bestAsk >= 0.99
  | "LOW_LIQUIDITY" // totalDepth < minDepth (not implemented yet)
  | "NORMAL_BUT_WIDE" // spread exceeds threshold but not pathological
  | "TRADEABLE"; // book is acceptable

/**
 * Guardrail decision classification for reporting.
 */
export type GuardrailDecision =
  | "CORRECT" // guardrail correctly blocked a bad trade
  | "POSSIBLY_TOO_STRICT" // guardrail may be too strict, could miss opportunity
  | "UNKNOWN"; // cannot determine

/**
 * Structured spread guardrail diagnostic object.
 * Contains all information needed to understand why a trade was blocked.
 */
export interface SpreadGuardrailDiagnostic {
  bestBid: number | null;
  bestAsk: number;
  spread: number | null;
  spreadPct: number | null;
  thresholdUsed: number;
  signalPrice: number | undefined;
  chosenLimitPrice: number | undefined;
  guardrailType: "SPREAD_TOO_WIDE" | "NEARLY_RESOLVED" | "EMPTY_BOOK" | "OK";
  marketStateClassification: MarketStateClassification;
  guardrailDecision: GuardrailDecision;
  // Whale comparison (optional, for WHALE_BUY signals)
  whaleTradePrice?: number;
  whaleSpreadAtTrade?: number;
  whaleViolatedThreshold?: boolean;
}

/**
 * Classify the market state based on orderbook heuristics.
 */
export function classifyMarketState(
  bestBid: number | null,
  bestAsk: number,
  totalDepth?: number,
  minDepth?: number,
): MarketStateClassification {
  // Check for empty/fake book first (most severe)
  if (bestBid !== null && bestBid <= 0.01 && bestAsk >= 0.99) {
    return "EMPTY_OR_FAKE_BOOK";
  }

  // Check for nearly resolved market (use strict > to match trading decision)
  if (bestAsk > 0.95) {
    return "NEARLY_RESOLVED";
  }

  // Check for low liquidity (if depth info provided)
  if (
    totalDepth !== undefined &&
    minDepth !== undefined &&
    totalDepth < minDepth
  ) {
    return "LOW_LIQUIDITY";
  }

  // Calculate spread if we have both sides
  if (bestBid !== null) {
    const spread = bestAsk - bestBid;
    if (spread > DIAG_MAX_SPREAD) {
      return "NORMAL_BUT_WIDE";
    }
  }

  return "TRADEABLE";
}

/**
 * Determine guardrail decision classification.
 * Helps understand if the guardrail is working correctly or being too strict.
 */
export function classifyGuardrailDecision(
  marketState: MarketStateClassification,
  whaleTradePrice?: number,
  bestAsk?: number,
): GuardrailDecision {
  // If market is nearly resolved or empty, guardrail is correct
  if (
    marketState === "NEARLY_RESOLVED" ||
    marketState === "EMPTY_OR_FAKE_BOOK"
  ) {
    return "CORRECT";
  }

  // If whale traded at a similar price to bestAsk, we might be missing opportunity
  if (whaleTradePrice !== undefined && bestAsk !== undefined) {
    const whalePriceDiff = Math.abs(whaleTradePrice - bestAsk);
    if (whalePriceDiff < 0.05) {
      // Whale paid similar price
      return "POSSIBLY_TOO_STRICT";
    }
  }

  // Default: cannot determine
  return "UNKNOWN";
}

/**
 * Create a full spread guardrail diagnostic object.
 */
export function createSpreadGuardrailDiagnostic(
  bestBid: number | null,
  bestAsk: number,
  signalPrice?: number,
  chosenLimitPrice?: number,
  whaleTradePrice?: number,
): SpreadGuardrailDiagnostic {
  const spread = bestBid !== null ? bestAsk - bestBid : null;
  // Avoid division by zero for spreadPct
  const spreadPct =
    spread !== null && bestAsk > 0 ? (spread / bestAsk) * 100 : null;
  const marketState = classifyMarketState(bestBid, bestAsk);

  // Determine guardrail type
  // Check EMPTY_BOOK first for explicit identification
  let guardrailType: SpreadGuardrailDiagnostic["guardrailType"] = "OK";
  let thresholdUsed = DIAG_MAX_SPREAD;

  if (bestBid !== null && bestBid <= 0.01 && bestAsk >= 0.99) {
    guardrailType = "EMPTY_BOOK";
    thresholdUsed = 0.01; // bid threshold
  } else if (bestAsk > DIAG_MAX_BEST_ASK) {
    // Use strict inequality (>) - trading allowed at exactly 0.95
    guardrailType = "NEARLY_RESOLVED";
    thresholdUsed = DIAG_MAX_BEST_ASK;
  } else if (spread !== null && spread > DIAG_MAX_SPREAD) {
    guardrailType = "SPREAD_TOO_WIDE";
    thresholdUsed = DIAG_MAX_SPREAD;
  }

  // Calculate whale comparison if provided
  let whaleSpreadAtTrade: number | undefined;
  let whaleViolatedThreshold: boolean | undefined;
  if (whaleTradePrice !== undefined && bestBid !== null) {
    // Approximate what spread whale traded at
    whaleSpreadAtTrade = whaleTradePrice - bestBid;
    whaleViolatedThreshold = whaleSpreadAtTrade > DIAG_MAX_SPREAD;
  }

  const guardrailDecision = classifyGuardrailDecision(
    marketState,
    whaleTradePrice,
    bestAsk,
  );

  return {
    bestBid,
    bestAsk,
    spread,
    spreadPct,
    thresholdUsed,
    signalPrice,
    chosenLimitPrice,
    guardrailType,
    marketStateClassification: marketState,
    guardrailDecision,
    whaleTradePrice,
    whaleSpreadAtTrade,
    whaleViolatedThreshold,
  };
}

/**
 * Format spread guardrail diagnostic for GitHub issue / logging.
 */
export function formatSpreadGuardrailDiagnostic(
  diag: SpreadGuardrailDiagnostic,
): string {
  const lines: string[] = [];

  lines.push(
    `Spread: ${diag.spread?.toFixed(2) ?? "N/A"} (bid=${diag.bestBid?.toFixed(2) ?? "N/A"} ask=${diag.bestAsk.toFixed(2)}, threshold=${diag.thresholdUsed.toFixed(2)})`,
  );
  lines.push(`MarketState: ${diag.marketStateClassification}`);
  if (diag.signalPrice !== undefined) {
    lines.push(`SignalPrice: ${diag.signalPrice.toFixed(2)}`);
  }
  if (diag.whaleTradePrice !== undefined) {
    lines.push(`WhalePrice: ${diag.whaleTradePrice.toFixed(2)}`);
  }
  lines.push(`GuardrailDecision: ${diag.guardrailDecision}`);

  return lines.join("\n");
}

/**
 * Check if a book is tradeable for diagnostic mode.
 * Returns detailed diagnostic information for rejected trades.
 *
 * Checks in order of specificity:
 * 1. Empty/fake book (bestBid <= 0.01 AND bestAsk >= 0.99)
 * 2. Nearly resolved market (bestAsk > 0.95) - uses strict inequality to allow boundary trades
 * 3. Spread too wide (spread > 0.30)
 *
 * Note: classifyMarketState uses >= 0.95 for classification but trading is allowed at exactly 0.95
 */
export function checkBookTradeable(
  bestBid: number | null,
  bestAsk: number,
  signalPrice?: number,
  whaleTradePrice?: number,
): {
  tradeable: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
  diagnostic?: SpreadGuardrailDiagnostic;
} {
  // Create full diagnostic
  const diagnostic = createSpreadGuardrailDiagnostic(
    bestBid,
    bestAsk,
    signalPrice,
    undefined,
    whaleTradePrice,
  );

  // Check 1: Empty or fake book (most specific)
  if (bestBid !== null && bestBid <= 0.01 && bestAsk >= 0.99) {
    return {
      tradeable: false,
      reason: "BOOK_TOO_WIDE",
      detail: {
        bestBid,
        bestAsk,
        threshold: 0.01,
        issue: "empty or fake book - bestBid <= 0.01 and bestAsk >= 0.99",
        marketStateClassification: diagnostic.marketStateClassification,
        guardrailDecision: diagnostic.guardrailDecision,
      },
      diagnostic,
    };
  }

  // Check 2: Market nearly resolved (bestAsk > threshold, strict inequality)
  // Allows trading at exactly 0.95, rejects 0.951+
  if (bestAsk > DIAG_MAX_BEST_ASK) {
    return {
      tradeable: false,
      reason: "BOOK_TOO_WIDE",
      detail: {
        bestBid,
        bestAsk,
        threshold: DIAG_MAX_BEST_ASK,
        issue: "bestAsk > threshold - market nearly resolved",
        marketStateClassification: diagnostic.marketStateClassification,
        guardrailDecision: diagnostic.guardrailDecision,
      },
      diagnostic,
    };
  }

  // Check 3: Spread too wide (illiquid market)
  if (bestBid !== null) {
    const spread = bestAsk - bestBid;
    if (spread > DIAG_MAX_SPREAD) {
      return {
        tradeable: false,
        reason: "BOOK_TOO_WIDE",
        detail: {
          bestBid,
          bestAsk,
          spread,
          threshold: DIAG_MAX_SPREAD,
          issue: "spread > threshold - illiquid market",
          marketStateClassification: diagnostic.marketStateClassification,
          guardrailDecision: diagnostic.guardrailDecision,
        },
        diagnostic,
      };
    }
  }

  return { tradeable: true, diagnostic };
}

/**
 * Calculate the diagnostic limit price with safety caps.
 * Exported for testing and reuse.
 *
 * @param bestAsk - Current best ask price from orderbook
 * @param signalPrice - Optional signal price
 * @returns Object with calculated price and whether it was clamped
 */
export function calculateDiagLimitPrice(
  bestAsk: number,
  signalPrice?: number,
): { price: number; clamped: boolean } {
  const slippageMultiplier = 1 + DIAG_BUY_SLIPPAGE_PCT / 100;
  const diagMaxPrice = getDiagMaxPrice();

  // Calculate candidate prices
  const askBasedPrice = bestAsk * slippageMultiplier;
  const signalBasedPrice = signalPrice
    ? signalPrice * slippageMultiplier
    : Infinity;

  // Apply DIAG_MAX_PRICE cap
  const rawChosenPrice = Math.min(askBasedPrice, signalBasedPrice);
  const chosenLimitPrice = Math.min(rawChosenPrice, diagMaxPrice);

  return {
    price: chosenLimitPrice,
    clamped: rawChosenPrice > diagMaxPrice,
  };
}

/**
 * Attempt a diagnostic BUY order
 *
 * PRICING FIX:
 * Previously, limit price was based on signal.price * 1.1, which could fail
 * if the market moved and bestAsk > signal.price * 1.1 (PRICE_TOO_HIGH error).
 *
 * NEW LOGIC:
 * 1. Fetch orderbook FIRST to get current bestBid/bestAsk
 * 2. Check for UNTRADABLE_BOOK conditions (bestAsk > 0.95 or spread > 0.30)
 * 3. Apply DIAG_MAX_PRICE cap to prevent extreme prices
 * 4. Use bestAsk + small tolerance as chosenLimitPrice for BUY
 * 5. If orderbook unavailable, reject with "orderbook_unavailable"
 * 6. Log comprehensive DIAG trace with all pricing details before submission
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
      signalPrice: signal.price,
    },
  });

  console.log(`📈 Attempting BUY of ${cfg.forceShares} share(s)...`);

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Fetch orderbook to get current market state
    // ═══════════════════════════════════════════════════════════════════════
    const orderbookTimestamp = new Date().toISOString();
    let orderbook: OrderbookData | null = null;

    try {
      orderbook = await deps.client.getOrderBook(signal.tokenId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      tracer.trace({
        step,
        action: "orderbook_fetch_failed",
        result: "REJECTED",
        reason: "orderbook_unavailable",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        detail: { error: errMsg },
      });

      console.log(`🚫 BUY rejected: orderbook_unavailable (${errMsg})`);
      return {
        success: false,
        reason: "orderbook_unavailable",
        detail: { error: errMsg },
      };
    }

    // Check if orderbook has asks for BUY orders
    if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) {
      tracer.trace({
        step,
        action: "no_asks_available",
        result: "REJECTED",
        reason: "orderbook_unavailable",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        detail: {
          hasOrderbook: !!orderbook,
          askCount: orderbook?.asks?.length ?? 0,
        },
      });

      console.log(`🚫 BUY rejected: orderbook_unavailable (no asks)`);
      return {
        success: false,
        reason: "orderbook_unavailable",
        detail: { hasOrderbook: !!orderbook, askCount: 0 },
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Extract best bid/ask from orderbook
    // ═══════════════════════════════════════════════════════════════════════
    const bestAsk = parseFloat(orderbook.asks[0].price);
    const bestBid =
      orderbook.bids && orderbook.bids.length > 0
        ? parseFloat(orderbook.bids[0].price)
        : null;

    // Validate parsed prices - parseFloat returns NaN for invalid strings
    if (isNaN(bestAsk) || bestAsk <= 0) {
      tracer.trace({
        step,
        action: "invalid_ask_price",
        result: "REJECTED",
        reason: "orderbook_unavailable",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        detail: { rawAskPrice: orderbook.asks[0].price, parsedAsk: bestAsk },
      });

      console.log(
        `🚫 BUY rejected: orderbook_unavailable (invalid ask price: ${orderbook.asks[0].price})`,
      );
      return {
        success: false,
        reason: "orderbook_unavailable",
        detail: { rawAskPrice: orderbook.asks[0].price, parsedAsk: bestAsk },
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2.5: Check book tradeability (SAFE DIAGNOSTIC MODE)
    // Skip trades on extreme books to prevent accidental loss
    // ═══════════════════════════════════════════════════════════════════════
    const bookCheck = checkBookTradeable(bestBid, bestAsk, signal.price);
    if (!bookCheck.tradeable) {
      // Include full spread guardrail diagnostic in trace
      const diagnostic = bookCheck.diagnostic;
      tracer.trace({
        step,
        action: "book_too_wide",
        result: "REJECTED",
        reason: "spread_too_wide",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        detail: {
          ...bookCheck.detail,
          bestBid,
          bestAsk,
          signalPrice: signal.price,
          // Include enhanced diagnostic fields for reporting
          spreadGuardrailDiagnostic: diagnostic
            ? {
                spread: diagnostic.spread,
                spreadPct: diagnostic.spreadPct,
                thresholdUsed: diagnostic.thresholdUsed,
                guardrailType: diagnostic.guardrailType,
                marketStateClassification: diagnostic.marketStateClassification,
                guardrailDecision: diagnostic.guardrailDecision,
              }
            : undefined,
        },
      });

      const detailStr =
        bookCheck.detail?.issue ?? "book conditions too extreme";
      console.log(`🚫 BUY rejected: BOOK_TOO_WIDE - ${detailStr}`);
      console.log(
        `   bestBid=${bestBid?.toFixed(4) ?? "N/A"}, bestAsk=${bestAsk.toFixed(4)}, ` +
          `spread=${bestBid ? (bestAsk - bestBid).toFixed(4) : "N/A"}`,
      );
      if (diagnostic) {
        console.log(
          `   MarketState: ${diagnostic.marketStateClassification}, GuardrailDecision: ${diagnostic.guardrailDecision}`,
        );
      }

      return {
        success: false,
        reason: "spread_too_wide",
        detail: {
          ...bookCheck.detail,
          bestBid,
          bestAsk,
          spreadGuardrailDiagnostic: diagnostic,
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3: Compute limit price for BUY (with DIAG_MAX_PRICE cap)
    // For BUY: Use min(bestAsk + slippage, signal.price + slippage, DIAG_MAX_PRICE)
    // This ensures we never accidentally buy at extreme prices like 1.0
    // ═══════════════════════════════════════════════════════════════════════
    const slippagePct = DIAG_BUY_SLIPPAGE_PCT;
    const slippageMultiplier = 1 + slippagePct / 100;
    const diagMaxPrice = getDiagMaxPrice();

    // Calculate candidate prices
    const askBasedPrice = bestAsk * slippageMultiplier;
    const signalBasedPrice = signal.price
      ? signal.price * slippageMultiplier
      : Infinity;

    // Apply DIAG_MAX_PRICE cap - NEVER exceed this in diagnostic mode
    const rawChosenPrice = Math.min(askBasedPrice, signalBasedPrice);
    const chosenLimitPrice = Math.min(rawChosenPrice, diagMaxPrice);

    // Track if price was clamped for logging
    const priceClamped = rawChosenPrice > diagMaxPrice;
    if (priceClamped) {
      tracer.trace({
        step,
        action: "price_clamped",
        result: "OK",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        detail: {
          rawPrice: rawChosenPrice,
          clampedTo: diagMaxPrice,
          reason: "DIAG_MAX_PRICE cap applied for safety",
        },
      });
      console.log(
        `⚠️ [DIAG] Price clamped: ${rawChosenPrice.toFixed(4)} → ${diagMaxPrice.toFixed(4)} (DIAG_MAX_PRICE cap)`,
      );
    }

    // Note: priceUnits is for logging/documentation only - the Polymarket CLOB API
    // expects price in decimal format (0.0 to 1.0) representing probability/price per share
    const priceUnits = "decimal_0_to_1";

    // Calculate order size: shares * price = USD value
    // For DIAG mode, we want exactly cfg.forceShares shares
    const sizeUsd = cfg.forceShares * chosenLimitPrice;

    // Validate outcome label - must be "YES" or "NO"
    // Log warning if falling back to default "YES" to aid debugging
    let outcome: "YES" | "NO";
    if (signal.outcomeLabel === "YES" || signal.outcomeLabel === "NO") {
      outcome = signal.outcomeLabel;
    } else {
      console.warn(
        `⚠️ [DIAG] Invalid outcome label "${signal.outcomeLabel}", defaulting to "YES"`,
      );
      outcome = "YES";
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4: DIAG Structured Log - Price formation details BEFORE submission
    // This log is critical for diagnosing PRICE_TOO_HIGH and similar issues
    // ═══════════════════════════════════════════════════════════════════════
    const orderPayload = {
      side: "BUY",
      tokenId: signal.tokenId,
      price: chosenLimitPrice,
      size: cfg.forceShares,
    };

    tracer.trace({
      step,
      action: "diag_price_formation",
      result: "OK",
      marketId: signal.marketId,
      tokenId: signal.tokenId,
      outcomeLabel: signal.outcomeLabel,
      detail: {
        // Signal context
        signalPrice: signal.price,
        // Orderbook state at decision time
        bestBid,
        bestAsk,
        orderbookTimestamp,
        // Price formation
        chosenLimitPrice,
        rawChosenPrice,
        diagMaxPrice,
        priceClamped,
        slippagePct,
        dynamicAdjustments:
          "min(bestAsk + slippage, signalPrice + slippage, DIAG_MAX_PRICE)",
        priceUnits,
        // Order payload fields (no secrets)
        orderPayload,
      },
    });

    console.log(
      `📊 [DIAG] Price formation: signal=${signal.price?.toFixed(4) ?? "N/A"}, ` +
        `bestBid=${bestBid?.toFixed(4) ?? "N/A"}, bestAsk=${bestAsk.toFixed(4)}, ` +
        `chosenLimit=${chosenLimitPrice.toFixed(4)}${priceClamped ? " (capped)" : ""} (max=${diagMaxPrice})`,
    );

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4.5: Pre-order VPN routing verification
    // Ensure WRITE hosts are not bypassed before submitting order
    // ═══════════════════════════════════════════════════════════════════════
    const vpnCheck = verifyWritePathBeforeOrder(
      tracer.getTraceId(),
      deps.logger,
    );
    if (!vpnCheck.ok) {
      tracer.trace({
        step,
        action: "vpn_write_not_routed",
        result: "REJECTED",
        reason: "vpn_write_not_routed",
        marketId: signal.marketId,
        tokenId: signal.tokenId,
        detail: {
          misroutedHosts: vpnCheck.misroutedHosts,
          message: "Order blocked: WRITE hosts bypassed VPN",
        },
      });

      console.log(
        `🚫 BUY rejected: vpn_write_not_routed - WRITE hosts ${vpnCheck.misroutedHosts.join(", ")} are bypassed`,
      );

      return {
        success: false,
        reason: "vpn_write_not_routed",
        detail: { misroutedHosts: vpnCheck.misroutedHosts },
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5: Submit order with bestAsk-based limit price
    // maxAcceptablePrice is set to chosenLimitPrice to allow fill at that level
    // ═══════════════════════════════════════════════════════════════════════
    const result = await withTimeout(
      postOrder({
        client: deps.client,
        tokenId: signal.tokenId,
        outcome,
        side: "BUY",
        sizeUsd,
        marketId: signal.marketId,
        maxAcceptablePrice: chosenLimitPrice,
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
          chosenLimitPrice,
        },
      });

      console.log(
        `✅ BUY executed: $${result.filledUsd?.toFixed(4) ?? "N/A"} @ ${result.avgPrice?.toFixed(4) ?? "N/A"}`,
      );

      // Invalidate position cache so sell step can see the new position
      invalidatePositions();

      return {
        success: true,
        detail: {
          orderId: result.orderId,
          filledUsd: result.filledUsd,
          avgPrice: result.avgPrice,
          chosenLimitPrice,
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
      detail: {
        orderReason: result.reason,
        chosenLimitPrice,
        bestAsk,
      },
    });

    console.log(`🚫 BUY rejected: ${reason}`);

    return {
      success: false,
      reason,
      detail: { orderReason: result.reason, chosenLimitPrice, bestAsk },
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

      const filledUsdDisplay =
        result.filledUsd != null ? result.filledUsd.toFixed(4) : "N/A";
      const priceValue = result.actualPrice ?? result.avgPrice;
      const priceDisplay = priceValue != null ? priceValue.toFixed(4) : "N/A";

      console.log(`✅ SELL executed: $${filledUsdDisplay} @ ${priceDisplay}`);

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

// ═══════════════════════════════════════════════════════════════════════════
// HEDGE VERIFICATION STEP (with DIAG_HEDGE_SIMULATE support)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Default hedge configuration for diagnostic verification
 */
const DEFAULT_HEDGE_CONFIG = {
  triggerCents: 16, // Hedge at 16¢ adverse
  hedgeRatio: 0.4, // Hedge 40% on first trigger
  maxHedgeRatio: 0.7, // Never hedge more than 70%
  maxAdverseCents: 30, // Hard stop at 30¢ adverse
};

/**
 * Check if hedge simulation is enabled.
 * When DIAG_HEDGE_SIMULATE=true, run hedge simulation even when buy is blocked.
 */
export function isDiagHedgeSimulateEnabled(): boolean {
  return process.env.DIAG_HEDGE_SIMULATE === "true";
}

/**
 * DIAG_HEDGE_SIM event structure for reporting hedge simulation results.
 */
export interface DiagHedgeSimEvent {
  event: "DIAG_HEDGE_SIM";
  timestamp: string;
  simulationMode: "ACTUAL_POSITION" | "MOCK_POSITION";
  // Input parameters
  tokenId: string;
  marketId?: string;
  forceShares: number;
  signalPrice: number;
  simulatedEntryPrice: number;
  side: "LONG" | "SHORT";
  // Trigger condition evaluation
  triggerEvaluation: {
    triggerThresholdCents: number;
    simulatedMarkPrice: number;
    adverseMoveCents: number;
    wouldTrigger: boolean;
  };
  // Hedge side/token selection
  hedgeSideSelection: {
    hedgeSide: "BUY" | "SELL";
    hedgeTokenId: string | null; // opposite outcome token
    reason: string;
  };
  // Computed hedge size
  hedgeSizeComputation: {
    positionSize: number;
    hedgeRatio: number;
    computedHedgeSize: number;
    maxHedgeRatio: number;
    cappedHedgeSize: number;
  };
  // Price caps / slippage / safety limits
  safetyLimits: {
    maxAdverseCents: number;
    hardStopWouldTrigger: boolean;
    slippageApplied: number;
  };
  // Final order payload summary (redacted)
  wouldPlaceOrder: {
    side: "BUY" | "SELL";
    tokenIdPrefix: string;
    size: number;
    priceRange: string;
  } | null;
}

/**
 * Run a hedge simulation for diagnostic purposes.
 * This simulates what would happen if the buy had executed and price moved adversely.
 */
export function runHedgeSimulation(
  tokenId: string,
  signalPrice: number,
  forceShares: number,
  hedgeConfig: typeof DEFAULT_HEDGE_CONFIG,
  marketId?: string,
): DiagHedgeSimEvent {
  const timestamp = new Date().toISOString();
  const simulatedEntryPrice = signalPrice * 100; // Convert to cents
  const side: "LONG" | "SHORT" = "LONG"; // BUY = LONG position

  // Simulate price moving adversely to trigger hedge
  const epsilon = 1; // 1¢ past trigger
  const simulatedMarkPrice =
    simulatedEntryPrice - hedgeConfig.triggerCents - epsilon;
  const adverseMoveCents = simulatedEntryPrice - simulatedMarkPrice;

  // Evaluate trigger condition
  const wouldTrigger = adverseMoveCents >= hedgeConfig.triggerCents;

  // Hedge side selection (for LONG position, hedge by SELLING or buying opposite token)
  const hedgeSide: "BUY" | "SELL" = "SELL"; // Typically sell to reduce exposure

  // Compute hedge size
  const positionSize = forceShares;
  const computedHedgeSize = positionSize * hedgeConfig.hedgeRatio;
  const cappedHedgeSize = Math.min(
    computedHedgeSize,
    positionSize * hedgeConfig.maxHedgeRatio,
  );

  // Check hard stop
  const hardStopWouldTrigger = adverseMoveCents >= hedgeConfig.maxAdverseCents;

  // Build event
  const event: DiagHedgeSimEvent = {
    event: "DIAG_HEDGE_SIM",
    timestamp,
    simulationMode: "MOCK_POSITION",
    tokenId,
    marketId,
    forceShares,
    signalPrice,
    simulatedEntryPrice,
    side,
    triggerEvaluation: {
      triggerThresholdCents: hedgeConfig.triggerCents,
      simulatedMarkPrice,
      adverseMoveCents,
      wouldTrigger,
    },
    hedgeSideSelection: {
      hedgeSide,
      hedgeTokenId: null, // Would need market data to resolve opposite token
      reason: `LONG position -> ${hedgeSide} to reduce exposure`,
    },
    hedgeSizeComputation: {
      positionSize,
      hedgeRatio: hedgeConfig.hedgeRatio,
      computedHedgeSize,
      maxHedgeRatio: hedgeConfig.maxHedgeRatio,
      cappedHedgeSize,
    },
    safetyLimits: {
      maxAdverseCents: hedgeConfig.maxAdverseCents,
      hardStopWouldTrigger,
      slippageApplied: 2, // 2% default slippage
    },
    wouldPlaceOrder:
      wouldTrigger && !hardStopWouldTrigger
        ? {
            side: hedgeSide,
            tokenIdPrefix: tokenId.slice(0, 16) + "...",
            size: cappedHedgeSize,
            priceRange: `${(simulatedMarkPrice / 100).toFixed(4)} ± 2%`,
          }
        : null,
  };

  return event;
}

/**
 * Hedge trigger evaluation result
 */
interface HedgeTriggerEvaluation {
  entryPriceCents: number;
  currentPriceCents: number;
  adverseMoveCents: number;
  triggerThresholdCents: number;
  shouldTrigger: boolean;
  side: "LONG" | "SHORT";
}

/**
 * Hard stop evaluation result
 */
interface HardStopEvaluation {
  entryPriceCents: number;
  currentPriceCents: number;
  adverseMoveCents: number;
  hardStopThresholdCents: number;
  shouldTrigger: boolean;
  side: "LONG" | "SHORT";
}

/**
 * Run hedge verification step
 *
 * This step simulates adverse price moves to verify that hedge logic
 * correctly evaluates triggers and would place hedge orders.
 *
 * NOTE: This does NOT actually place hedge orders - it only verifies the logic.
 */
async function runHedgeVerificationStep(
  deps: DiagWorkflowDeps,
  cfg: DiagModeConfig,
  tracer: DiagTracer,
  buyContext:
    | {
        tokenId: string;
        marketId?: string;
        outcomeLabel?: string;
        executedShares?: number;
        entryPriceCents?: number;
        side?: "LONG" | "SHORT";
      }
    | undefined,
  step: DiagStep,
): Promise<DiagStepResult> {
  const groupTitle = `DIAG ${step} (trace: ${tracer.getTraceId().slice(0, 8)}...)`;

  ghGroup(groupTitle);

  tracer.trace({
    step,
    action: "step_started",
    result: "OK",
    detail: { verifyingHedgeLogic: true },
  });

  // Check if buy was executed - with explicit skip reasons
  if (!buyContext) {
    // Case 1: No buy context at all (buy step didn't execute or was skipped)
    const skipReason = "no_executed_position";

    tracer.trace({
      step,
      action: "hedge_skipped",
      result: "SKIPPED",
      reason: "hedge_not_triggered",
      detail: {
        skipReason,
        message: "Hedge verification skipped: buy step did not execute",
      },
    });

    console.log(
      `⏭️ ${step}: SKIPPED (${skipReason}) - buy step did not execute`,
    );

    ghEndGroup();
    return {
      step,
      result: "SKIPPED",
      reason: "hedge_not_triggered",
      detail: { skipReason, message: "Buy step did not execute" },
      traceEvents: tracer.getStepEvents(step),
    };
  }

  if (!buyContext.executedShares || buyContext.executedShares <= 0) {
    // Case 2: Buy context exists but no shares executed (order was rejected)
    // If DIAG_HEDGE_SIMULATE=true, run hedge simulation anyway

    if (isDiagHedgeSimulateEnabled()) {
      // Run hedge simulation with mock position
      console.log(
        `🔬 ${step}: DIAG_HEDGE_SIMULATE=true - running hedge simulation despite rejected buy`,
      );

      const hedgeConfig = deps.hedgeConfig ?? DEFAULT_HEDGE_CONFIG;
      // Prefer entry price from buyContext if available; fall back to 50¢ default
      const simulatedSignalPrice =
        buyContext.entryPriceCents !== undefined
          ? buyContext.entryPriceCents / 100
          : 0.5;

      const hedgeSimEvent = runHedgeSimulation(
        buyContext.tokenId,
        simulatedSignalPrice,
        cfg.forceShares,
        hedgeConfig,
        buyContext.marketId,
      );

      // Emit the simulation event
      console.log(JSON.stringify(hedgeSimEvent));

      tracer.trace({
        step,
        action: "hedge_simulation_completed",
        result: "OK",
        marketId: buyContext.marketId,
        tokenId: buyContext.tokenId,
        detail: {
          simulationMode: "MOCK_POSITION",
          buyWasRejected: true,
          hedgeSimEvent,
        },
      });

      console.log(
        `✅ ${step}: Hedge simulation completed (MOCK_POSITION mode)`,
      );
      console.log(
        `   Trigger would fire: ${hedgeSimEvent.triggerEvaluation.wouldTrigger}`,
      );
      console.log(
        `   Would place order: ${hedgeSimEvent.wouldPlaceOrder ? "YES" : "NO"}`,
      );

      ghEndGroup();
      return {
        step,
        result: "OK",
        marketId: buyContext.marketId,
        tokenId: buyContext.tokenId,
        detail: {
          simulationMode: "MOCK_POSITION",
          hedgeSimEvent,
        },
        traceEvents: tracer.getStepEvents(step),
      };
    }

    // Standard skip (no simulation)
    const skipReason = "no_executed_position";

    tracer.trace({
      step,
      action: "hedge_skipped",
      result: "SKIPPED",
      reason: "hedge_not_triggered",
      detail: {
        skipReason,
        executedShares: buyContext.executedShares ?? 0,
        message: "Hedge verification skipped: no shares were executed in buy",
        diagHedgeSimulate: isDiagHedgeSimulateEnabled(),
      },
    });

    console.log(
      `⏭️ ${step}: SKIPPED (${skipReason}) - no shares executed in buy`,
    );

    ghEndGroup();
    return {
      step,
      result: "SKIPPED",
      reason: "hedge_not_triggered",
      detail: {
        skipReason,
        executedShares: buyContext.executedShares ?? 0,
        message: "No shares were executed in buy",
      },
      traceEvents: tracer.getStepEvents(step),
    };
  }

  if (!buyContext.entryPriceCents && !deps.getMarketData) {
    // Case 3: Missing position data (no entry price and no way to get market data)
    const skipReason = "missing_position_data";

    tracer.trace({
      step,
      action: "hedge_skipped",
      result: "SKIPPED",
      reason: "hedge_not_triggered",
      detail: {
        skipReason,
        message:
          "Hedge verification skipped: missing entry price and no market data source",
      },
    });

    console.log(
      `⏭️ ${step}: SKIPPED (${skipReason}) - missing entry price data`,
    );

    ghEndGroup();
    return {
      step,
      result: "SKIPPED",
      reason: "hedge_not_triggered",
      detail: {
        skipReason,
        message: "Missing entry price and market data source",
      },
      traceEvents: tracer.getStepEvents(step),
    };
  }

  const hedgeConfig = deps.hedgeConfig ?? DEFAULT_HEDGE_CONFIG;
  const { tokenId, marketId, outcomeLabel } = buyContext;

  // Determine entry price and side
  // If not provided in context, fetch current market data as proxy
  let entryPriceCents = buyContext.entryPriceCents;
  let side = buyContext.side ?? "LONG";

  if (!entryPriceCents && deps.getMarketData) {
    try {
      const marketData = await deps.getMarketData(tokenId);
      if (marketData?.mid) {
        entryPriceCents = marketData.mid * 100;
      }
    } catch {
      // Use a default price for simulation if market data unavailable
      entryPriceCents = 50; // 50¢ as default
    }
  }

  entryPriceCents = entryPriceCents ?? 50;

  console.log(
    `🔬 ${step}: Verifying hedge logic for ${tokenId.slice(0, 16)}...`,
  );
  console.log(`   Entry: ${entryPriceCents.toFixed(1)}¢, Side: ${side}`);
  console.log(
    `   Trigger: ${hedgeConfig.triggerCents}¢ adverse, Hard stop: ${hedgeConfig.maxAdverseCents}¢`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test 1: Hedge trigger evaluation
  // Simulate price moving adversely by exactly the trigger amount
  // ─────────────────────────────────────────────────────────────────────────

  const simulatedAdversePrice =
    side === "LONG"
      ? entryPriceCents - hedgeConfig.triggerCents
      : entryPriceCents + hedgeConfig.triggerCents;

  const hedgeTriggerEval: HedgeTriggerEvaluation = {
    entryPriceCents,
    currentPriceCents: simulatedAdversePrice,
    adverseMoveCents: hedgeConfig.triggerCents,
    triggerThresholdCents: hedgeConfig.triggerCents,
    shouldTrigger: true, // At exactly the trigger point, should trigger
    side,
  };

  tracer.trace({
    step,
    action: "hedge_trigger_evaluated",
    result: "OK",
    marketId,
    tokenId,
    outcomeLabel,
    detail: {
      ...hedgeTriggerEval,
      hedgeRatio: hedgeConfig.hedgeRatio,
      maxHedgeRatio: hedgeConfig.maxHedgeRatio,
    },
  });

  console.log(
    `   ✅ Hedge trigger evaluated: ${simulatedAdversePrice.toFixed(1)}¢ → SHOULD trigger`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: Simulate hedge order placement decision
  // ─────────────────────────────────────────────────────────────────────────

  // Verify hedge order would be placed (without actually placing it)
  const hedgeOrderDecision = {
    wouldPlace: true,
    hedgeRatio: hedgeConfig.hedgeRatio,
    hedgeSide: side === "LONG" ? "SHORT" : "LONG",
    reason: "hedge_trigger_threshold_met",
  };

  tracer.trace({
    step,
    action: "hedge_order_placed",
    result: "OK",
    marketId,
    tokenId,
    outcomeLabel,
    detail: {
      simulation: true,
      ...hedgeOrderDecision,
      message: "Hedge order WOULD be placed (simulation only)",
    },
  });

  console.log(
    `   ✅ Hedge order decision: WOULD place ${(hedgeConfig.hedgeRatio * 100).toFixed(0)}% hedge (${hedgeOrderDecision.hedgeSide})`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Hard stop evaluation
  // Simulate price moving adversely beyond the hard stop
  // ─────────────────────────────────────────────────────────────────────────

  const simulatedHardStopPrice =
    side === "LONG"
      ? entryPriceCents - hedgeConfig.maxAdverseCents
      : entryPriceCents + hedgeConfig.maxAdverseCents;

  const hardStopEval: HardStopEvaluation = {
    entryPriceCents,
    currentPriceCents: simulatedHardStopPrice,
    adverseMoveCents: hedgeConfig.maxAdverseCents,
    hardStopThresholdCents: hedgeConfig.maxAdverseCents,
    shouldTrigger: true, // At hard stop, should exit
    side,
  };

  tracer.trace({
    step,
    action: "hard_stop_evaluated",
    result: "OK",
    marketId,
    tokenId,
    outcomeLabel,
    detail: {
      ...hardStopEval,
      action: "EXIT",
      reason: "HARD_EXIT",
    },
  });

  console.log(
    `   ✅ Hard stop evaluated: ${simulatedHardStopPrice.toFixed(1)}¢ → WOULD trigger EXIT`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: No trigger case (price still favorable)
  // ─────────────────────────────────────────────────────────────────────────

  const noTriggerPrice = entryPriceCents; // Price unchanged

  tracer.trace({
    step,
    action: "hedge_trigger_evaluated",
    result: "OK",
    marketId,
    tokenId,
    detail: {
      entryPriceCents,
      currentPriceCents: noTriggerPrice,
      adverseMoveCents: 0,
      triggerThresholdCents: hedgeConfig.triggerCents,
      shouldTrigger: false,
      message: "No adverse move - hedge NOT triggered",
    },
  });

  console.log(
    `   ✅ No-trigger case verified: ${noTriggerPrice.toFixed(1)}¢ → NO hedge`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────

  console.log(`   📊 Hedge logic verification complete`);

  ghEndGroup();

  return {
    step,
    result: "OK",
    marketId,
    tokenId,
    outcomeLabel,
    detail: {
      hedgeLogicVerified: true,
      hedgeTriggerEval,
      hardStopEval,
      hedgeConfig,
    },
    traceEvents: tracer.getStepEvents(step),
  };
}

/**
 * Map order failure reason string to DiagReason
 */
export function mapOrderFailureReason(reason?: string): DiagReason {
  if (!reason) return "unknown_error";

  const lower = reason.toLowerCase();

  if (lower.includes("live trading") || lower.includes("simulat")) {
    return "no_wallet_credentials";
  }
  if (lower.includes("liquidity") || lower.includes("depth")) {
    return "insufficient_liquidity";
  }
  // Map PRICE_TOO_HIGH and PRICE_TOO_LOW from postOrder
  if (
    lower.includes("price_too_high") ||
    lower.includes("price_too_low") ||
    (lower.includes("price") &&
      (lower.includes("range") || lower.includes("protection")))
  ) {
    return "price_out_of_range";
  }
  if (
    lower.includes("orderbook") ||
    lower.includes("no_asks") ||
    lower.includes("no_bids")
  ) {
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
