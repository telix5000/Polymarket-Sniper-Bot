/**
 * APEX v3.0 - Trading Modes
 * 
 * THREE MODES: CONSERVATIVE, BALANCED, AGGRESSIVE
 * One-line configuration: APEX_MODE=AGGRESSIVE
 */

export type ApexMode = "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE";

export interface ModeConfig {
  name: ApexMode;
  basePositionPct: number;      // Base position size as % of balance
  maxExposurePct: number;        // Max total exposure as % of balance
  weeklyTargetPct: number;       // Weekly profit target
  drawdownHaltPct: number;       // Circuit breaker threshold
  description: string;
}

export const APEX_MODES: Record<ApexMode, ModeConfig> = {
  CONSERVATIVE: {
    name: "CONSERVATIVE",
    basePositionPct: 5,
    maxExposurePct: 60,
    weeklyTargetPct: 12,
    drawdownHaltPct: 10,
    description: "Safe & Steady - 5% positions, 60% max exposure",
  },
  BALANCED: {
    name: "BALANCED",
    basePositionPct: 7,
    maxExposurePct: 70,
    weeklyTargetPct: 18,
    drawdownHaltPct: 12,
    description: "Moderate Growth - 7% positions, 70% max exposure",
  },
  AGGRESSIVE: {
    name: "AGGRESSIVE",
    basePositionPct: 10,
    maxExposurePct: 80,
    weeklyTargetPct: 25,
    drawdownHaltPct: 15,
    description: "Maximum Performance - 10% positions, 80% max exposure",
  },
};

/**
 * Get mode configuration from environment
 */
export function getApexMode(): ModeConfig {
  const modeEnv = process.env.APEX_MODE?.toUpperCase() as ApexMode;
  
  if (modeEnv && APEX_MODES[modeEnv]) {
    return APEX_MODES[modeEnv];
  }
  
  // Default to BALANCED if not specified
  return APEX_MODES.BALANCED;
}

/**
 * Validate mode selection
 */
export function validateMode(mode: string): mode is ApexMode {
  return mode === "CONSERVATIVE" || mode === "BALANCED" || mode === "AGGRESSIVE";
}
