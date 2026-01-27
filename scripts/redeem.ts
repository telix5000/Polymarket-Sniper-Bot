/**
 * Standalone Redeem Script
 * Run: npm run redeem
 *
 * Redeems all resolved positions and claims payouts
 */

import "dotenv/config";
import { createClobClient, redeemAllPositions, getUsdcBalance } from "../src/lib";

const logger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn("⚠️", ...args),
  error: (...args: any[]) => console.error("❌", ...args),
  debug: (...args: any[]) => {
    if (process.env.DEBUG) console.log("🔍", ...args);
  },
};

async function main() {
  console.clear();

  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`🎁 POLYMARKET AUTO-REDEEM`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(``);

  // Auth
  logger.info(`🔐 Authenticating...`);
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;

  if (!privateKey || !rpcUrl) {
    logger.error(`Missing PRIVATE_KEY or RPC_URL in .env`);
    process.exit(1);
  }

  const authResult = await createClobClient(privateKey, rpcUrl);

  if (!authResult.success || !authResult.wallet || !authResult.address) {
    logger.error(`Authentication failed: ${authResult.error}`);
    process.exit(1);
  }

  const { wallet, address } = authResult;
  logger.info(`✅ Authenticated: ${address.slice(0, 8)}...${address.slice(-6)}`);
  logger.info(``);

  // Check balance before
  const balanceBefore = await wallet.provider!.getBalance(address);
  logger.info(`💰 POL Balance: ${(parseFloat(balanceBefore.toString()) / 1e18).toFixed(4)} POL`);

  // Check USDC balance before
  const usdcBefore = await getUsdcBalance(wallet, address);
  logger.info(`💵 USDC Balance: $${usdcBefore.toFixed(2)}`);
  logger.info(``);

  // Redeem all positions
  const result = await redeemAllPositions(wallet, address, logger);

  // Summary
  logger.info(``);

  if (result.redeemed === 0) {
    logger.info(`✅ No positions were redeemed`);
    logger.info(`   This means either:`);
    logger.info(`   • No resolved markets found`);
    logger.info(`   • Already redeemed previously`);
    logger.info(`   • All positions in active markets (check with npm start)`);
  } else {
    logger.info(`🎉 SUCCESS!`);
    logger.info(`   Redeemed ${result.redeemed} market(s)`);
    logger.info(`   Approximate value: $${result.totalValue.toFixed(2)}`);
    logger.info(``);

    // Check USDC balance after
    try {
      const usdcAfter = await getUsdcBalance(wallet, address);
      const usdcGain = usdcAfter - usdcBefore;
      logger.info(`💰 New USDC Balance: $${usdcAfter.toFixed(2)}`);
      if (usdcGain > 0) {
        logger.info(`   Gained: +$${usdcGain.toFixed(2)} 🎉`);
      }
      logger.info(``);
    } catch (err) {
      logger.warn(`Could not fetch updated USDC balance`);
    }

    logger.info(`💡 Tip: Run 'npm start' to see your updated balance`);
  }

  if (result.failed > 0) {
    logger.warn(`⚠️  ${result.failed} redemption(s) failed`);
    logger.warn(`   Check logs above for error details`);
    logger.warn(`   You can retry by running: npm run redeem`);
  }

  logger.info(``);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
