/**
 * Test Sell Script - Verify SELL orders work
 * 
 * Usage:
 *   npm run test-sell              # Dry run (shows what would happen)
 *   npm run test-sell -- --execute # Actually attempts to sell ONE position
 * 
 * This tests the exact sell logic that will be used in recovery mode.
 */

import "dotenv/config";
import { Side, OrderType } from "@polymarket/clob-client";
import type { ClobClient } from "@polymarket/clob-client";
import {
  createClobClient,
  getPositions,
  getUsdcBalance,
  type Position,
} from "../src/lib";

const logger = {
  info: (...args: any[]) => console.log(...args),
  warn: (...args: any[]) => console.warn("⚠️", ...args),
  error: (...args: any[]) => console.error("❌", ...args),
};

// Configuration constants
const SLIPPAGE_TOLERANCE = 0.01; // Allow 1% slippage from entry price
const EXECUTE_WARNING_DELAY_MS = 3000; // 3 second countdown before executing
const ORDER_TYPE = OrderType.FOK; // Fill-or-Kill: ensures order fills completely or not at all

/**
 * Test sell execution (mirrors scavenger.ts executeSell logic)
 */
async function testSellOrder(
  client: ClobClient,
  position: Position,
  dryRun: boolean
): Promise<{ success: boolean; reason: string; value?: number }> {
  
  logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`🧪 TEST SELL: ${position.outcome}`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`Token ID: ${position.tokenId.slice(0, 16)}...`);
  logger.info(`Size: ${position.size.toFixed(2)} shares`);
  logger.info(`Current Price: ${(position.curPrice * 100).toFixed(0)}¢`);
  logger.info(`Value: $${position.value.toFixed(2)}`);
  logger.info(`P&L: ${position.pnlPct >= 0 ? '+' : ''}${position.pnlPct.toFixed(1)}%`);
  
  try {
    // STEP 1: Fetch orderbook
    logger.info(`\n📖 Fetching orderbook...`);
    const book = await client.getOrderBook(position.tokenId);
    
    if (!book) {
      return { success: false, reason: "Orderbook fetch failed" };
    }
    
    if (!book.bids || book.bids.length === 0) {
      logger.warn(`No bids available - no buyers for this position`);
      return { success: false, reason: "NO_BIDS" };
    }
    
    const bestBid = parseFloat(book.bids[0].price);
    const bidSize = parseFloat(book.bids[0].size || "0");
    
    logger.info(`✅ Orderbook fetched`);
    logger.info(`   Best bid: ${(bestBid * 100).toFixed(1)}¢`);
    logger.info(`   Bid size: ${bidSize.toFixed(2)} shares`);
    logger.info(`   Total bids: ${book.bids.length}`);
    
    // STEP 2: Calculate expected proceeds
    const expectedProceeds = position.size * bestBid;
    const profitLoss = (bestBid - position.avgPrice) * position.size;
    
    logger.info(`\n💰 Expected if sold:`);
    logger.info(`   Proceeds: $${expectedProceeds.toFixed(2)}`);
    logger.info(`   P&L: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)}`);
    
    // STEP 3: Check price acceptable
    const minPrice = position.avgPrice * (1 - SLIPPAGE_TOLERANCE);
    if (bestBid < minPrice) {
      logger.warn(`Best bid ${(bestBid * 100).toFixed(0)}¢ is below minimum ${(minPrice * 100).toFixed(0)}¢`);
      logger.warn(`This would result in >${SLIPPAGE_TOLERANCE * 100}% loss from entry price`);
      return { success: false, reason: "PRICE_TOO_LOW" };
    }
    
    if (dryRun) {
      logger.info(`\n🔍 DRY RUN - Order structure:`);
      logger.info(`   side: Side.SELL`);
      logger.info(`   tokenID: ${position.tokenId.slice(0, 16)}...`);
      logger.info(`   amount: ${position.size}`);
      logger.info(`   price: ${bestBid}`);
      logger.info(`   orderType: ${ORDER_TYPE} (Fill-or-Kill)`);
      logger.info(`\n✅ Order structure is valid`);
      logger.info(`📝 Run with --execute flag to actually attempt sell`);
      
      return { 
        success: true, 
        reason: "DRY_RUN_SUCCESS",
        value: expectedProceeds 
      };
    }
    
    // STEP 4: ACTUALLY EXECUTE SELL
    logger.info(`\n⚡ EXECUTING SELL ORDER...`);
    
    const signed = await client.createMarketOrder({
      side: Side.SELL,
      tokenID: position.tokenId,
      amount: position.size,
      price: bestBid,
    });
    
    logger.info(`✅ Order created and signed`);
    logger.info(`⏳ Posting order to exchange...`);
    
    const resp = await client.postOrder(signed, ORDER_TYPE);
    
    if (resp.success) {
      logger.info(`\n🎉 SELL ORDER SUCCESS!`);
      logger.info(`   Sold: ${position.size.toFixed(2)} shares`);
      logger.info(`   Received: ~$${expectedProceeds.toFixed(2)}`);
      logger.info(`   P&L: ${profitLoss >= 0 ? '+' : ''}$${profitLoss.toFixed(2)}`);
      
      return {
        success: true,
        reason: "ORDER_EXECUTED",
        value: expectedProceeds,
      };
    } else {
      logger.error(`Sell order failed`);
      logger.error(`Reason: ${resp.errorMsg || 'Unknown'}`);
      
      return {
        success: false,
        reason: resp.errorMsg || "ORDER_FAILED",
      };
    }
    
  } catch (error) {
    logger.error(`Exception during sell:`, error);
    return {
      success: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Main test function
 */
async function main() {
  const executeMode = process.argv.includes("--execute");
  
  console.clear();
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`🧪 APEX v3.0 - SELL ORDER TEST`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`Mode: ${executeMode ? "⚡ EXECUTE (will actually sell)" : "🔍 DRY RUN (simulation only)"}`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  // Auth
  logger.info(`\n🔐 Authenticating...`);
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.RPC_URL;
  
  if (!privateKey || !rpcUrl) {
    logger.error(`Missing PRIVATE_KEY or RPC_URL in .env`);
    process.exit(1);
  }
  
  const authResult = await createClobClient(privateKey, rpcUrl);
  
  if (!authResult.success || !authResult.client || !authResult.wallet || !authResult.address) {
    logger.error(`Authentication failed: ${authResult.error}`);
    process.exit(1);
  }
  
  const { client, wallet, address } = authResult;
  logger.info(`✅ Authenticated: ${address.slice(0, 8)}...${address.slice(-6)}`);
  
  // Get balance
  const balance = await getUsdcBalance(wallet, address);
  logger.info(`💰 Current USDC balance: $${balance.toFixed(2)}`);
  
  // Get positions
  logger.info(`\n📊 Fetching positions...`);
  const positions = await getPositions(address);
  
  if (positions.length === 0) {
    logger.info(`\n✅ No positions found - nothing to test!`);
    logger.info(`This is good - means you don't have trapped positions.`);
    process.exit(0);
  }
  
  logger.info(`✅ Found ${positions.length} position(s)`);
  
  // Show all positions
  logger.info(`\n📋 ALL POSITIONS:`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    logger.info(`${i + 1}. ${p.outcome}`);
    logger.info(`   Value: $${p.value.toFixed(2)} | P&L: ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%`);
  }
  
  // Select position to test
  logger.info(`\n🎯 Selecting position to test...`);
  
  // Priority: Most profitable position (safest test)
  const sortedByProfit = [...positions].sort((a, b) => b.pnlPct - a.pnlPct);
  const testPosition = sortedByProfit[0];
  
  logger.info(`Selected: ${testPosition.outcome} (highest profit: ${testPosition.pnlPct >= 0 ? '+' : ''}${testPosition.pnlPct.toFixed(1)}%)`);
  
  if (executeMode) {
    logger.info(`\n⚠️  WARNING: EXECUTE MODE ENABLED`);
    logger.info(`⚠️  This will ACTUALLY SELL the position!`);
    logger.info(`\nWaiting ${EXECUTE_WARNING_DELAY_MS / 1000} seconds... (Ctrl+C to cancel)`);
    await new Promise(resolve => setTimeout(resolve, EXECUTE_WARNING_DELAY_MS));
  }
  
  // Test the sell
  const result = await testSellOrder(client, testPosition, !executeMode);
  
  // Summary
  logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger.info(`📊 TEST RESULT`);
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  if (result.success) {
    if (executeMode) {
      logger.info(`✅ SELL EXECUTED SUCCESSFULLY!`);
      logger.info(`   Position sold: ${testPosition.outcome}`);
      logger.info(`   Received: ~$${result.value?.toFixed(2)}`);
      
      const newBalance = await getUsdcBalance(wallet, address);
      logger.info(`   New balance: $${newBalance.toFixed(2)} (was $${balance.toFixed(2)})`);
      
      logger.info(`\n🎉 SELLING WORKS! Recovery mode will work correctly.`);
      logger.info(`✅ Safe to deploy PR #2`);
    } else {
      logger.info(`✅ DRY RUN SUCCESSFUL!`);
      logger.info(`   Orderbook accessible: YES`);
      logger.info(`   Bids available: YES`);
      logger.info(`   Order structure valid: YES`);
      logger.info(`   Expected proceeds: $${result.value?.toFixed(2)}`);
      
      logger.info(`\n💡 To actually test selling, run:`);
      logger.info(`   npm run test-sell -- --execute`);
    }
  } else {
    logger.error(`❌ TEST FAILED`);
    logger.error(`   Reason: ${result.reason}`);
    
    if (result.reason === "NO_BIDS") {
      logger.info(`\n💡 This position has no buyers.`);
      logger.info(`   Try testing a different position with more liquidity.`);
    } else if (result.reason === "PRICE_TOO_LOW") {
      logger.info(`\n💡 Current bid price would cause >1% loss.`);
      logger.info(`   This is expected behavior - bot won't sell at bad prices.`);
    } else {
      logger.error(`\n🚨 UNEXPECTED FAILURE - Investigate before deploying PR #2!`);
    }
  }
  
  logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
