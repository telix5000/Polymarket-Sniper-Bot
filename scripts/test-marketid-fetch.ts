/**
 * Test script to verify marketId fetching and caching
 * 
 * This script demonstrates that:
 * 1. marketId is fetched from Gamma API
 * 2. Results are cached to avoid repeated API calls
 * 3. The marketId is properly populated in TokenMarketData
 */

import { fetchMarketByTokenId } from "../src/lib/market";

async function testMarketIdFetch() {
  console.log("🧪 Testing marketId fetch and caching...\n");

  // Test with a known token (this is a sample - replace with actual token if needed)
  const testTokenId = "21742633143463906290569050155826241533067272736897614950488156847949938836455";
  
  console.log(`📋 Test 1: Fetching market info for token ${testTokenId.slice(0, 16)}...`);
  
  try {
    const startTime = Date.now();
    const marketInfo = await fetchMarketByTokenId(testTokenId);
    const elapsedTime = Date.now() - startTime;
    
    if (marketInfo) {
      console.log(`✅ Success! (${elapsedTime}ms)`);
      console.log(`   marketId: ${marketInfo.marketId}`);
      console.log(`   conditionId: ${marketInfo.conditionId.slice(0, 16)}...`);
      console.log(`   question: ${marketInfo.question?.slice(0, 50) || "N/A"}...`);
      console.log(`   tokens: ${marketInfo.tokens.length}`);
      
      for (const token of marketInfo.tokens) {
        console.log(`     - ${token.outcomeLabel} (idx=${token.outcomeIndex}): ${token.tokenId.slice(0, 16)}...`);
      }
      
      // Test 2: Fetch again to verify caching
      console.log(`\n📋 Test 2: Fetching same token again (should be cached)...`);
      const startTime2 = Date.now();
      const marketInfo2 = await fetchMarketByTokenId(testTokenId);
      const elapsedTime2 = Date.now() - startTime2;
      
      console.log(`✅ Success! (${elapsedTime2}ms - ${elapsedTime2 < elapsedTime ? "faster, using cache!" : "similar speed"})`);
      console.log(`   marketId matches: ${marketInfo2?.marketId === marketInfo.marketId ? "✓" : "✗"}`);
      
    } else {
      console.log(`❌ Failed: No market info returned`);
    }
  } catch (err) {
    console.error(`❌ Error: ${err instanceof Error ? err.message : err}`);
  }
  
  console.log("\n✅ Test complete!");
}

// Run the test
testMarketIdFetch().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
