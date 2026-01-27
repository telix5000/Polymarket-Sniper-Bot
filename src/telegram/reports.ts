/**
 * APEX v3.0 - Telegram Reporting
 * 
 * Real-time, hourly, daily Oracle review, weekly progress
 */

import type { StrategyPerformance, MarketCondition } from "../core/oracle";
import type { ScalingInfo } from "../core/scaling";
import type { ReserveBreakdown } from "../core/reserves";
import type { PortfolioHealth } from "../strategies/command";

/**
 * Format real-time trade alert
 */
export function formatTradeAlert(
  action: "BUY" | "SELL",
  outcome: "YES" | "NO",
  size: number,
  price: number,
  reason: string,
): string {
  const emoji = action === "BUY" ? "🟢" : "🔴";
  return [
    `${emoji} ${action} ${outcome}`,
    `Amount: $${size.toFixed(2)}`,
    `Price: ${(price * 100).toFixed(1)}¢`,
    `Reason: ${reason}`,
  ].join("\n");
}

/**
 * Format hourly summary
 */
export function formatHourlySummary(data: {
  balance: number;
  startBalance: number;
  positions: number;
  exposure: number;
  maxExposure: number;
  tradesThisHour: number;
  winRate: number;
  pnl1h: number;
}): string {
  // Validate to prevent division by zero
  if (data.startBalance === 0 || data.maxExposure === 0) {
    return `⚠️ Invalid data: ${data.startBalance === 0 ? 'startBalance' : 'maxExposure'} is zero`;
  }

  const pnlPct = ((data.balance - data.startBalance) / data.startBalance) * 100;
  const exposurePct = (data.exposure / data.maxExposure) * 100;

  return [
    "📊 HOURLY SUMMARY",
    "",
    `💰 Balance: $${data.balance.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
    `📈 P&L (1h): ${data.pnl1h >= 0 ? "+" : ""}$${data.pnl1h.toFixed(2)}`,
    `📦 Positions: ${data.positions}`,
    `🎯 Exposure: $${data.exposure.toFixed(2)} / $${data.maxExposure.toFixed(2)} (${exposurePct.toFixed(0)}%)`,
    `📊 Trades: ${data.tradesThisHour}`,
    `✅ Win Rate: ${data.winRate.toFixed(1)}%`,
  ].join("\n");
}

/**
 * Format daily Oracle report
 */
export function formatDailyOracleReport(
  performances: StrategyPerformance[],
  marketCondition: MarketCondition,
  balance: number,
  startBalance: number,
): string {
  const pnlPct = ((balance - startBalance) / startBalance) * 100;

  const rankEmoji = {
    CHAMPION: "🏆",
    PERFORMING: "✅",
    TESTING: "🧪",
    STRUGGLING: "⚠️",
    DISABLED: "❌",
  };

  const conditionEmoji = {
    BULL: "🐂",
    NEUTRAL: "⚖️",
    BEAR: "🐻",
    VOLATILE: "🌪️",
  };

  const sorted = [...performances].sort((a, b) => b.score - a.score);

  const lines = [
    "═══════════════════════════",
    "⚡ APEX ORACLE",
    "═══════════════════════════",
    "",
    `💰 Balance: $${balance.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`,
    `📊 Market: ${conditionEmoji[marketCondition]} ${marketCondition}`,
    "",
    "🎯 STRATEGY RANKINGS:",
    "",
  ];

  for (const perf of sorted.slice(0, 5)) {
    // Top 5
    const emoji = rankEmoji[perf.rank];
    lines.push(
      `${emoji} ${perf.strategy}`,
      `   ${perf.wins}W/${perf.losses}L (${perf.winRate.toFixed(0)}%)`,
      `   P&L: $${perf.totalPnL.toFixed(2)} | Score: ${perf.score.toFixed(0)}`,
      "",
    );
  }

  lines.push("═══════════════════════════");

  return lines.join("\n");
}

/**
 * Format weekly progress report
 */
export function formatWeeklyReport(data: {
  weekStart: number;
  startBalance: number;
  currentBalance: number;
  totalTrades: number;
  winRate: number;
  bestDay: { date: string; pnl: number };
  worstDay: { date: string; pnl: number };
  topStrategy: { name: string; pnl: number };
  target: number;
}): string {
  const profit = data.currentBalance - data.startBalance;
  const profitPct = (profit / data.startBalance) * 100;
  const daysRunning = Math.floor((Date.now() - data.weekStart) / (1000 * 60 * 60 * 24));
  const progress = (data.currentBalance / data.target) * 100;

  return [
    "═══════════════════════════",
    "📈 WEEKLY PROGRESS REPORT",
    "═══════════════════════════",
    "",
    `⏱️ Running: ${daysRunning} days`,
    "",
    "💰 PERFORMANCE:",
    `   Start: $${data.startBalance.toFixed(2)}`,
    `   Now: $${data.currentBalance.toFixed(2)}`,
    `   Profit: ${profit >= 0 ? "+" : ""}$${profit.toFixed(2)} (${profitPct >= 0 ? "+" : ""}${profitPct.toFixed(2)}%)`,
    "",
    "🎯 TARGET PROGRESS:",
    `   Target: $${data.target.toFixed(2)}`,
    `   Progress: ${progress.toFixed(1)}%`,
    `   Remaining: $${(data.target - data.currentBalance).toFixed(2)}`,
    "",
    "📊 STATISTICS:",
    `   Total Trades: ${data.totalTrades}`,
    `   Win Rate: ${data.winRate.toFixed(1)}%`,
    `   Best Day: ${data.bestDay.date} (+$${data.bestDay.pnl.toFixed(2)})`,
    `   Worst Day: ${data.worstDay.date} ($${data.worstDay.pnl.toFixed(2)})`,
    "",
    "🏆 TOP PERFORMER:",
    `   ${data.topStrategy.name}: +$${data.topStrategy.pnl.toFixed(2)}`,
    "",
    "═══════════════════════════",
  ].join("\n");
}

/**
 * Format startup configuration
 */
export function formatStartupConfig(
  mode: string,
  scalingInfo: ScalingInfo,
  reserves: ReserveBreakdown,
): string {
  return [
    "⚡ APEX STARTUP",
    "",
    `🎯 Mode: ${mode}`,
    `💰 Balance: $${scalingInfo.balance.toFixed(2)}`,
    `🏆 Tier: ${scalingInfo.tier.description} (${scalingInfo.tier.multiplier}×)`,
    `📦 Base Position: $${scalingInfo.basePositionSize.toFixed(2)}`,
    `🎯 Max Exposure: $${scalingInfo.maxExposure.toFixed(2)}`,
    "",
    "💎 RESERVES:",
    `   Hedge: $${reserves.hedgeReserve.toFixed(2)}`,
    `   POL: $${reserves.polReserve.toFixed(2)}`,
    `   Emergency: $${reserves.emergencyReserve.toFixed(2)}`,
    `   Available: $${reserves.availableForTrading.toFixed(2)}`,
    "",
    "✅ System Ready!",
  ].join("\n");
}

/**
 * Format alert message
 */
export function formatAlert(
  type: "WARNING" | "ERROR" | "INFO" | "SUCCESS",
  message: string,
): string {
  const emoji = {
    WARNING: "⚠️",
    ERROR: "❌",
    INFO: "ℹ️",
    SUCCESS: "✅",
  };

  return `${emoji[type]} ${type}: ${message}`;
}

/**
 * Format portfolio health
 */
export function formatPortfolioHealth(health: PortfolioHealth): string {
  const riskLevel =
    health.riskScore > 70 ? "🔴 HIGH" : health.riskScore > 40 ? "🟡 MEDIUM" : "🟢 LOW";

  return [
    "💼 PORTFOLIO HEALTH",
    "",
    `Positions: ${health.greenPositions}🟢 / ${health.redPositions}🔴`,
    `Total Value: $${health.totalValue.toFixed(2)}`,
    `Avg P&L: ${health.avgPnL >= 0 ? "+" : ""}${health.avgPnL.toFixed(1)}%`,
    `Risk: ${riskLevel} (${health.riskScore.toFixed(0)}/100)`,
  ].join("\n");
}
