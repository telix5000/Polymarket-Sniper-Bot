/**
 * APEX v3.0 - Startup Banner
 */

import type { ModeConfig } from "../core/modes";
import type { ScalingInfo } from "../core/scaling";

/**
 * Generate APEX ASCII art banner
 */
export function generateApexBanner(mode: ModeConfig, scalingInfo: ScalingInfo): string {
  const banner = `
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                                                              ┃
┃      ⚡  █████╗ ██████╗ ███████╗██╗  ██╗  ⚡               ┃
┃         ██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝                   ┃
┃         ███████║██████╔╝█████╗   ╚███╔╝                    ┃
┃         ██╔══██║██╔═══╝ ██╔══╝   ██╔██╗                    ┃
┃         ██║  ██║██║     ███████╗██╔╝ ██╗                   ┃
┃         ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝                   ┃
┃                                                              ┃
┃              AGGRESSIVE POLYMARKET EXECUTION                 ┃
┃                      Version 3.0                             ┃
┃                                                              ┃
┃                 ⚡ ${mode.name.padEnd(11)} MODE ⚡                        ┃
┃                 🌍 24/7 NEVER SLEEPS 🌍                     ┃
┃                                                              ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
`;

  const config = `
╔═══════════════════════════════════════════════════════════╗
║                     CONFIGURATION                         ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  💰 Balance:          $${scalingInfo.balance.toFixed(2).padEnd(10)}                      ║
║  🏆 Tier:             ${scalingInfo.tier.description.padEnd(20)}   ║
║  📊 Tier Multiplier:  ${scalingInfo.tier.multiplier.toFixed(1)}×                               ║
║                                                           ║
║  🎯 Base Position:    $${scalingInfo.basePositionSize.toFixed(2).padEnd(10)}                      ║
║  🎯 Max Exposure:     $${scalingInfo.maxExposure.toFixed(2).padEnd(10)} (${mode.maxExposurePct}%)              ║
║  📈 Weekly Target:    +${mode.weeklyTargetPct}%                              ║
║  🛑 Drawdown Halt:    -${mode.drawdownHaltPct}%                              ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║                    STRATEGY POSITIONS                     ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  ⚡ VELOCITY (Momentum):    $${scalingInfo.strategyPositions.VELOCITY.toFixed(2).padEnd(6)}             ║
║  👤 SHADOW (Copy):          $${scalingInfo.strategyPositions.SHADOW.toFixed(2).padEnd(6)}             ║
║  🎯 CLOSER (Endgame):       $${scalingInfo.strategyPositions.CLOSER.toFixed(2).padEnd(6)}             ║
║  💎 AMPLIFIER (Stack):      $${scalingInfo.strategyPositions.AMPLIFIER.toFixed(2).padEnd(6)}             ║
║  🔄 GRINDER (Volume):       $${scalingInfo.strategyPositions.GRINDER.toFixed(2).padEnd(6)}             ║
║  🎯 HUNTER (Scanner):       $${scalingInfo.strategyPositions.HUNTER.toFixed(2).padEnd(6)}             ║
║  ⚡ BLITZ (Quick Scalp):    $${scalingInfo.strategyPositions.BLITZ.toFixed(2).padEnd(6)}             ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║                   PROTECTION MODULES                      ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  🛡️  SHIELD       - Intelligent Hedging                  ║
║  🛡️  GUARDIAN     - Stop Loss Protection                 ║
║  🚨 SENTINEL     - Emergency Exit (<5min)                ║
║  🔥 FIREWALL     - Circuit Breaker                       ║
║  🎮 COMMAND      - Portfolio Manager                     ║
║  ⚡ RATCHET      - Trailing Stops                        ║
║  📊 LADDER       - Partial Exits                         ║
║  💀 REAPER       - Scavenger Mode                        ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║                   INTELLIGENCE LAYER                      ║
╠═══════════════════════════════════════════════════════════╣
║                                                           ║
║  🧠 BRAIN        - Intelligent Reserves                  ║
║  📈 MULTIPLIER   - Dynamic Scaling                       ║
║  🔮 ORACLE       - Daily Optimizer (24h review)          ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`;

  return banner + config;
}

/**
 * Get mode-specific emoji
 */
export function getModeEmoji(modeName: string): string {
  switch (modeName) {
    case "AGGRESSIVE":
      return "🔥";
    case "BALANCED":
      return "⚖️";
    case "CONSERVATIVE":
      return "🛡️";
    default:
      return "⚡";
  }
}

/**
 * Format system status line
 */
export function formatStatusLine(
  balance: number,
  positions: number,
  exposure: number,
  pnl: number,
): string {
  const pnlColor = pnl >= 0 ? "🟢" : "🔴";
  return `[${new Date().toISOString().substring(11, 19)}] ${pnlColor} $${balance.toFixed(2)} | ${positions} pos | $${exposure.toFixed(2)} exp | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%`;
}
