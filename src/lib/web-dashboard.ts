/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET BOT - Web Dashboard Server
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Glances-style web dashboard accessible via HTTP port.
 * Access the dashboard at http://localhost:DASHBOARD_PORT (default: 3000)
 *
 * Usage:
 *   - Set DASHBOARD_PORT=3000 (or any port you prefer)
 *   - Access via browser: http://localhost:3000
 *   - Expose via Docker: docker run -p 3000:3000 polymarket-bot
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import * as http from "http";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface WebDashboardPosition {
  market: string;
  side: "YES" | "NO";
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface WebDashboardTrade {
  time: string;
  market: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  status: "success" | "failed" | "pending";
}

export interface WebDashboardWhaleActivity {
  time: string;
  wallet: string;
  market: string;
  side: "BUY" | "SELL";
  size: number;
  copied: boolean;
}

export interface WebDashboardMetrics {
  // Wallet
  usdcBalance: number;
  polBalance: number;
  effectiveBankroll: number;
  reserveUsd: number;

  // Trading
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  evCents: number;

  // Positions
  openPositions: number;
  maxPositions: number;
  deployedUsd: number;
  deployedPercent: number;

  // System
  uptime: number;
  lastWhaleSignal: number;
  apiLatencyMs: number;
  wsConnected: boolean;
}

export interface WebDashboardConfig {
  port: number;
  enabled: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// WEB DASHBOARD CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class WebDashboard {
  private server: http.Server | null = null;
  private config: WebDashboardConfig;
  private startTime: number;

  // Data
  private metrics: WebDashboardMetrics = {
    usdcBalance: 0,
    polBalance: 0,
    effectiveBankroll: 0,
    reserveUsd: 0,
    totalTrades: 0,
    winRate: 0,
    totalPnl: 0,
    evCents: 0,
    openPositions: 0,
    maxPositions: 12,
    deployedUsd: 0,
    deployedPercent: 0,
    uptime: 0,
    lastWhaleSignal: 0,
    apiLatencyMs: 0,
    wsConnected: false,
  };

  private positions: WebDashboardPosition[] = [];
  private recentTrades: WebDashboardTrade[] = [];
  private whaleActivity: WebDashboardWhaleActivity[] = [];
  private isLiveTrading = false;
  private logs: string[] = [];

  constructor(config: Partial<WebDashboardConfig> = {}) {
    // Validate and parse port from environment
    const envPortRaw = process.env.DASHBOARD_PORT;
    let envPort: number | undefined;

    if (envPortRaw !== undefined && envPortRaw !== "") {
      const parsedPort = parseInt(envPortRaw, 10);

      if (
        !Number.isInteger(parsedPort) ||
        parsedPort < 1 ||
        parsedPort > 65535
      ) {
        throw new Error(
          `Invalid DASHBOARD_PORT value "${envPortRaw}". Expected an integer between 1 and 65535.`,
        );
      }

      envPort = parsedPort;
    }

    const defaultPort = envPort ?? 3000;

    this.config = {
      port: config.port ?? defaultPort,
      enabled: config.enabled ?? true,
    };
    this.startTime = Date.now();
  }

  /**
   * Check if web dashboard is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get the dashboard port
   */
  getPort(): number {
    return this.config.port;
  }

  /**
   * Start the web dashboard server
   */
  start(): void {
    if (!this.config.enabled) {
      return;
    }

    this.server = http.createServer((req, res) => {
      // CORS headers - restrict to localhost by default for security
      // The dashboard displays sensitive trading information
      const originHeader = req.headers.origin;
      const allowedOriginsEnv = process.env.DASHBOARD_ALLOWED_ORIGINS;
      const allowedOrigins = allowedOriginsEnv
        ? allowedOriginsEnv
            .split(",")
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
        : [`http://localhost:${this.config.port}`];

      let corsOrigin = "null";
      if (originHeader && allowedOrigins.includes(originHeader)) {
        corsOrigin = originHeader;
      }

      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || "/";

      try {
        if (url === "/api/data") {
          // JSON API endpoint for programmatic access
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.getApiData()));
        } else if (url === "/api/metrics") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.metrics));
        } else if (url === "/api/positions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.positions));
        } else if (url === "/api/trades") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.recentTrades));
        } else if (url === "/api/whales") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(this.whaleActivity));
        } else {
          // Main dashboard HTML page
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(this.generateHtml());
        }
      } catch (err) {
        // Handle JSON serialization errors or other unexpected errors
        console.error(
          `❌ Dashboard request error: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });

    // Bind to 0.0.0.0 to allow Docker port forwarding, but CORS restricts actual access
    // For local-only access, set DASHBOARD_BIND_ADDRESS=127.0.0.1
    const bindAddress = process.env.DASHBOARD_BIND_ADDRESS || "0.0.0.0";
    this.server.listen(this.config.port, bindAddress, () => {
      console.log(
        `🌐 Web dashboard started at http://localhost:${this.config.port}`,
      );
      if (bindAddress === "0.0.0.0") {
        console.log(
          `   ⚠️ Dashboard is accessible from all interfaces. Set DASHBOARD_BIND_ADDRESS=127.0.0.1 for local-only access.`,
        );
      }
    });

    this.server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `❌ Dashboard port ${this.config.port} is already in use`,
        );
      } else {
        console.error(`❌ Dashboard server error: ${err.message}`);
      }
    });
  }

  /**
   * Stop the web dashboard server
   */
  stop(): void {
    if (this.server) {
      const server = this.server;
      this.server = null;
      server.close((err?: Error) => {
        if (err) {
          console.error(
            `❌ Error while shutting down dashboard server: ${err.message}`,
          );
        }
      });
    }
  }

  /**
   * Get API data
   */
  private getApiData(): object {
    return {
      mode: this.isLiveTrading ? "LIVE" : "SIMULATION",
      uptime: this.formatUptime(),
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      metrics: this.metrics,
      positions: this.positions,
      recentTrades: this.recentTrades.slice(0, 20),
      whaleActivity: this.whaleActivity.slice(0, 20),
      logs: this.logs.slice(-50),
    };
  }

  /**
   * Format uptime
   */
  private formatUptime(): string {
    const seconds = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  /**
   * Generate the HTML dashboard page
   */
  private generateHtml(): string {
    const modeClass = this.isLiveTrading ? "live" : "simulation";
    const modeText = this.isLiveTrading ? "LIVE" : "SIMULATION";
    const wsStatus = this.metrics.wsConnected ? "connected" : "disconnected";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Polymarket Bot Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      background: #0d1117;
      color: #c9d1d9;
      min-height: 100vh;
      padding: 10px;
    }
    .header {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 15px 20px;
      margin-bottom: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .header h1 {
      color: #58a6ff;
      font-size: 1.5em;
    }
    .header-info {
      display: flex;
      gap: 20px;
      align-items: center;
      flex-wrap: wrap;
    }
    .mode { padding: 4px 12px; border-radius: 20px; font-weight: bold; font-size: 0.85em; }
    .mode.live { background: #238636; color: #fff; }
    .mode.simulation { background: #9e6a03; color: #fff; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 5px; }
    .status-dot.connected { background: #3fb950; }
    .status-dot.disconnected { background: #f85149; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 10px;
    }
    .panel {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      overflow: hidden;
    }
    .panel-header {
      background: #21262d;
      padding: 10px 15px;
      border-bottom: 1px solid #30363d;
      font-weight: bold;
      color: #58a6ff;
    }
    .panel-body {
      padding: 15px;
      max-height: 300px;
      overflow-y: auto;
    }
    .metric-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #21262d;
    }
    .metric-row:last-child { border-bottom: none; }
    .metric-label { color: #8b949e; }
    .metric-value { font-weight: bold; color: #c9d1d9; }
    .metric-value.positive { color: #3fb950; }
    .metric-value.negative { color: #f85149; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #21262d; }
    th { color: #8b949e; font-weight: normal; }
    .buy { color: #3fb950; }
    .sell { color: #f85149; }
    .log-entry { padding: 4px 0; font-size: 0.85em; border-bottom: 1px solid #21262d; }
    .log-entry:last-child { border-bottom: none; }
    .copied { color: #58a6ff; font-weight: bold; }
    .footer {
      text-align: center;
      padding: 15px;
      color: #8b949e;
      font-size: 0.85em;
    }
    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
      .header { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 Polymarket Bot</h1>
    <div class="header-info">
      <span class="mode ${modeClass}">${modeText}</span>
      <span><span class="status-dot ${wsStatus}"></span>WebSocket</span>
      <span>⏱️ ${this.formatUptime()}</span>
    </div>
  </div>

  <div class="grid">
    <!-- Metrics Panel -->
    <div class="panel">
      <div class="panel-header">📊 Metrics</div>
      <div class="panel-body">
        <div class="metric-row">
          <span class="metric-label">USDC Balance</span>
          <span class="metric-value">$${this.metrics.usdcBalance.toFixed(2)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">POL Balance</span>
          <span class="metric-value">${this.metrics.polBalance.toFixed(2)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Effective Bankroll</span>
          <span class="metric-value">$${this.metrics.effectiveBankroll.toFixed(2)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Reserve</span>
          <span class="metric-value">$${this.metrics.reserveUsd.toFixed(2)}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Total Trades</span>
          <span class="metric-value">${this.metrics.totalTrades}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Win Rate</span>
          <span class="metric-value">${(this.metrics.winRate * 100).toFixed(1)}%</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Total P&L</span>
          <span class="metric-value ${this.metrics.totalPnl >= 0 ? "positive" : "negative"}">
            ${this.metrics.totalPnl >= 0 ? "+" : ""}$${this.metrics.totalPnl.toFixed(2)}
          </span>
        </div>
        <div class="metric-row">
          <span class="metric-label">EV</span>
          <span class="metric-value">${this.metrics.evCents.toFixed(2)}¢</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">Positions</span>
          <span class="metric-value">${this.metrics.openPositions}/${this.metrics.maxPositions}</span>
        </div>
        <div class="metric-row">
          <span class="metric-label">API Latency</span>
          <span class="metric-value">${this.metrics.apiLatencyMs}ms</span>
        </div>
      </div>
    </div>

    <!-- Positions Panel -->
    <div class="panel">
      <div class="panel-header">💼 Positions</div>
      <div class="panel-body">
        ${
          this.positions.length > 0
            ? `<table>
          <tr><th>Market</th><th>Side</th><th>Size</th><th>Price</th><th>P&L</th></tr>
          ${this.positions
            .map(
              (p) => `
            <tr>
              <td>${this.escapeHtml(p.market.substring(0, 25))}</td>
              <td class="${p.side === "YES" ? "buy" : "sell"}">${p.side}</td>
              <td>$${p.size.toFixed(0)}</td>
              <td>${(p.currentPrice * 100).toFixed(0)}¢</td>
              <td class="${p.pnl >= 0 ? "positive" : "negative"}">${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}</td>
            </tr>
          `,
            )
            .join("")}
        </table>`
            : '<p style="color: #8b949e; text-align: center;">No open positions</p>'
        }
      </div>
    </div>

    <!-- Recent Trades Panel -->
    <div class="panel">
      <div class="panel-header">📈 Recent Trades</div>
      <div class="panel-body">
        ${
          this.recentTrades.length > 0
            ? this.recentTrades
                .slice(0, 15)
                .map(
                  (t) => `
            <div class="log-entry">
              <span style="color: #8b949e;">${t.time}</span>
              <span class="${t.side === "BUY" ? "buy" : "sell"}">${t.side}</span>
              ${this.escapeHtml(t.market.substring(0, 20))}
              $${t.size.toFixed(0)} @${(t.price * 100).toFixed(0)}¢
              <span style="color: ${t.status === "success" ? "#3fb950" : t.status === "failed" ? "#f85149" : "#9e6a03"};">
                ${t.status === "success" ? "✓" : t.status === "failed" ? "✗" : "⏳"}
              </span>
            </div>
          `,
                )
                .join("")
            : '<p style="color: #8b949e; text-align: center;">No recent trades</p>'
        }
      </div>
    </div>

    <!-- Whale Activity Panel -->
    <div class="panel">
      <div class="panel-header">🐋 Whale Activity</div>
      <div class="panel-body">
        ${
          this.whaleActivity.length > 0
            ? this.whaleActivity
                .slice(0, 15)
                .map(
                  (w) => `
            <div class="log-entry">
              <span style="color: #8b949e;">${w.time}</span>
              🐋 ${w.wallet.substring(0, 8)}...
              <span class="${w.side === "BUY" ? "buy" : "sell"}">${w.side}</span>
              $${w.size.toFixed(0)}
              ${this.escapeHtml(w.market.substring(0, 15))}
              ${w.copied ? '<span class="copied">COPIED</span>' : ""}
            </div>
          `,
                )
                .join("")
            : '<p style="color: #8b949e; text-align: center;">No whale activity yet</p>'
        }
      </div>
    </div>
  </div>

  <div class="footer">
    Auto-refreshes every 2 seconds | API: <a href="/api/data" style="color: #58a6ff;">/api/data</a>
  </div>

  <script>
    // Auto-refresh every 2 seconds without full page reload
    (function () {
      async function refreshDashboard() {
        try {
          const response = await fetch(window.location.href, { cache: "no-store" });
          if (!response.ok) {
            throw new Error("Failed to refresh dashboard: " + response.status);
          }
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");
          const newBody = doc.body;
          if (newBody) {
            document.body.innerHTML = newBody.innerHTML;
          }
        } catch (err) {
          console.error(err);
        } finally {
          setTimeout(refreshDashboard, 2000);
        }
      }

      setTimeout(refreshDashboard, 2000);
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC UPDATE METHODS - Called from main bot loop
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update trading mode
   */
  setTradingMode(isLive: boolean): void {
    this.isLiveTrading = isLive;
  }

  /**
   * Update wallet metrics
   */
  updateWallet(
    usdc: number,
    pol: number,
    effective: number,
    reserve: number,
  ): void {
    this.metrics.usdcBalance = usdc;
    this.metrics.polBalance = pol;
    this.metrics.effectiveBankroll = effective;
    this.metrics.reserveUsd = reserve;
  }

  /**
   * Update trading metrics
   */
  updateTradingMetrics(
    trades: number,
    winRate: number,
    pnl: number,
    ev: number,
  ): void {
    this.metrics.totalTrades = trades;
    this.metrics.winRate = winRate;
    this.metrics.totalPnl = pnl;
    this.metrics.evCents = ev;
  }

  /**
   * Update position metrics
   */
  updatePositionMetrics(
    open: number,
    max: number,
    deployed: number,
    percent: number,
  ): void {
    this.metrics.openPositions = open;
    this.metrics.maxPositions = max;
    this.metrics.deployedUsd = deployed;
    this.metrics.deployedPercent = percent;
  }

  /**
   * Update system metrics
   */
  updateSystemMetrics(latencyMs: number, wsConnected: boolean): void {
    this.metrics.apiLatencyMs = latencyMs;
    this.metrics.wsConnected = wsConnected;
  }

  /**
   * Update positions list
   */
  updatePositions(positions: WebDashboardPosition[]): void {
    this.positions = positions;
  }

  /**
   * Log a trade
   */
  logTrade(trade: WebDashboardTrade): void {
    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > 100) {
      this.recentTrades.pop();
    }
  }

  /**
   * Log whale activity
   */
  logWhaleActivity(activity: WebDashboardWhaleActivity): void {
    this.whaleActivity.unshift(activity);
    if (this.whaleActivity.length > 100) {
      this.whaleActivity.pop();
    }
  }

  /**
   * Log a general message
   */
  log(message: string): void {
    const timestamp = new Date().toISOString().substring(11, 19);
    this.logs.push(`[${timestamp}] ${message}`);
    if (this.logs.length > 200) {
      this.logs.shift();
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let globalWebDashboard: WebDashboard | null = null;

/**
 * Get the global web dashboard instance
 */
export function getWebDashboard(): WebDashboard | null {
  return globalWebDashboard;
}

/**
 * Initialize the web dashboard
 */
export function initWebDashboard(
  config: Partial<WebDashboardConfig> = {},
): WebDashboard {
  globalWebDashboard = new WebDashboard(config);
  return globalWebDashboard;
}

/**
 * Check if web dashboard should be started
 */
export function shouldStartWebDashboard(): boolean {
  // Web dashboard is enabled if DASHBOARD_PORT is set
  return !!process.env.DASHBOARD_PORT;
}

/**
 * Get configured dashboard port (default: 3000)
 */
export function getDashboardPort(): number {
  const rawPort = process.env.DASHBOARD_PORT || "3000";
  const parsedPort = parseInt(rawPort, 10);

  if (Number.isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return 3000;
  }

  return parsedPort;
}
