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
import * as fs from "fs";
import * as path from "path";

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

    // Validate repo format (must be "owner/repo")
    const repoFormatValid = this.validateRepoFormat(repo);

    // Only enable if BOTH token AND repo are configured AND repo format is valid
    const hasRequiredConfig = !!token && !!repo && repoFormatValid;
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

    // Log warning if repo format is invalid (but don't crash)
    if (repo && !repoFormatValid) {
      console.warn(
        `📋 [GitHub] Invalid GITHUB_ERROR_REPORTER_REPO format: "${repo}". ` +
          `Expected format: "owner/repo" (e.g., "telix5000/Polymarket-Sniper-Bot"). ` +
          `GitHub issue reporting is disabled.`,
      );
    }
  }

  /**
   * Validate repo format (must be "owner/repo" with valid characters)
   * GitHub naming rules: alphanumeric characters, hyphens, underscores, and periods
   */
  private validateRepoFormat(repo: string): boolean {
    if (!repo) return false;

    // Check for basic "owner/repo" format
    const parts = repo.split("/");
    if (parts.length !== 2) return false;

    const [owner, name] = parts;
    if (!owner || !name) return false;

    // GitHub naming: alphanumeric, hyphens, underscores, and periods
    const validPattern = /^[a-zA-Z0-9._-]+$/;
    return validPattern.test(owner) && validPattern.test(name);
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
        // Emit structured GITHUB_REPORT_FORBIDDEN event
        const forbiddenEvent = {
          event: "GITHUB_REPORT_FORBIDDEN",
          timestamp: new Date().toISOString(),
          tokenExists: !!this.config.token,
          repo: this.config.repo,
          isCI:
            process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true",
          error: errMsg.includes("403")
            ? "403 Forbidden"
            : errMsg.slice(0, 100),
          remediation: [
            "For GitHub Actions: Ensure workflow has 'permissions: issues: write'",
            "For fork PRs: Issue creation may not be allowed from forks",
            "For PAT tokens: Ensure token has 'repo' scope for private repos",
          ],
        };
        console.warn(JSON.stringify(forbiddenEvent));
        console.warn(
          `📋 [GitHub] GITHUB_REPORT_FORBIDDEN: Issue creation failed. ` +
            `tokenExists=${forbiddenEvent.tokenExists}, isCI=${forbiddenEvent.isCI}. ` +
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
   *
   * Enhanced: Includes VPN routing policy, key failures, candidate rejection summary,
   * and next actions section.
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
      // Enhanced detail for spread guardrail and hedge simulation
      detail?: Record<string, unknown>;
    }>;
    // Optional VPN routing policy effective event
    vpnRoutingPolicy?: {
      vpnActive: boolean;
      vpnType: string;
      defaultsApplied?: {
        VPN_BYPASS_RPC: boolean;
        VPN_BYPASS_POLYMARKET_READS: boolean;
        VPN_BYPASS_POLYMARKET_WS: boolean;
      };
      envOverrides?: Record<string, string>;
      bypassedHosts?: string[];
      writeHosts?: string[];
      writeRouteCheck?: Array<{
        hostname: string;
        resolvedIp?: string | null;
        outgoingInterface?: string | null;
        outgoingGateway?: string | null;
        routeThroughVpn?: boolean;
        mismatch: boolean;
      }>;
    };
    // Optional guardrail summary
    guardrailSummary?: {
      totalBuyAttempts: number;
      blockedBySpread: number;
      blockedByLiquidity: number;
      blockedByPriceCap: number;
      allowedBuys: number;
    };
    // Candidate rejection summary
    candidateRejectionSummary?: {
      totalCandidates: number;
      byRule: {
        askTooHigh: number;
        spreadTooWide: number;
        emptyBook: number;
        cooldown: number;
      };
      sampleRejected?: Array<{
        tokenId: string;
        rule: string;
        bestBid?: number;
        bestAsk?: number;
      }>;
    };
    // Key failures encountered
    keyFailures?: Array<{
      type:
        | "CLOUDFLARE_BLOCKED"
        | "WRITE_ROUTE_MISMATCH"
        | "EMPTY_BOOK"
        | "AUTH_FAILED"
        | "OTHER";
      host?: string;
      statusCode?: number;
      marketId?: string;
      tokenId?: string;
      details?: string;
    }>;
    // Bot version/commit info
    botVersion?: string;
    commitSha?: string;
    // Diagnostic config used
    diagConfig?: {
      whaleTimeoutSec?: number;
      orderTimeoutSec?: number;
      maxAttempts?: number;
      bookMaxAsk?: number;
      bookMaxSpread?: number;
    };
  }): Promise<boolean> {
    const successCount = details.steps.filter((s) => s.result === "OK").length;
    const totalSteps = details.steps.length;

    // ═══════════════════════════════════════════════════════════════════════
    // 1) HEADER
    // ═══════════════════════════════════════════════════════════════════════
    let headerSection = `## 📊 Diagnostic Report\n\n`;
    headerSection += `| Field | Value |\n|-------|-------|\n`;
    headerSection += `| **Trace ID** | \`${details.traceId}\` |\n`;
    headerSection += `| **Timestamp** | ${new Date().toISOString()} |\n`;
    headerSection += `| **Duration** | ${(details.durationMs / 1000).toFixed(1)}s |\n`;
    if (details.botVersion) {
      headerSection += `| **Bot Version** | ${details.botVersion} |\n`;
    }
    if (details.commitSha) {
      headerSection += `| **Commit** | \`${details.commitSha.slice(0, 7)}\` |\n`;
    }
    if (details.diagConfig) {
      const cfg = details.diagConfig;
      headerSection += `| **Whale Timeout** | ${cfg.whaleTimeoutSec ?? "N/A"}s |\n`;
      headerSection += `| **Order Timeout** | ${cfg.orderTimeoutSec ?? "N/A"}s |\n`;
      headerSection += `| **Max Attempts** | ${cfg.maxAttempts ?? "N/A"} |\n`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2) STEP RESULTS
    // ═══════════════════════════════════════════════════════════════════════
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

        let detailBlock = "";

        // Include spread guardrail details for rejected buys
        if (
          s.result === "REJECTED" &&
          s.reason === "spread_too_wide" &&
          s.detail
        ) {
          const diag = s.detail.spreadGuardrailDiagnostic as
            | {
                bestBid?: number;
                bestAsk?: number;
                spread?: number;
                thresholdUsed?: number;
                marketStateClassification?: string;
                guardrailDecision?: string;
                signalPrice?: number;
                whaleTradePrice?: number;
              }
            | undefined;

          if (diag) {
            detailBlock = `\n  > Spread: ${diag.spread?.toFixed(2) ?? "N/A"} (bid=${diag.bestBid?.toFixed(2) ?? "N/A"} ask=${diag.bestAsk?.toFixed(2) ?? "N/A"}, threshold=${diag.thresholdUsed?.toFixed(2) ?? "N/A"})\n  > MarketState: ${diag.marketStateClassification ?? "N/A"}\n  > SignalPrice: ${diag.signalPrice?.toFixed(2) ?? "N/A"}`;
            if (diag.whaleTradePrice !== undefined) {
              detailBlock += `\n  > WhalePrice: ${diag.whaleTradePrice.toFixed(2)}`;
            }
            detailBlock += `\n  > GuardrailDecision: ${diag.guardrailDecision ?? "UNKNOWN"}`;
          }
        }

        // Include hedge simulation output
        if (
          s.detail?.simulationMode === "MOCK_POSITION" &&
          s.detail?.hedgeSimEvent
        ) {
          const hedgeSim = s.detail.hedgeSimEvent as {
            triggerEvaluation?: { wouldTrigger?: boolean };
            wouldPlaceOrder?: { side?: string; size?: number } | null;
          };
          detailBlock = `\n  > [DIAG_HEDGE_SIM] Mode: MOCK_POSITION\n  > Trigger would fire: ${hedgeSim.triggerEvaluation?.wouldTrigger ?? "N/A"}\n  > Would place order: ${hedgeSim.wouldPlaceOrder ? `YES (${hedgeSim.wouldPlaceOrder.side} ${hedgeSim.wouldPlaceOrder.size} shares)` : "NO"}`;
        }

        return `- ${icon} **${s.step}**: ${s.result}${reasonStr}${tokenStr}${detailBlock}`;
      })
      .join("\n");

    const stepResultsSection = `\n\n## 📋 Step Results\n${stepLines}`;

    // ═══════════════════════════════════════════════════════════════════════
    // 3) VPN ROUTING POLICY (EFFECTIVE)
    // ═══════════════════════════════════════════════════════════════════════
    let vpnSection = "";
    if (details.vpnRoutingPolicy) {
      const vp = details.vpnRoutingPolicy;
      vpnSection = `\n\n## 🔐 VPN Routing Policy (Effective)\n`;
      vpnSection += `| Setting | Value |\n|---------|-------|\n`;
      vpnSection += `| **VPN Active** | ${vp.vpnActive ? "✅ Yes" : "❌ No"} |\n`;
      vpnSection += `| **VPN Type** | ${vp.vpnType} |\n`;

      if (vp.defaultsApplied) {
        vpnSection += `\n**Defaults Applied:**\n`;
        vpnSection += `- VPN_BYPASS_RPC: ${vp.defaultsApplied.VPN_BYPASS_RPC}\n`;
        vpnSection += `- VPN_BYPASS_POLYMARKET_READS: ${vp.defaultsApplied.VPN_BYPASS_POLYMARKET_READS}\n`;
        vpnSection += `- VPN_BYPASS_POLYMARKET_WS: ${vp.defaultsApplied.VPN_BYPASS_POLYMARKET_WS}\n`;
      }

      if (vp.envOverrides && Object.keys(vp.envOverrides).length > 0) {
        vpnSection += `\n**Environment Overrides:**\n`;
        for (const [key, val] of Object.entries(vp.envOverrides)) {
          vpnSection += `- ${key}: ${val}\n`;
        }
      }

      if (vp.bypassedHosts && vp.bypassedHosts.length > 0) {
        vpnSection += `\n**Bypassed Hosts:** ${vp.bypassedHosts.join(", ")}\n`;
      }

      if (vp.writeRouteCheck && vp.writeRouteCheck.length > 0) {
        const misrouted = vp.writeRouteCheck.filter((c) => c.mismatch);
        if (misrouted.length > 0) {
          vpnSection += `\n### ⚠️ WRITE_ROUTE_MISMATCH - LIKELY GEO-BLOCK CAUSE\n`;
          vpnSection += `The following WRITE hosts are NOT routed through VPN:\n`;
          for (const m of misrouted) {
            vpnSection += `- **${m.hostname}**: IP=${m.resolvedIp ?? "N/A"}, Interface=${m.outgoingInterface ?? "N/A"}, Gateway=${m.outgoingGateway ?? "N/A"}\n`;
          }
        } else {
          vpnSection += `\n✅ **All WRITE hosts route through VPN correctly**\n`;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4) KEY FAILURES
    // ═══════════════════════════════════════════════════════════════════════
    let keyFailuresSection = "";
    if (details.keyFailures && details.keyFailures.length > 0) {
      keyFailuresSection = `\n\n## ❌ Key Failures\n`;
      for (const failure of details.keyFailures) {
        keyFailuresSection += `\n### ${failure.type}\n`;
        if (failure.host) keyFailuresSection += `- **Host**: ${failure.host}\n`;
        if (failure.statusCode)
          keyFailuresSection += `- **Status**: ${failure.statusCode}\n`;
        if (failure.marketId)
          keyFailuresSection += `- **Market**: ${failure.marketId}\n`;
        if (failure.tokenId)
          keyFailuresSection += `- **Token**: ${failure.tokenId.slice(0, 20)}...\n`;
        if (failure.details)
          keyFailuresSection += `- **Details**: ${failure.details}\n`;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 5) CANDIDATE REJECTION SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    let candidateSection = "";
    if (details.candidateRejectionSummary) {
      const crs = details.candidateRejectionSummary;
      candidateSection = `\n\n## 📊 Candidate Rejection Summary\n`;
      candidateSection += `| Metric | Count |\n|--------|-------|\n`;
      candidateSection += `| Total Candidates | ${crs.totalCandidates} |\n`;
      candidateSection += `| Ask Too High | ${crs.byRule.askTooHigh} |\n`;
      candidateSection += `| Spread Too Wide | ${crs.byRule.spreadTooWide} |\n`;
      candidateSection += `| Empty Book | ${crs.byRule.emptyBook} |\n`;
      candidateSection += `| Cooldown | ${crs.byRule.cooldown} |\n`;

      if (crs.sampleRejected && crs.sampleRejected.length > 0) {
        candidateSection += `\n**Sample Rejected Entries (up to 3):**\n`;
        for (const sample of crs.sampleRejected.slice(0, 3)) {
          candidateSection += `- Token: \`${sample.tokenId.slice(0, 16)}...\` | Rule: ${sample.rule} | Bid: ${sample.bestBid?.toFixed(2) ?? "N/A"} | Ask: ${sample.bestAsk?.toFixed(2) ?? "N/A"}\n`;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6) GUARDRAIL SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    let guardrailSection = "";
    if (details.guardrailSummary) {
      const gs = details.guardrailSummary;
      guardrailSection = `\n\n## 🛡️ Guardrail Summary\n`;
      guardrailSection += `| Metric | Count |\n|--------|-------|\n`;
      guardrailSection += `| Total Buy Attempts | ${gs.totalBuyAttempts} |\n`;
      guardrailSection += `| Blocked by Spread | ${gs.blockedBySpread} |\n`;
      guardrailSection += `| Blocked by Liquidity | ${gs.blockedByLiquidity} |\n`;
      guardrailSection += `| Blocked by Price Cap | ${gs.blockedByPriceCap} |\n`;
      guardrailSection += `| Allowed Buys | ${gs.allowedBuys} |\n`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7) NEXT ACTIONS (AUTO-GENERATED)
    // ═══════════════════════════════════════════════════════════════════════
    let nextActionsSection = "";
    const nextActions: string[] = [];

    // Check for write route mismatch
    if (details.vpnRoutingPolicy?.writeRouteCheck?.some((c) => c.mismatch)) {
      nextActions.push(
        "🔧 **Fix VPN routing**: Ensure clob.polymarket.com routes through the VPN interface (wg0/tun0). Check `ip route get <clob_ip>` and verify it doesn't use the pre-VPN gateway.",
      );
    }

    // Check for Cloudflare blocked
    if (details.keyFailures?.some((f) => f.type === "CLOUDFLARE_BLOCKED")) {
      nextActions.push(
        "🌐 **Cloudflare 403**: Verify WRITE host routes through VPN. Check VPN server IP isn't geo-blocked. Try a different VPN endpoint location.",
      );
    }

    // Check for empty book rejections
    const emptyBookCount =
      details.candidateRejectionSummary?.byRule.emptyBook ?? 0;
    const spreadTooWideCount =
      details.candidateRejectionSummary?.byRule.spreadTooWide ?? 0;
    if (emptyBookCount > 0 || spreadTooWideCount > 0) {
      nextActions.push(
        "📈 **Empty/Wide books**: Adjust candidate selection to skip dead markets. Increase DIAG_MAX_CANDIDATE_ATTEMPTS. Consider scanning different market categories.",
      );
    }

    // Check for auth failures
    if (details.keyFailures?.some((f) => f.type === "AUTH_FAILED")) {
      nextActions.push(
        "🔑 **Auth failed**: Verify PRIVATE_KEY is correct. Check CLOB API credentials. Ensure wallet has sufficient allowance.",
      );
    }

    // Generic VPN not active warning
    if (details.vpnRoutingPolicy && !details.vpnRoutingPolicy.vpnActive) {
      nextActions.push(
        "⚠️ **VPN not active**: Orders to clob.polymarket.com may be geo-blocked. Enable VPN with WIREGUARD_ENABLED=true or OPENVPN_ENABLED=true.",
      );
    }

    if (nextActions.length > 0) {
      nextActionsSection = `\n\n## 🔧 Next Actions\n`;
      for (const action of nextActions) {
        nextActionsSection += `- ${action}\n`;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8) ATTACHMENTS / ARTIFACTS
    // ═══════════════════════════════════════════════════════════════════════
    let attachmentsSection = `\n\n## 📎 Attachments\n`;
    attachmentsSection += `- Diagnostic trace file: \`/app/diag-trace.jsonl\` (available as GitHub Actions artifact)\n`;
    attachmentsSection += `- Trace ID for log correlation: \`${details.traceId}\`\n`;

    // Always use at least "warning" severity for diagnostic reports
    // to ensure they pass the default minSeverity threshold ("warning")
    return this.report({
      title: `Diagnostic Workflow: ${successCount}/${totalSteps} steps succeeded`,
      message:
        headerSection +
        stepResultsSection +
        vpnSection +
        keyFailuresSection +
        candidateSection +
        guardrailSection +
        nextActionsSection +
        attachmentsSection,
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
