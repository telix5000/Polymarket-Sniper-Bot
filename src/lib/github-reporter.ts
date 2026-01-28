/**
 * GitHub Issue Reporter - Reports debug errors to GitHub Issues
 *
 * When enabled via GITHUB_ERROR_REPORTER_TOKEN, significant errors and debug
 * information are automatically reported to GitHub Issues for better troubleshooting.
 *
 * Environment Variables:
 *   GITHUB_ERROR_REPORTER_TOKEN - GitHub personal access token with 'repo' scope
 *   GITHUB_ERROR_REPORTER_REPO  - Repository to report to (e.g., owner/repo-name) - REQUIRED
 *   GITHUB_ERROR_REPORTER_ENABLED - Enable/disable reporting (default: true if token AND repo are set)
 *
 * The reporter:
 *   - Batches similar errors to avoid spam
 *   - Deduplicates errors based on message content
 *   - Rate limits to avoid GitHub API limits
 *   - Sanitizes sensitive information (keys, tokens, etc.)
 */

import axios from "axios";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ErrorSeverity = "critical" | "error" | "warning" | "info" | "debug";

export interface ErrorReport {
  title: string;
  message: string;
  severity: ErrorSeverity;
  context?: Record<string, unknown>;
  stackTrace?: string;
  timestamp: number;
}

export interface GitHubReporterConfig {
  token: string;
  repo: string;
  enabled: boolean;
  /** Minimum severity to report (default: "warning") */
  minSeverity: ErrorSeverity;
  /** Rate limit: max reports per hour (default: 10) */
  maxReportsPerHour: number;
  /** Deduplication window in ms (default: 1 hour) */
  dedupeWindowMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const SEVERITY_LEVELS: Record<ErrorSeverity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

const SEVERITY_LABELS: Record<ErrorSeverity, string> = {
  debug: "🔍 Debug",
  info: "ℹ️ Info",
  warning: "⚠️ Warning",
  error: "❌ Error",
  critical: "🚨 Critical",
};

const SENSITIVE_PATTERNS = [
  /0x[a-fA-F0-9]{64}/g, // Private keys
  /[a-fA-F0-9]{32,}/g, // API keys/tokens
  /Bearer\s+[^\s]+/gi, // Bearer tokens
  /Basic\s+[^\s]+/gi, // Basic auth
];

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB ISSUE REPORTER
// ═══════════════════════════════════════════════════════════════════════════

export class GitHubReporter {
  private config: GitHubReporterConfig;
  private recentReports: Map<string, number> = new Map();
  private reportCount = 0;
  private lastHourReset = Date.now();

  constructor(config: Partial<GitHubReporterConfig> = {}) {
    const token = config.token ?? process.env.GITHUB_ERROR_REPORTER_TOKEN ?? "";
    const repo = config.repo ?? process.env.GITHUB_ERROR_REPORTER_REPO ?? "";

    // Only enable if BOTH token AND repo are configured
    const hasRequiredConfig = !!token && !!repo;
    const explicitlyDisabled =
      process.env.GITHUB_ERROR_REPORTER_ENABLED === "false";

    this.config = {
      token,
      repo,
      enabled: config.enabled ?? (hasRequiredConfig && !explicitlyDisabled),
      // Changed default from "error" to "warning" so startup diagnostics get reported
      minSeverity: config.minSeverity ?? "warning",
      maxReportsPerHour: config.maxReportsPerHour ?? 10,
      dedupeWindowMs: config.dedupeWindowMs ?? 60 * 60 * 1000, // 1 hour
    };

    // Log initialization details for debugging
    if (hasRequiredConfig && !explicitlyDisabled) {
      console.log(
        `📋 [GitHub] Initialized with repo: ${repo}, minSeverity: ${this.config.minSeverity}`,
      );
    }
  }

  /**
   * Check if the reporter is enabled and configured
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.token && !!this.config.repo;
  }

  /**
   * Report an error to GitHub Issues
   */
  async report(report: ErrorReport): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    // Check severity threshold
    if (
      SEVERITY_LEVELS[report.severity] <
      SEVERITY_LEVELS[this.config.minSeverity]
    ) {
      // Log when severity blocks reporting (helps debug why reports aren't sent)
      console.log(
        `📋 [GitHub] Skipping report (severity ${report.severity} < min ${this.config.minSeverity}): ${report.title.slice(0, 50)}...`,
      );
      return false;
    }

    // Rate limiting
    const now = Date.now();
    if (now - this.lastHourReset > 60 * 60 * 1000) {
      this.reportCount = 0;
      this.lastHourReset = now;
    }

    if (this.reportCount >= this.config.maxReportsPerHour) {
      console.log(
        `📋 GitHub reporter rate limited (${this.config.maxReportsPerHour}/hour)`,
      );
      return false;
    }

    // Deduplication
    const dedupeKey = this.getDedupeKey(report);
    const lastReported = this.recentReports.get(dedupeKey);
    if (lastReported && now - lastReported < this.config.dedupeWindowMs) {
      console.log(
        `📋 [GitHub] Skipping duplicate report: ${report.title.slice(0, 50)}...`,
      );
      return false; // Skip duplicate
    }

    try {
      console.log(`📋 [GitHub] Creating issue: ${report.title}`);
      await this.createIssue(report);
      this.reportCount++;
      this.recentReports.set(dedupeKey, now);

      // Cleanup old dedupe entries
      this.cleanupDedupeMap(now);

      console.log(`📋 Reported to GitHub: ${report.title}`);
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isPermissionError =
        errMsg.includes("403") ||
        errMsg.includes("permission") ||
        errMsg.includes("Forbidden") ||
        errMsg.includes("Resource not accessible");

      if (isPermissionError) {
        console.warn(
          `📋 [GitHub] Issue creation failed: INSUFFICIENT_GITHUB_PERMISSIONS. ` +
            `Token may lack 'issues:write' scope or this is a fork PR context.`,
        );
        // Fall back to step summary if available
        this.writeToStepSummary(report);
      } else {
        console.error(`📋 Failed to report to GitHub: ${errMsg}`);
      }
      return false;
    }
  }

  /**
   * Write report to GitHub Actions Step Summary as fallback.
   * This always works in Actions context without special permissions.
   */
  private writeToStepSummary(report: ErrorReport): void {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) {
      console.log(
        "📋 [GitHub] GITHUB_STEP_SUMMARY not available - skipping step summary",
      );
      return;
    }

    try {
      const fs = require("fs");
      const summaryContent = this.formatStepSummary(report);
      fs.appendFileSync(summaryPath, summaryContent + "\n\n");
      console.log(`📋 [GitHub] Wrote report to step summary`);
    } catch (err) {
      console.warn(
        `📋 [GitHub] Failed to write step summary: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Format a report for GitHub Actions Step Summary (Markdown format)
   */
  private formatStepSummary(report: ErrorReport): string {
    const timestamp = new Date(report.timestamp).toISOString();
    const contextStr = report.context
      ? Object.entries(report.context)
          .map(([k, v]) => `| ${k} | ${this.sanitize(String(v))} |`)
          .join("\n")
      : "| N/A | N/A |";

    return `## ${SEVERITY_LABELS[report.severity]} ${this.sanitize(report.title)}

**Timestamp**: ${timestamp}

### Message
\`\`\`
${this.sanitize(report.message)}
\`\`\`

### Context
| Key | Value |
|-----|-------|
${contextStr}

---
`;
  }

  /**
   * Report a trade copy failure
   */
  async reportTradeCopyFailure(details: {
    tokenId: string;
    whaleWallet: string;
    whaleTradeSize: number;
    ourTradeSize: number;
    errorMessage: string;
    marketInfo?: string;
  }): Promise<boolean> {
    return this.report({
      title: `Trade Copy Failed: ${details.errorMessage.slice(0, 50)}`,
      message: details.errorMessage,
      severity: "error",
      context: {
        tokenId: this.sanitize(details.tokenId),
        whaleWallet: this.sanitize(details.whaleWallet),
        whaleTradeSize: details.whaleTradeSize,
        ourTradeSize: details.ourTradeSize,
        marketInfo: details.marketInfo,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Report a whale detection issue
   */
  async reportWhaleDetectionIssue(details: {
    issue: string;
    trackedWallets: number;
    requestedWallets: number;
    details?: string;
  }): Promise<boolean> {
    return this.report({
      title: `Whale Detection Issue: ${details.issue}`,
      message: `${details.issue}\n\nTracked: ${details.trackedWallets}, Requested: ${details.requestedWallets}`,
      severity: "warning",
      context: {
        trackedWallets: details.trackedWallets,
        requestedWallets: details.requestedWallets,
        additionalDetails: details.details,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Report an authentication or API issue
   */
  async reportApiIssue(details: {
    endpoint: string;
    statusCode?: number;
    errorMessage: string;
    isRecoverable: boolean;
  }): Promise<boolean> {
    return this.report({
      title: `API Issue: ${details.endpoint} - ${details.statusCode ?? "Unknown"}`,
      message: details.errorMessage,
      severity: details.isRecoverable ? "warning" : "error",
      context: {
        endpoint: details.endpoint,
        statusCode: details.statusCode,
        isRecoverable: details.isRecoverable,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Report a startup diagnostic summary
   * This captures the first 60 seconds of operation for debugging
   */
  async reportStartupDiagnostic(details: {
    whaleWalletsLoaded: number;
    marketsScanned: number;
    whaleTradesDetected: number;
    entryAttemptsCount: number;
    entrySuccessCount: number;
    entryFailureReasons: string[];
    orderbookFetchFailures: number;
    onchainMonitorStatus: string;
    rpcLatencyMs: number;
    apiLatencyMs: number;
    balance: number;
    effectiveBankroll: number;
    config: {
      liveTradingEnabled: boolean;
      copyAnyWhaleBuy: boolean;
      whaleTradeUsd: number;
      scanActiveMarkets: boolean;
    };
  }): Promise<boolean> {
    return this.report({
      title: `Startup Diagnostic: ${details.whaleTradesDetected} whale trades, ${details.entrySuccessCount}/${details.entryAttemptsCount} entries`,
      message:
        `Startup diagnostic after 60 seconds of operation.\n\n` +
        `Whale Detection:\n` +
        `- Wallets loaded: ${details.whaleWalletsLoaded}\n` +
        `- Whale trades detected: ${details.whaleTradesDetected}\n` +
        `- On-chain monitor: ${details.onchainMonitorStatus}\n\n` +
        `Entry Pipeline:\n` +
        `- Markets scanned: ${details.marketsScanned}\n` +
        `- Entry attempts: ${details.entryAttemptsCount}\n` +
        `- Entry successes: ${details.entrySuccessCount}\n` +
        `- Orderbook fetch failures: ${details.orderbookFetchFailures}\n` +
        (details.entryFailureReasons.length > 0
          ? `- Failure reasons: ${[...new Set(details.entryFailureReasons)].join(", ")}\n`
          : "") +
        `\nNetwork:\n` +
        `- RPC latency: ${details.rpcLatencyMs}ms\n` +
        `- API latency: ${details.apiLatencyMs}ms\n\n` +
        `Balance:\n` +
        `- Total: $${details.balance.toFixed(2)}\n` +
        `- Effective: $${details.effectiveBankroll.toFixed(2)}\n\n` +
        `Config:\n` +
        `- Live trading: ${details.config.liveTradingEnabled}\n` +
        `- Copy any whale buy: ${details.config.copyAnyWhaleBuy}\n` +
        `- Min whale trade: $${details.config.whaleTradeUsd}\n` +
        `- Scan active markets: ${details.config.scanActiveMarkets}`,
      severity:
        details.whaleTradesDetected === 0 && details.entrySuccessCount === 0
          ? "warning"
          : "info",
      context: {
        whaleWalletsLoaded: details.whaleWalletsLoaded,
        marketsScanned: details.marketsScanned,
        whaleTradesDetected: details.whaleTradesDetected,
        entryAttempts: details.entryAttemptsCount,
        entrySuccesses: details.entrySuccessCount,
        orderbookFetchFailures: details.orderbookFetchFailures,
        onchainMonitor: details.onchainMonitorStatus,
        rpcLatencyMs: details.rpcLatencyMs,
        apiLatencyMs: details.apiLatencyMs,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Report diagnostic workflow results to GitHub Issues
   * Called when DIAG_MODE completes to report the results
   */
  async reportDiagnosticWorkflow(details: {
    traceId: string;
    durationMs: number;
    steps: Array<{
      step: string;
      result: string;
      reason?: string;
      marketId?: string;
      tokenId?: string;
    }>;
  }): Promise<boolean> {
    const successCount = details.steps.filter((s) => s.result === "OK").length;
    const totalSteps = details.steps.length;

    // Format step results
    const stepLines = details.steps
      .map((s) => {
        const icon =
          s.result === "OK"
            ? "✅"
            : s.result === "SKIPPED"
              ? "⏭️"
              : s.result === "REJECTED"
                ? "🚫"
                : "❌";
        const reasonStr = s.reason ? ` (${s.reason})` : "";
        const tokenStr = s.tokenId
          ? ` [token: ${s.tokenId.slice(0, 16)}...]`
          : "";
        return `- ${icon} **${s.step}**: ${s.result}${reasonStr}${tokenStr}`;
      })
      .join("\n");

    // Always use at least "warning" severity for diagnostic reports
    // to ensure they pass the default minSeverity threshold ("warning")
    return this.report({
      title: `Diagnostic Workflow: ${successCount}/${totalSteps} steps succeeded`,
      message:
        `Diagnostic workflow completed.\n\n` +
        `**Trace ID**: ${details.traceId}\n` +
        `**Duration**: ${(details.durationMs / 1000).toFixed(1)}s\n\n` +
        `## Step Results\n${stepLines}`,
      severity: "warning",
      context: {
        traceId: details.traceId,
        durationMs: details.durationMs,
        successCount,
        totalSteps,
        steps: details.steps.map((s) => `${s.step}:${s.result}`).join(", "),
      },
      timestamp: Date.now(),
    });
  }

  private getDedupeKey(report: ErrorReport): string {
    // Create a key based on title and core message
    const coreMessage = report.message.slice(0, 100).toLowerCase();
    return `${report.title}-${coreMessage}`;
  }

  private cleanupDedupeMap(now: number): void {
    for (const [key, timestamp] of this.recentReports) {
      if (now - timestamp > this.config.dedupeWindowMs) {
        this.recentReports.delete(key);
      }
    }
  }

  private sanitize(value: string): string {
    let result = value;
    for (const pattern of SENSITIVE_PATTERNS) {
      result = result.replace(pattern, "[REDACTED]");
    }
    // Also truncate wallet addresses but keep first/last chars for debugging
    result = result.replace(
      /0x[a-fA-F0-9]{40}/g,
      (match) => `${match.slice(0, 8)}...${match.slice(-6)}`,
    );
    return result;
  }

  private async createIssue(report: ErrorReport): Promise<void> {
    const [owner, repo] = this.config.repo.split("/");
    if (!owner || !repo) {
      throw new Error(`Invalid repo format: ${this.config.repo}`);
    }

    const body = this.formatIssueBody(report);

    await axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      {
        title: `[Bot Error] ${SEVERITY_LABELS[report.severity]} ${report.title}`,
        body,
        labels: ["bot-error", report.severity],
      },
      {
        headers: {
          Authorization: `token ${this.config.token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        timeout: 10000,
      },
    );
  }

  private formatIssueBody(report: ErrorReport): string {
    const timestamp = new Date(report.timestamp).toISOString();
    const contextStr = report.context
      ? Object.entries(report.context)
          .map(([k, v]) => `- **${k}**: ${this.sanitize(String(v))}`)
          .join("\n")
      : "None";

    return `## ${SEVERITY_LABELS[report.severity]} Error Report

**Timestamp**: ${timestamp}

### Message
\`\`\`
${this.sanitize(report.message)}
\`\`\`

### Context
${contextStr}

${report.stackTrace ? `### Stack Trace\n\`\`\`\n${this.sanitize(report.stackTrace.slice(0, 2000))}\n\`\`\`` : ""}

---
*This issue was automatically created by the Polymarket Bot error reporter.*
`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let globalReporter: GitHubReporter | null = null;

/**
 * Get the global GitHub reporter instance
 */
export function getGitHubReporter(): GitHubReporter {
  if (!globalReporter) {
    globalReporter = new GitHubReporter();
  }
  return globalReporter;
}

/**
 * Initialize the GitHub reporter with custom config
 */
export function initGitHubReporter(
  config: Partial<GitHubReporterConfig>,
): GitHubReporter {
  globalReporter = new GitHubReporter(config);
  return globalReporter;
}

/**
 * Helper function to report errors (non-blocking)
 */
export function reportError(
  title: string,
  message: string,
  severity: ErrorSeverity = "error",
  context?: Record<string, unknown>,
): void {
  const reporter = getGitHubReporter();
  if (reporter.isEnabled()) {
    reporter
      .report({
        title,
        message,
        severity,
        context,
        timestamp: Date.now(),
      })
      .catch(() => {
        // Silently ignore reporting failures
      });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC TRACE FILE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Path for diagnostic trace JSONL file (relative to workspace)
 */
const DIAG_TRACE_FILENAME = "diag-trace.jsonl";

/**
 * Write a diagnostic event to the JSONL trace file.
 * This file can be uploaded as a GitHub Actions artifact.
 *
 * @param event - Any JSON-serializable event object
 * @param outputDir - Optional output directory (default: current working directory)
 */
export function writeDiagTraceEvent(
  event: Record<string, unknown>,
  outputDir?: string,
): void {
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = outputDir ?? process.cwd();
    const filePath = path.join(dir, DIAG_TRACE_FILENAME);

    const line = JSON.stringify({
      ...event,
      _timestamp: new Date().toISOString(),
    });

    fs.appendFileSync(filePath, line + "\n");
  } catch (err) {
    // Silently ignore write failures
    console.warn(
      `Failed to write diag trace: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Get the path to the diagnostic trace file
 */
export function getDiagTracePath(outputDir?: string): string {
  const path = require("path");
  const dir = outputDir ?? process.cwd();
  return path.join(dir, DIAG_TRACE_FILENAME);
}

/**
 * Write a complete diagnostic workflow result to the trace file.
 *
 * @param result - Diagnostic workflow result
 * @param outputDir - Optional output directory
 */
export function writeDiagWorkflowTrace(
  result: {
    traceId: string;
    startTime: Date;
    endTime: Date;
    steps: Array<{
      step: string;
      result: string;
      reason?: string;
      marketId?: string;
      tokenId?: string;
      traceEvents?: Array<Record<string, unknown>>;
    }>;
    exitCode: number;
  },
  outputDir?: string,
): void {
  // Write summary event
  writeDiagTraceEvent(
    {
      event: "DIAG_WORKFLOW_COMPLETE",
      traceId: result.traceId,
      startTime: result.startTime.toISOString(),
      endTime: result.endTime.toISOString(),
      durationMs: result.endTime.getTime() - result.startTime.getTime(),
      exitCode: result.exitCode,
      stepSummary: result.steps.map((s) => `${s.step}:${s.result}`).join(", "),
    },
    outputDir,
  );

  // Write individual step events
  for (const step of result.steps) {
    writeDiagTraceEvent(
      {
        event: "DIAG_STEP_RESULT",
        traceId: result.traceId,
        step: step.step,
        result: step.result,
        reason: step.reason,
        marketId: step.marketId,
        tokenId: step.tokenId,
      },
      outputDir,
    );

    // Write individual trace events if available
    if (step.traceEvents) {
      for (const traceEvent of step.traceEvents) {
        writeDiagTraceEvent(traceEvent, outputDir);
      }
    }
  }
}
