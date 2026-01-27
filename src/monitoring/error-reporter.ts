/**
 * APEX Error Reporter
 * 
 * Automatically reports critical errors to GitHub by creating Issues
 * for investigation and tracking. Can optionally create PRs with fixes
 * for known error patterns.
 * 
 * Features:
 * - Error classification and prioritization
 * - Automatic GitHub Issue creation
 * - Error pattern detection and deduplication
 * - Stack trace analysis and formatting
 * - Context capture (balance, positions, config)
 * - Rate limiting to prevent spam
 * - Telegram notifications for critical errors
 */

import type { Logger } from "../lib/types";

export interface ErrorContext {
  // Runtime state
  balance?: number;
  positionCount?: number;
  cycleCount?: number;
  uptime?: number;
  mode?: string;
  
  // Error details
  errorType: string;
  errorMessage: string;
  stackTrace?: string;
  
  // Additional context
  marketId?: string;
  tokenId?: string;
  operation?: string;
  timestamp: number;
  
  // Environment
  nodeVersion: string;
  apexVersion: string;
  liveTrading: boolean;
}

export interface ErrorPattern {
  id: string;
  pattern: RegExp;
  priority: "critical" | "high" | "medium" | "low";
  category: "auth" | "network" | "order" | "data" | "configuration" | "unknown";
  autoFixAvailable?: boolean;
}

export interface GitHubIssueOptions {
  title: string;
  body: string;
  labels: string[];
  priority: "critical" | "high" | "medium" | "low";
}

// Error patterns for classification
const ERROR_PATTERNS: ErrorPattern[] = [
  {
    id: "auth_401",
    pattern: /401|unauthorized|authentication failed/i,
    priority: "critical",
    category: "auth",
    autoFixAvailable: false,
  },
  {
    id: "network_timeout",
    pattern: /timeout|ETIMEDOUT|ECONNREFUSED/i,
    priority: "medium",
    category: "network",
    autoFixAvailable: true,
  },
  {
    id: "order_failed",
    pattern: /order.*failed|insufficient.*balance|invalid.*order/i,
    priority: "high",
    category: "order",
    autoFixAvailable: false,
  },
  {
    id: "data_parse",
    pattern: /parse|JSON|undefined.*property|cannot read/i,
    priority: "medium",
    category: "data",
    autoFixAvailable: true,
  },
  {
    id: "config_missing",
    pattern: /missing.*config|env.*not.*set|required.*variable/i,
    priority: "high",
    category: "configuration",
    autoFixAvailable: false,
  },
  {
    id: "rpc_error",
    pattern: /rpc.*error|provider.*error|chain.*error/i,
    priority: "high",
    category: "network",
    autoFixAvailable: true,
  },
];

export class ErrorReporter {
  private logger: Logger;
  private errorHistory: Map<string, number>;
  private lastReportTime: Map<string, number>;
  private readonly RATE_LIMIT_MS = 3600000; // 1 hour between same error reports
  private readonly MAX_HISTORY = 100;
  private githubToken?: string;
  private repoOwner: string;
  private repoName: string;
  private telegramEnabled: boolean;

  constructor(
    logger: Logger,
    options: {
      githubToken?: string;
      repoOwner?: string;
      repoName?: string;
      telegramEnabled?: boolean;
    } = {},
  ) {
    this.logger = logger;
    this.errorHistory = new Map();
    this.lastReportTime = new Map();
    
    this.githubToken = options.githubToken || process.env.GITHUB_ERROR_REPORTER_TOKEN;
    this.repoOwner = options.repoOwner || "telix5000";
    this.repoName = options.repoName || "Polymarket-Sniper-Bot";
    this.telegramEnabled = options.telegramEnabled ?? true;
  }

  /**
   * Report an error to GitHub (and optionally Telegram)
   */
  async reportError(error: Error, context: Partial<ErrorContext> = {}): Promise<boolean> {
    try {
      // Build full context
      const fullContext = this.buildContext(error, context);
      
      // Classify error
      const pattern = this.classifyError(error);
      
      // Check if we should report (rate limiting)
      const errorKey = this.getErrorKey(error, pattern);
      if (!this.shouldReport(errorKey)) {
        this.logger.info(`⏭️ Error reporting rate-limited: ${errorKey}`);
        return false;
      }

      // Create GitHub issue if token available
      if (this.githubToken) {
        const issueOptions = this.buildIssueOptions(error, pattern, fullContext);
        const issueUrl = await this.createGitHubIssue(issueOptions);
        
        if (issueUrl) {
          this.logger.info(`✅ Error reported to GitHub: ${issueUrl}`);
          
          // Send Telegram notification
          if (this.telegramEnabled) {
            await this.sendTelegramNotification(error, pattern, issueUrl);
          }
          
          // Update tracking
          this.recordReport(errorKey);
          return true;
        }
      } else {
        this.logger.warn("⚠️ GitHub token not configured - error not reported");
        // Still log locally
        this.logErrorLocally(error, pattern, fullContext);
      }

      return false;
    } catch (reportError) {
      // Don't throw - we don't want error reporting to crash the bot
      this.logger.error(`Failed to report error: ${reportError}`);
      return false;
    }
  }

  /**
   * Classify error based on patterns
   */
  private classifyError(error: Error): ErrorPattern {
    const errorString = `${error.name} ${error.message} ${error.stack || ""}`;
    
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.pattern.test(errorString)) {
        return pattern;
      }
    }
    
    // Default pattern for unknown errors
    return {
      id: "unknown",
      pattern: /.*/,
      priority: "medium",
      category: "unknown",
      autoFixAvailable: false,
    };
  }

  /**
   * Build full error context
   */
  private buildContext(error: Error, partial: Partial<ErrorContext>): ErrorContext {
    return {
      errorType: error.name,
      errorMessage: error.message,
      stackTrace: error.stack,
      timestamp: Date.now(),
      nodeVersion: process.version,
      apexVersion: "3.0.0",
      liveTrading: process.env.LIVE_TRADING === "I_UNDERSTAND_THE_RISKS",
      ...partial,
    };
  }

  /**
   * Build GitHub issue options
   */
  private buildIssueOptions(
    error: Error,
    pattern: ErrorPattern,
    context: ErrorContext,
  ): GitHubIssueOptions {
    const priorityEmoji = {
      critical: "🔴",
      high: "🟠",
      medium: "🟡",
      low: "🟢",
    };

    const title = `${priorityEmoji[pattern.priority]} [${pattern.category.toUpperCase()}] ${error.name}: ${error.message.substring(0, 80)}`;
    
    const body = this.buildIssueBody(error, pattern, context);
    
    const labels = [
      "bug",
      `priority:${pattern.priority}`,
      `category:${pattern.category}`,
      "auto-reported",
    ];
    
    if (pattern.autoFixAvailable) {
      labels.push("auto-fix-available");
    }
    
    if (!context.liveTrading) {
      labels.push("simulation");
    }

    return { title, body, labels, priority: pattern.priority };
  }

  /**
   * Build detailed issue body
   */
  private buildIssueBody(error: Error, pattern: ErrorPattern, context: ErrorContext): string {
    const sections: string[] = [];

    // Header
    sections.push("## 🤖 Auto-Generated Error Report\n");
    sections.push(`**Error Pattern:** \`${pattern.id}\``);
    sections.push(`**Category:** ${pattern.category}`);
    sections.push(`**Priority:** ${pattern.priority}`);
    sections.push(`**Timestamp:** ${new Date(context.timestamp).toISOString()}\n`);

    // Error Details
    sections.push("## 📋 Error Details\n");
    sections.push("```");
    sections.push(`Type: ${context.errorType}`);
    sections.push(`Message: ${context.errorMessage}`);
    sections.push("```\n");

    // Stack Trace
    if (context.stackTrace) {
      sections.push("## 📚 Stack Trace\n");
      sections.push("<details>");
      sections.push("<summary>Click to expand stack trace</summary>\n");
      sections.push("```");
      sections.push(context.stackTrace);
      sections.push("```");
      sections.push("</details>\n");
    }

    // Context
    sections.push("## 🔍 Runtime Context\n");
    sections.push("```");
    sections.push(`Mode: ${context.mode || "unknown"}`);
    sections.push(`Live Trading: ${context.liveTrading ? "YES ⚠️" : "NO (simulation)"}`);
    sections.push(`Balance: ${context.balance ? `$${context.balance.toFixed(2)}` : "unknown"}`);
    sections.push(`Positions: ${context.positionCount ?? "unknown"}`);
    sections.push(`Cycles: ${context.cycleCount ?? "unknown"}`);
    sections.push(`Uptime: ${context.uptime ? `${(context.uptime / 3600000).toFixed(1)}h` : "unknown"}`);
    sections.push("```\n");

    // Operation Context
    if (context.operation || context.marketId || context.tokenId) {
      sections.push("## 🎯 Operation Context\n");
      sections.push("```");
      if (context.operation) sections.push(`Operation: ${context.operation}`);
      if (context.marketId) sections.push(`Market ID: ${context.marketId}`);
      if (context.tokenId) sections.push(`Token ID: ${context.tokenId}`);
      sections.push("```\n");
    }

    // Environment
    sections.push("## 💻 Environment\n");
    sections.push("```");
    sections.push(`Node Version: ${context.nodeVersion}`);
    sections.push(`APEX Version: ${context.apexVersion}`);
    sections.push("```\n");

    // Suggested Actions
    sections.push("## 🔧 Suggested Actions\n");
    
    if (pattern.autoFixAvailable) {
      sections.push("✅ **Auto-fix available** - A fix pattern is known for this error.");
    }
    
    switch (pattern.category) {
      case "auth":
        sections.push("- Check API credentials and authentication flow");
        sections.push("- Verify wallet private key is valid");
        sections.push("- Check for rate limiting or API changes");
        break;
      case "network":
        sections.push("- Check RPC endpoint availability");
        sections.push("- Verify VPN configuration if geo-restricted");
        sections.push("- Consider adding retry logic with exponential backoff");
        break;
      case "order":
        sections.push("- Verify sufficient USDC balance");
        sections.push("- Check position sizing logic");
        sections.push("- Review order validation rules");
        break;
      case "data":
        sections.push("- Add null/undefined checks");
        sections.push("- Validate API response structure");
        sections.push("- Add error handling for data parsing");
        break;
      case "configuration":
        sections.push("- Review .env file and required variables");
        sections.push("- Check APEX mode configuration");
        sections.push("- Verify all required ENV vars are set");
        break;
    }

    sections.push("\n---");
    sections.push("*This issue was automatically created by APEX Error Reporter*");

    return sections.join("\n");
  }

  /**
   * Create GitHub issue via API
   * Note: Requires Node.js 18+ for native fetch API support
   */
  private async createGitHubIssue(options: GitHubIssueOptions): Promise<string | null> {
    if (!this.githubToken) return null;

    try {
      const response = await fetch(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/issues`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: options.title,
            body: options.body,
            labels: options.labels,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`GitHub API error (${response.status}): ${errorText}`);
        return null;
      }

      const issue = await response.json();
      return issue.html_url;
    } catch (error) {
      this.logger.error(`Failed to create GitHub issue: ${error}`);
      return null;
    }
  }

  /**
   * Send Telegram notification about error
   */
  private async sendTelegramNotification(
    error: Error,
    pattern: ErrorPattern,
    issueUrl: string,
  ): Promise<void> {
    try {
      // Import dynamically to avoid circular dependencies
      const { sendTelegram } = await import("../lib/telegram");
      
      const priorityEmoji = {
        critical: "🔴",
        high: "🟠",
        medium: "🟡",
        low: "🟢",
      };

      const message = [
        `${priorityEmoji[pattern.priority]} **Error Reported**`,
        "",
        `**Type:** ${pattern.category}`,
        `**Priority:** ${pattern.priority}`,
        `**Message:** ${error.message}`,
        "",
        `🔗 [View Issue](${issueUrl})`,
      ].join("\n");

      await sendTelegram("🚨 APEX Error", message);
    } catch (err) {
      this.logger.error(`Failed to send Telegram notification: ${err}`);
    }
  }

  /**
   * Log error locally (fallback when GitHub not configured)
   */
  private logErrorLocally(error: Error, pattern: ErrorPattern, context: ErrorContext): void {
    this.logger.error("═══════════════════════════════════════");
    this.logger.error("🚨 ERROR DETECTED (Not reported to GitHub - no token)");
    this.logger.error(`Pattern: ${pattern.id} (${pattern.category})`);
    this.logger.error(`Priority: ${pattern.priority}`);
    this.logger.error(`Message: ${error.message}`);
    if (context.operation) {
      this.logger.error(`Operation: ${context.operation}`);
    }
    this.logger.error("═══════════════════════════════════════");
  }

  /**
   * Get unique key for error (for deduplication)
   */
  private getErrorKey(error: Error, pattern: ErrorPattern): string {
    // Use pattern ID + first line of message for deduplication
    const messageLine = error.message.split("\n")[0];
    return `${pattern.id}:${messageLine}`;
  }

  /**
   * Check if error should be reported (rate limiting)
   */
  private shouldReport(errorKey: string): boolean {
    const lastReport = this.lastReportTime.get(errorKey);
    const now = Date.now();
    
    if (!lastReport) {
      return true;
    }
    
    return now - lastReport > this.RATE_LIMIT_MS;
  }

  /**
   * Record that we reported this error
   */
  private recordReport(errorKey: string): void {
    const now = Date.now();
    
    // Update last report time
    this.lastReportTime.set(errorKey, now);
    
    // Increment count
    const count = (this.errorHistory.get(errorKey) || 0) + 1;
    this.errorHistory.set(errorKey, count);
    
    // Cleanup old entries if too many
    if (this.errorHistory.size > this.MAX_HISTORY) {
      const oldestKey = this.errorHistory.keys().next().value as string | undefined;
      if (oldestKey) {
        this.errorHistory.delete(oldestKey);
        this.lastReportTime.delete(oldestKey);
      }
    }
  }

  /**
   * Get error statistics
   */
  getStats(): {
    totalErrors: number;
    uniqueErrors: number;
    recentErrors: Array<{ key: string; count: number; lastReport: number }>;
  } {
    const recentErrors = Array.from(this.errorHistory.entries()).map(([key, count]) => ({
      key,
      count,
      lastReport: this.lastReportTime.get(key) || 0,
    }));

    return {
      totalErrors: Array.from(this.errorHistory.values()).reduce((sum, count) => sum + count, 0),
      uniqueErrors: this.errorHistory.size,
      recentErrors: recentErrors.sort((a, b) => b.lastReport - a.lastReport),
    };
  }
}

/**
 * Global error reporter instance
 */
let globalReporter: ErrorReporter | null = null;
let handlersRegistered = false;

  /**
   * Initialize global error reporter
   */
  export function initErrorReporter(logger: Logger): ErrorReporter {
    if (!globalReporter) {
      globalReporter = new ErrorReporter(logger);
    }
    
    // Only register handlers once to prevent duplicates
    if (!handlersRegistered) {
      handlersRegistered = true;
      
      // Set up global error handlers
      process.on("uncaughtException", async (error) => {
        logger.error(`🔥 Uncaught Exception: ${error.message}`);
        
        try {
          const reportingPromise = globalReporter?.reportError(error, {
            operation: "uncaught_exception",
          } as Partial<ErrorContext>);

          if (reportingPromise) {
            // Wait for report to complete, but don't block indefinitely
            await Promise.race([
              reportingPromise,
              new Promise<void>((resolve) => setTimeout(resolve, 10000)),
            ]);
          }
        } catch (reportErrorError) {
          logger.error(
            `Failed to report uncaught exception: ${
              reportErrorError instanceof Error
                ? reportErrorError.message
                : String(reportErrorError)
            }`
          );
        } finally {
          // Uncaught exceptions should terminate the process
          process.exit(1);
        }
      });
  
      process.on("unhandledRejection", async (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        logger.error(`🔥 Unhandled Rejection: ${error.message}`);
        await globalReporter?.reportError(error, {
          operation: "unhandled_rejection",
        } as Partial<ErrorContext>);
      });
    }
    
    return globalReporter;
  }

/**
 * Get global error reporter instance
 */
export function getErrorReporter(): ErrorReporter | null {
  return globalReporter;
}

/**
 * Report error using global reporter
 */
export async function reportError(error: Error, context?: Partial<ErrorContext>): Promise<boolean> {
  if (!globalReporter) {
    console.error("Error reporter not initialized");
    return false;
  }
  return globalReporter.reportError(error, context);
}
