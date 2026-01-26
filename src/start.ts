/**
 * Entry Point - Switches between V1 (old) and V2 (new simple)
 * 
 * ENV:
 *   USE_V2=true  - Use new simple system
 *   USE_V2=false - Use old system (default)
 */

// Load environment variables from .env file
import "dotenv/config";

async function main() {
  const useV2 = process.env.USE_V2?.toLowerCase() === "true";
  
  if (useV2) {
    console.log("🚀 Starting V2 (simple) system...\n");
    const { startV2 } = await import("./v2");
    await startV2();
  } else {
    console.log("🚀 Starting V1 (legacy) system...\n");
    // Import and run the old main
    await import("./app/main");
  }
}

main().catch(err => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
