/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POLYMARKET BOT - Live Terminal Dashboard
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Glances-style real-time terminal dashboard for monitoring bot activity.
 * Shows live updates of positions, trades, whale activity, and system metrics.
 *
 * Usage:
 *   - Runs in the terminal with real-time updates
 *   - Press 'q' or Ctrl+C to exit
 *   - Enable with DASHBOARD_ENABLED=true (default: true)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import * as blessed from "blessed";
import * as contrib from "blessed-contrib";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface DashboardPosition {
  market: string;
  side: "YES" | "NO";
  size: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface DashboardTrade {
  time: string;
  market: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  status: "✓" | "✗" | "⏳";
}

export interface DashboardWhaleActivity {
  time: string;
  wallet: string;
  market: string;
  side: "BUY" | "SELL";
  size: number;
  copied: boolean;
}

export interface DashboardMetrics {
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

export interface DashboardConfig {
  enabled: boolean;
  refreshIntervalMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD CLASS
// ═══════════════════════════════════════════════════════════════════════════

export class Dashboard {
  private screen: blessed.Widgets.Screen | null = null;
  private grid: contrib.grid | null = null;
  private config: DashboardConfig;
  private startTime: number;
  private refreshInterval: NodeJS.Timeout | null = null;

  // Widgets
  private headerBox: blessed.Widgets.BoxElement | null = null;
  private metricsTable: contrib.Widgets.TableElement | null = null;
  private positionsTable: contrib.Widgets.TableElement | null = null;
  private tradesLog: contrib.Widgets.LogElement | null = null;
  private whaleLog: contrib.Widgets.LogElement | null = null;
  private statusBar: blessed.Widgets.BoxElement | null = null;

  // Data
  private metrics: DashboardMetrics = {
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

  private positions: DashboardPosition[] = [];
  private recentTrades: DashboardTrade[] = [];
  private whaleActivity: DashboardWhaleActivity[] = [];
  private isLiveTrading = false;
  private mode = "SIMULATION";

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      refreshIntervalMs: config.refreshIntervalMs ?? 1000,
    };
    this.startTime = Date.now();
  }

  /**
   * Check if dashboard is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Initialize and start the dashboard
   */
  start(): void {
    if (!this.config.enabled) {
      return;
    }

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Polymarket Bot Dashboard",
      fullUnicode: true,
    });

    // Create grid layout (12x12)
    this.grid = new contrib.grid({
      rows: 12,
      cols: 12,
      screen: this.screen,
    });

    this.createWidgets();
    this.setupKeyBindings();
    this.startRefresh();

    this.screen.render();
  }

  /**
   * Create dashboard widgets
   */
  private createWidgets(): void {
    if (!this.grid || !this.screen) return;

    // Header (row 0, full width)
    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      content: this.getHeaderContent(),
      tags: true,
      border: {
        type: "line",
      },
      style: {
        fg: "white",
        border: {
          fg: "cyan",
        },
      },
    });

    // Metrics table (left side, rows 1-4)
    this.metricsTable = this.grid.set(1, 0, 4, 6, contrib.table, {
      keys: true,
      fg: "white",
      label: " 📊 Metrics ",
      columnSpacing: 2,
      columnWidth: [18, 15],
      border: {
        type: "line",
        fg: "cyan",
      },
    });

    // Positions table (right side, rows 1-4)
    this.positionsTable = this.grid.set(1, 6, 4, 6, contrib.table, {
      keys: true,
      fg: "white",
      label: " 💼 Positions ",
      columnSpacing: 1,
      columnWidth: [20, 6, 8, 8, 10],
      border: {
        type: "line",
        fg: "cyan",
      },
    });

    // Recent trades log (left side, rows 5-8)
    this.tradesLog = this.grid.set(5, 0, 4, 6, contrib.log, {
      fg: "green",
      label: " 📈 Recent Trades ",
      border: {
        type: "line",
        fg: "cyan",
      },
    });

    // Whale activity log (right side, rows 5-8)
    this.whaleLog = this.grid.set(5, 6, 4, 6, contrib.log, {
      fg: "yellow",
      label: " 🐋 Whale Activity ",
      border: {
        type: "line",
        fg: "cyan",
      },
    });

    // Status bar (bottom)
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 1,
      content: " Press {bold}q{/bold} to quit | {bold}r{/bold} to refresh ",
      tags: true,
      style: {
        fg: "white",
        bg: "blue",
      },
    });
  }

  /**
   * Get header content
   */
  private getHeaderContent(): string {
    const modeColor = this.isLiveTrading ? "green" : "yellow";
    const modeText = this.isLiveTrading ? "LIVE" : "SIMULATION";
    const wsStatus = this.metrics.wsConnected
      ? "{green-fg}●{/green-fg}"
      : "{red-fg}●{/red-fg}";

    return ` {bold}{cyan-fg}POLYMARKET BOT{/cyan-fg}{/bold} | Mode: {${modeColor}-fg}${modeText}{/${modeColor}-fg} | WebSocket: ${wsStatus} | Uptime: ${this.formatUptime()}`;
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
   * Setup key bindings
   */
  private setupKeyBindings(): void {
    if (!this.screen) return;

    this.screen.key(["escape", "q", "C-c"], () => {
      this.stop();
      process.exit(0);
    });

    this.screen.key(["r"], () => {
      this.refresh();
    });
  }

  /**
   * Start auto-refresh
   */
  private startRefresh(): void {
    this.refreshInterval = setInterval(() => {
      this.refresh();
    }, this.config.refreshIntervalMs);
  }

  /**
   * Refresh the dashboard
   */
  private refresh(): void {
    if (!this.screen) return;

    // Update header
    if (this.headerBox) {
      this.headerBox.setContent(this.getHeaderContent());
    }

    // Update metrics table
    if (this.metricsTable) {
      this.metricsTable.setData({
        headers: ["Metric", "Value"],
        data: [
          ["USDC Balance", `$${this.metrics.usdcBalance.toFixed(2)}`],
          ["POL Balance", `${this.metrics.polBalance.toFixed(2)}`],
          [
            "Effective Bankroll",
            `$${this.metrics.effectiveBankroll.toFixed(2)}`,
          ],
          ["Reserve", `$${this.metrics.reserveUsd.toFixed(2)}`],
          ["─────────────", "─────────────"],
          ["Total Trades", `${this.metrics.totalTrades}`],
          ["Win Rate", `${(this.metrics.winRate * 100).toFixed(1)}%`],
          ["Total P&L", this.formatPnl(this.metrics.totalPnl)],
          ["EV (cents)", `${this.metrics.evCents.toFixed(2)}¢`],
          ["─────────────", "─────────────"],
          [
            "Positions",
            `${this.metrics.openPositions}/${this.metrics.maxPositions}`,
          ],
          [
            "Deployed",
            `$${this.metrics.deployedUsd.toFixed(2)} (${this.metrics.deployedPercent.toFixed(0)}%)`,
          ],
          ["API Latency", `${this.metrics.apiLatencyMs}ms`],
        ],
      });
    }

    // Update positions table
    if (this.positionsTable) {
      const posData =
        this.positions.length > 0
          ? this.positions.map((p) => [
              p.market.substring(0, 18),
              p.side,
              `$${p.size.toFixed(0)}`,
              `${(p.currentPrice * 100).toFixed(0)}¢`,
              this.formatPnl(p.pnl),
            ])
          : [["No open positions", "", "", "", ""]];

      this.positionsTable.setData({
        headers: ["Market", "Side", "Size", "Price", "P&L"],
        data: posData,
      });
    }

    this.screen.render();
  }

  /**
   * Format P&L with color indicators
   */
  private formatPnl(pnl: number): string {
    const sign = pnl >= 0 ? "+" : "";
    return `${sign}$${pnl.toFixed(2)}`;
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC UPDATE METHODS - Called from main bot loop
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Update trading mode
   */
  setTradingMode(isLive: boolean): void {
    this.isLiveTrading = isLive;
    this.mode = isLive ? "LIVE" : "SIMULATION";
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
  updatePositions(positions: DashboardPosition[]): void {
    this.positions = positions;
  }

  /**
   * Log a trade
   */
  logTrade(trade: DashboardTrade): void {
    this.recentTrades.unshift(trade);
    if (this.recentTrades.length > 50) {
      this.recentTrades.pop();
    }

    if (this.tradesLog) {
      const color = trade.side === "BUY" ? "{green-fg}" : "{red-fg}";
      const statusColor =
        trade.status === "✓"
          ? "{green-fg}"
          : trade.status === "✗"
            ? "{red-fg}"
            : "{yellow-fg}";
      this.tradesLog.log(
        `${trade.time} ${color}${trade.side}{/} ${trade.market.substring(0, 15)} $${trade.size.toFixed(0)} @${(trade.price * 100).toFixed(0)}¢ ${statusColor}${trade.status}{/}`,
      );
    }
  }

  /**
   * Log whale activity
   */
  logWhaleActivity(activity: DashboardWhaleActivity): void {
    this.whaleActivity.unshift(activity);
    if (this.whaleActivity.length > 50) {
      this.whaleActivity.pop();
    }

    if (this.whaleLog) {
      const color = activity.side === "BUY" ? "{green-fg}" : "{red-fg}";
      const copiedText = activity.copied ? "{cyan-fg}COPIED{/}" : "";
      this.whaleLog.log(
        `${activity.time} 🐋 ${activity.wallet.substring(0, 8)}... ${color}${activity.side}{/} $${activity.size.toFixed(0)} ${activity.market.substring(0, 12)} ${copiedText}`,
      );
    }
  }

  /**
   * Log a general message
   */
  log(message: string): void {
    if (this.tradesLog) {
      this.tradesLog.log(message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let globalDashboard: Dashboard | null = null;

/**
 * Get the global dashboard instance
 */
export function getDashboard(): Dashboard | null {
  return globalDashboard;
}

/**
 * Initialize the dashboard
 */
export function initDashboard(
  config: Partial<DashboardConfig> = {},
): Dashboard {
  globalDashboard = new Dashboard(config);
  return globalDashboard;
}

/**
 * Check if dashboard mode should be used (vs traditional logging)
 */
export function shouldUseDashboard(): boolean {
  const enabled = process.env.DASHBOARD_ENABLED?.toLowerCase();
  // Dashboard is DISABLED by default to maintain backward compatibility with traditional logging
  // Enable with DASHBOARD_ENABLED=true
  return enabled === "true" || enabled === "1" || enabled === "yes";
}
