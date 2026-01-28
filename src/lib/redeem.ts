/**
 * Auto-Redeem for Resolved Markets
 * Based on Milan's proven polymarketredeemer
 * https://github.com/milanzandbak/polymarketredeemer
 */

import { ethers, type Wallet } from "ethers";
import axios from "axios";
import { POLYGON, POLYMARKET_API, CTF_ABI, PROXY_ABI } from "./constants";
import type { Logger } from "./types";

export interface RedeemablePosition {
  conditionId: string;
  marketId: string;
  question?: string;
  outcome: string;
  size: number;
  value: number;
}

export interface RedeemResult {
  success: boolean;
  conditionId: string;
  txHash?: string;
  error?: string;
  valueRedeemed?: number;
}

/**
 * Proxy wallet cache to avoid redundant API calls
 */
interface ProxyWalletCache {
  address: string;
  proxyAddress: string | null;
  timestamp: number;
}

let proxyWalletCache: ProxyWalletCache | null = null;
const PROXY_CACHE_TTL = 60000; // 1 minute

/**
 * Get proxy wallet address with caching
 */
async function getProxyAddress(
  address: string,
  logger?: Logger,
): Promise<string | null> {
  // Check cache
  if (
    proxyWalletCache &&
    proxyWalletCache.address === address &&
    Date.now() - proxyWalletCache.timestamp < PROXY_CACHE_TTL
  ) {
    return proxyWalletCache.proxyAddress;
  }

  // Fetch from API
  try {
    const profileRes = await axios.get(
      `${POLYMARKET_API.DATA}/profile?address=${address}`,
      { timeout: 10000 },
    );

    const proxyAddress = profileRes.data?.proxyAddress
      ? cleanAddress(profileRes.data.proxyAddress)
      : null;

    if (proxyAddress) {
      logger?.debug?.(`Found proxy wallet: ${proxyAddress.slice(0, 8)}...`);
    }

    // Update cache
    proxyWalletCache = {
      address,
      proxyAddress,
      timestamp: Date.now(),
    };

    return proxyAddress;
  } catch (err) {
    logger?.debug?.(`No proxy wallet found (using main wallet)`);
    return null;
  }
}

/**
 * Clean and validate Ethereum address
 */
function cleanAddress(addr: string | undefined): string | null {
  if (!addr) return null;
  // ethers.getAddress validates and checksums the address
  try {
    return ethers.getAddress(addr.toLowerCase());
  } catch {
    return null;
  }
}

/**
 * Fetch redeemable positions from Polymarket API
 * These are positions in resolved markets that can be claimed
 *
 * NOTE: Uses EOA address directly - the API handles proxy wallet lookup internally
 * (Same approach as positions.ts getPositions)
 */
export async function fetchRedeemablePositions(
  address: string,
  logger?: Logger,
): Promise<RedeemablePosition[]> {
  try {
    console.log(
      `🎁 [Redeem] Fetching redeemable positions for ${address.slice(0, 10)}...`,
    );

    // Use EOA address directly - API handles proxy wallet lookup internally
    // Use sizeThreshold=0 to include ALL positions (even $0 value losers that need clearing)
    const url = `${POLYMARKET_API.DATA}/positions?user=${address}&redeemable=true&sizeThreshold=0&limit=500`;
    console.log(
      `🎁 [Redeem] Querying: ${url.replace(address, address.slice(0, 10) + "...")}`,
    );

    const posRes = await axios.get(url, { timeout: 15000 });

    if (!posRes.data || !Array.isArray(posRes.data)) {
      console.log(
        `🎁 [Redeem] API returned invalid data: ${typeof posRes.data}`,
      );
      return [];
    }

    console.log(
      `🎁 [Redeem] API returned ${posRes.data.length} redeemable position(s)`,
    );

    if (posRes.data.length === 0) {
      return [];
    }

    // Log raw data for debugging
    for (const pos of posRes.data.slice(0, 3)) {
      console.log(
        `🎁 [Redeem]   - conditionId: ${pos.conditionId?.slice(0, 16)}... size: ${pos.size} value: ${pos.value || 0}`,
      );
    }
    if (posRes.data.length > 3) {
      console.log(`🎁 [Redeem]   ... and ${posRes.data.length - 3} more`);
    }

    // Group by conditionId (each market has one conditionId)
    const conditionMap = new Map<string, RedeemablePosition>();

    for (const pos of posRes.data) {
      if (!pos.conditionId) {
        console.log(`🎁 [Redeem] Skipping position without conditionId`);
        continue;
      }

      const existing = conditionMap.get(pos.conditionId);
      const size = Number(pos.size) || 0;
      // Value might be 0 for losing positions - that's OK, we still need to redeem them!
      const value =
        Number(pos.value) || Number(pos.size) * Number(pos.curPrice || 0) || 0;

      if (existing) {
        // Aggregate positions in same market
        existing.size += size;
        existing.value += value;
      } else {
        conditionMap.set(pos.conditionId, {
          conditionId: pos.conditionId,
          marketId: pos.marketId || pos.market || "unknown",
          question: pos.question || pos.marketQuestion,
          outcome: pos.outcome || "Unknown",
          size: size,
          value: value,
        });
      }
    }

    const redeemable = Array.from(conditionMap.values());

    console.log(
      `🎁 [Redeem] Grouped into ${redeemable.length} unique market(s) to redeem`,
    );
    logger?.info?.(`📦 Found ${redeemable.length} redeemable market(s)`);

    return redeemable;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `🎁 [Redeem] Failed to fetch redeemable positions: ${errorMsg}`,
    );
    logger?.error?.(`Failed to fetch redeemable positions: ${errorMsg}`);
    return [];
  }
}

/**
 * Redeem a single position using CTF contract
 * Based on Milan's proven logic
 */
export async function redeemPosition(
  conditionId: string,
  wallet: Wallet,
  address: string,
  logger?: Logger,
): Promise<RedeemResult> {
  try {
    console.log(
      `🎁 [Redeem] Starting redemption for conditionId: ${conditionId.slice(0, 16)}...`,
    );
    logger?.info?.(`🔄 Redeeming: ${conditionId.slice(0, 16)}...`);

    const provider = wallet.provider;
    if (!provider) {
      throw new Error("Wallet has no provider");
    }

    // Check for proxy wallet (cached)
    const proxyAddress = await getProxyAddress(address, logger);
    console.log(
      `🎁 [Redeem] Proxy address: ${proxyAddress ? proxyAddress.slice(0, 10) + "..." : "none (using EOA)"}`,
    );

    // Get current gas prices (Milan uses 130% of current for faster confirmation)
    const feeData = await provider.getFeeData();
    const maxPriorityFee = feeData.maxPriorityFeePerGas
      ? (feeData.maxPriorityFeePerGas * 130n) / 100n
      : undefined;
    const maxFee = feeData.maxFeePerGas
      ? (feeData.maxFeePerGas * 130n) / 100n
      : undefined;

    const txDetails: {
      maxPriorityFeePerGas?: bigint;
      maxFeePerGas?: bigint;
    } = {};
    if (maxPriorityFee) txDetails.maxPriorityFeePerGas = maxPriorityFee;
    if (maxFee) txDetails.maxFeePerGas = maxFee;

    // Create CTF interface
    const ctfInterface = new ethers.Interface(CTF_ABI);

    // Encode redemption call
    // indexSets [1, 2] covers both YES and NO outcomes
    const redeemData = ctfInterface.encodeFunctionData("redeemPositions", [
      POLYGON.USDC_ADDRESS,
      ethers.ZeroHash, // parentCollectionId (always zero for Polymarket)
      conditionId,
      [1, 2], // Both outcome indexes
    ]);

    let tx;

    // If using proxy wallet, route through proxy contract
    // Both addresses are checksummed via cleanAddress/ethers.getAddress,
    // so direct comparison is safe for detecting proxy vs. direct wallet
    if (proxyAddress && proxyAddress !== address) {
      console.log(`🎁 [Redeem] Using proxy wallet for redemption`);
      logger?.debug?.(`Using proxy wallet: ${proxyAddress.slice(0, 8)}...`);
      const proxyContract = new ethers.Contract(
        proxyAddress,
        PROXY_ABI,
        wallet,
      );
      tx = await proxyContract.proxy(
        POLYGON.CTF_ADDRESS,
        redeemData,
        txDetails,
      );
    } else {
      // Direct redemption (no proxy)
      console.log(`🎁 [Redeem] Direct redemption (no proxy)`);
      logger?.debug?.(`Direct redemption (no proxy)`);
      const ctfContract = new ethers.Contract(
        POLYGON.CTF_ADDRESS,
        CTF_ABI,
        wallet,
      );
      tx = await ctfContract.redeemPositions(
        POLYGON.USDC_ADDRESS,
        ethers.ZeroHash,
        conditionId,
        [1, 2],
        txDetails,
      );
    }

    console.log(`🎁 [Redeem] ⏳ Transaction sent: ${tx.hash}`);
    logger?.info?.(`⏳ Transaction sent: ${tx.hash.slice(0, 16)}...`);

    // Wait for confirmation with 45 second timeout
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Transaction timeout after 45s")),
          45000,
        );
      });

      const receipt = await Promise.race([tx.wait(), timeoutPromise]);

      console.log(`🎁 [Redeem] ✅ Confirmed in block ${receipt.blockNumber}`);
      logger?.info?.(`✅ Confirmed in block ${receipt.blockNumber}`);

      return {
        success: true,
        conditionId,
        txHash: tx.hash,
      };
    } finally {
      // Always cleanup timeout to prevent resource leak
      if (timeoutId) clearTimeout(timeoutId);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      `🎁 [Redeem] ❌ Redemption failed for ${conditionId.slice(0, 16)}...: ${errorMsg}`,
    );
    logger?.error?.(`❌ Redemption failed: ${errorMsg}`);

    return {
      success: false,
      conditionId,
      error: errorMsg,
    };
  }
}

/**
 * Redeem all redeemable positions
 * Returns total value redeemed
 */
export async function redeemAllPositions(
  wallet: Wallet,
  address: string,
  logger?: Logger,
): Promise<{ redeemed: number; failed: number; totalValue: number }> {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎁 AUTO-REDEEM: Checking for resolved positions...`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger?.info?.(`🎁 AUTO-REDEEM: Checking for resolved positions...`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Fetch redeemable positions
  const positions = await fetchRedeemablePositions(address, logger);

  if (positions.length === 0) {
    console.log(`🎁 [Redeem] ✅ No positions need redemption`);
    logger?.info?.(`✅ No positions need redemption`);
    return { redeemed: 0, failed: 0, totalValue: 0 };
  }

  console.log(`🎁 [Redeem] 📦 Found ${positions.length} market(s) to redeem:`);
  logger?.info?.(`📦 Found ${positions.length} market(s) to redeem:`);

  let totalValue = 0;
  for (const pos of positions) {
    const valueStr =
      pos.value > 0 ? `~$${pos.value.toFixed(2)}` : "$0 (losing position)";
    console.log(`🎁 [Redeem]    ${pos.outcome}: ${valueStr}`);
    logger?.info?.(`   ${pos.outcome}: ${valueStr}`);
    if (pos.question) {
      const questionPreview =
        pos.question.length > 60
          ? `${pos.question.slice(0, 60)}...`
          : pos.question;
      console.log(`🎁 [Redeem]    "${questionPreview}"`);
      logger?.info?.(`   "${questionPreview}"`);
    }
    totalValue += pos.value;
  }

  console.log(`🎁 [Redeem]    Total value: ~$${totalValue.toFixed(2)}`);
  logger?.info?.(`   Total value: ~$${totalValue.toFixed(2)}`);
  logger?.info?.(``);

  // Redeem each position
  let redeemed = 0;
  let failed = 0;

  for (const pos of positions) {
    console.log(
      `🎁 [Redeem] Processing ${redeemed + failed + 1}/${positions.length}: ${pos.conditionId.slice(0, 16)}...`,
    );
    const result = await redeemPosition(
      pos.conditionId,
      wallet,
      address,
      logger,
    );

    if (result.success) {
      redeemed++;
      console.log(`🎁 [Redeem] ✅ Success! (${redeemed}/${positions.length})`);
    } else {
      failed++;
      console.log(`🎁 [Redeem] ❌ Failed: ${result.error}`);
    }

    // Small delay between redemptions to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎁 REDEMPTION SUMMARY`);
  console.log(`   Redeemed: ${redeemed}`);
  console.log(`   Failed: ${failed}`);
  console.log(`   Total: ${positions.length}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger?.info?.(`📊 REDEMPTION SUMMARY`);
  logger?.info?.(`   Redeemed: ${redeemed}`);
  logger?.info?.(`   Failed: ${failed}`);
  logger?.info?.(`   Total: ${positions.length}`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  return { redeemed, failed, totalValue };
}

// ============================================
// LEGACY COMPATIBILITY - Keep old functions
// ============================================

/**
 * Legacy API position data
 */
interface LegacyApiPosition {
  conditionId?: string;
  asset?: string;
  size?: number | string;
  curPrice?: number | string;
  redeemable?: boolean;
}

/**
 * Legacy: Fetch redeemable positions (old API)
 * @deprecated Use fetchRedeemablePositions instead
 *
 * Note: This function fetches ALL positions and filters client-side (less efficient).
 * The new fetchRedeemablePositions uses the redeemable=true query parameter
 * for server-side filtering, which is more efficient.
 */
export async function getRedeemablePositions(
  address: string,
): Promise<
  Array<{ conditionId: string; tokenId: string; size: number; value: number }>
> {
  try {
    const url = `${POLYMARKET_API.DATA}/positions?user=${address}&limit=500`;
    const { data } = await axios.get<LegacyApiPosition[]>(url, {
      timeout: 10000,
    });

    if (!Array.isArray(data)) return [];

    return data
      .filter(
        (p) => p.redeemable && Number(p.size) > 0 && p.conditionId && p.asset,
      )
      .map((p) => ({
        conditionId: p.conditionId!,
        tokenId: p.asset!,
        size: Number(p.size),
        value: Number(p.size) * Number(p.curPrice || 1),
      }));
  } catch {
    return [];
  }
}

/**
 * Legacy: Redeem all redeemable positions (old API)
 * @deprecated Use redeemAllPositions instead
 */
export async function redeemAll(
  wallet: Wallet,
  address: string,
  minValueUsd: number,
  logger?: Logger,
): Promise<number> {
  const positions = await getRedeemablePositions(address);
  let count = 0;

  for (const pos of positions) {
    if (pos.value < minValueUsd) continue;

    const result = await redeemPosition(
      pos.conditionId,
      wallet,
      address,
      logger,
    );
    if (result.success) count++;

    // Delay between redemptions
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return count;
}
