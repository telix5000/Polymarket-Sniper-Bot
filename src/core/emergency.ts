/**
 * Emergency Sell Configuration
 * 
 * Modes:
 * - CONSERVATIVE: Won't sell below 50% of entry price
 * - MODERATE: Won't sell below 20% of entry price
 * - NUCLEAR: Sells at ANY price (no protection)
 */

export type EmergencyMode = 'CONSERVATIVE' | 'MODERATE' | 'NUCLEAR';

export interface EmergencySellConfig {
  mode: EmergencyMode;
  balanceThreshold: number; // Activate emergency when balance < this
  minPriceMultiplier: number; // 0.5 = 50%, 0.2 = 20%, 0 = no limit
}

/**
 * Get emergency sell configuration from environment
 */
export function getEmergencySellConfig(): EmergencySellConfig {
  const mode = (process.env.EMERGENCY_SELL_MODE || 'CONSERVATIVE') as EmergencyMode;
  const balanceThreshold = parseFloat(process.env.EMERGENCY_BALANCE_THRESHOLD || '5');
  
  let minPriceMultiplier: number;
  switch (mode) {
    case 'CONSERVATIVE':
      minPriceMultiplier = 0.50; // Won't sell below 50% of entry
      break;
    case 'MODERATE':
      minPriceMultiplier = 0.20; // Won't sell below 20% of entry
      break;
    case 'NUCLEAR':
      minPriceMultiplier = 0.0; // No protection - sells at ANY price
      break;
    default:
      minPriceMultiplier = 0.50;
  }
  
  return {
    mode,
    balanceThreshold,
    minPriceMultiplier,
  };
}

/**
 * Calculate minimum acceptable price for emergency sell
 * 
 * @param entryPrice - Original entry price (avgPrice)
 * @param config - Emergency sell configuration
 * @returns Minimum acceptable price, or undefined for no protection
 */
export function calculateEmergencyMinPrice(
  entryPrice: number,
  config: EmergencySellConfig
): number | undefined {
  if (config.mode === 'NUCLEAR') {
    return undefined; // No price protection
  }
  
  return entryPrice * config.minPriceMultiplier;
}

/**
 * Check if emergency sell mode should be activated
 */
export function shouldActivateEmergencySells(
  balance: number,
  config: EmergencySellConfig
): boolean {
  return balance < config.balanceThreshold;
}

/**
 * Log emergency sell configuration
 */
export function logEmergencyConfig(config: EmergencySellConfig, logger?: { 
  info?: (msg: string) => void; 
  warn?: (msg: string) => void; 
}): void {
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger?.info?.(`🚨 EMERGENCY SELL MODE: ${config.mode}`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  if (config.mode === 'CONSERVATIVE') {
    logger?.info?.(`   Protection: Won't sell below 50% of entry price`);
    logger?.info?.(`   Example: 67¢ entry → Won't sell below 34¢`);
  } else if (config.mode === 'MODERATE') {
    logger?.info?.(`   Protection: Won't sell below 20% of entry price`);
    logger?.info?.(`   Example: 67¢ entry → Won't sell below 13¢`);
  } else if (config.mode === 'NUCLEAR') {
    logger?.warn?.(`   ⚠️  NO PROTECTION - Will sell at ANY price!`);
    logger?.warn?.(`   ⚠️  This may result in massive losses!`);
  }
  
  logger?.info?.(`   Activate when balance < $${config.balanceThreshold.toFixed(2)}`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}
