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
 * Clean and validate Ethereum address
 */
function cleanAddress(addr: string | undefined): string | null {
  if (!addr || addr.length < 40) return null;
  try {
    return ethers.getAddress(addr.toLowerCase());
  } catch {
    return null;
  }
}

/**
 * Fetch redeemable positions from Polymarket API
 * These are positions in resolved markets that can be claimed
 */
export async function fetchRedeemablePositions(
  address: string,
  logger?: Logger,
): Promise<RedeemablePosition[]> {
  try {
    logger?.debug?.(`Fetching redeemable positions for ${address.slice(0, 8)}...`);

    // Check if user has proxy wallet
    let proxyAddress: string | null = null;
    try {
      const profileRes = await axios.get(
        `${POLYMARKET_API.DATA}/profile?address=${address}`,
        { timeout: 10000 },
      );

      if (profileRes.data?.proxyAddress) {
        proxyAddress = cleanAddress(profileRes.data.proxyAddress);
        if (proxyAddress) {
          logger?.debug?.(`Found proxy wallet: ${proxyAddress.slice(0, 8)}...`);
        }
      }
    } catch (err) {
      logger?.debug?.(`No proxy wallet found (using main wallet)`);
    }

    // Check target address (proxy if available, otherwise main wallet)
    const targetAddress = proxyAddress || address;

    // Fetch redeemable positions
    const posRes = await axios.get(
      `${POLYMARKET_API.DATA}/positions?user=${targetAddress}&redeemable=true`,
      { timeout: 15000 },
    );

    if (!posRes.data || posRes.data.length === 0) {
      logger?.debug?.(`No redeemable positions found`);
      return [];
    }

    // Group by conditionId (each market has one conditionId)
    const conditionMap = new Map<string, RedeemablePosition>();

    for (const pos of posRes.data) {
      if (!pos.conditionId) continue;

      const existing = conditionMap.get(pos.conditionId);
      if (existing) {
        // Aggregate positions in same market
        existing.size += pos.size || 0;
        existing.value += pos.value || 0;
      } else {
        conditionMap.set(pos.conditionId, {
          conditionId: pos.conditionId,
          marketId: pos.marketId || pos.market || "unknown",
          question: pos.question || pos.marketQuestion,
          outcome: pos.outcome || "Unknown",
          size: pos.size || 0,
          value: pos.value || 0,
        });
      }
    }

    const redeemable = Array.from(conditionMap.values());

    logger?.info?.(`📦 Found ${redeemable.length} redeemable market(s)`);

    return redeemable;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
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
    logger?.info?.(`🔄 Redeeming: ${conditionId.slice(0, 16)}...`);

    const provider = wallet.provider;
    if (!provider) {
      throw new Error("Wallet has no provider");
    }

    // Check for proxy wallet
    let proxyAddress: string | null = null;
    try {
      const profileRes = await axios.get(
        `${POLYMARKET_API.DATA}/profile?address=${address}`,
        { timeout: 10000 },
      );
      if (profileRes.data?.proxyAddress) {
        proxyAddress = cleanAddress(profileRes.data.proxyAddress);
      }
    } catch {
      // No proxy - use main wallet
    }

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
    if (proxyAddress && proxyAddress !== address) {
      logger?.debug?.(`Using proxy wallet: ${proxyAddress.slice(0, 8)}...`);
      const proxyContract = new ethers.Contract(proxyAddress, PROXY_ABI, wallet);
      tx = await proxyContract.proxy(POLYGON.CTF_ADDRESS, redeemData, txDetails);
    } else {
      // Direct redemption (no proxy)
      logger?.debug?.(`Direct redemption (no proxy)`);
      const ctfContract = new ethers.Contract(POLYGON.CTF_ADDRESS, CTF_ABI, wallet);
      tx = await ctfContract.redeemPositions(
        POLYGON.USDC_ADDRESS,
        ethers.ZeroHash,
        conditionId,
        [1, 2],
        txDetails,
      );
    }

    logger?.info?.(`⏳ Transaction sent: ${tx.hash.slice(0, 16)}...`);

    // Wait for confirmation with 45 second timeout
    const receipt = await Promise.race([
      tx.wait(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transaction timeout after 45s")), 45000),
      ),
    ]);

    logger?.info?.(`✅ Confirmed in block ${receipt.blockNumber}`);

    return {
      success: true,
      conditionId,
      txHash: tx.hash,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
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
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  logger?.info?.(`🎁 AUTO-REDEEM: Checking for resolved positions...`);
  logger?.info?.(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Fetch redeemable positions
  const positions = await fetchRedeemablePositions(address, logger);

  if (positions.length === 0) {
    logger?.info?.(`✅ No positions need redemption`);
    return { redeemed: 0, failed: 0, totalValue: 0 };
  }

  logger?.info?.(`📦 Found ${positions.length} market(s) to redeem:`);

  let totalValue = 0;
  for (const pos of positions) {
    logger?.info?.(`   ${pos.outcome}: ~$${pos.value.toFixed(2)}`);
    if (pos.question) {
      logger?.info?.(`   "${pos.question.slice(0, 60)}..."`);
    }
    totalValue += pos.value;
  }

  logger?.info?.(`   Total value: ~$${totalValue.toFixed(2)}`);
  logger?.info?.(``);

  // Redeem each position
  let redeemed = 0;
  let failed = 0;

  for (const pos of positions) {
    const result = await redeemPosition(pos.conditionId, wallet, address, logger);

    if (result.success) {
      redeemed++;
    } else {
      failed++;
    }

    // Small delay between redemptions to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

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
 * Legacy: Fetch redeemable positions (old API)
 * @deprecated Use fetchRedeemablePositions instead
 */
export async function getRedeemablePositions(
  address: string,
): Promise<Array<{ conditionId: string; tokenId: string; size: number; value: number }>> {
  try {
    const url = `${POLYMARKET_API.DATA}/positions?user=${address}&limit=500`;
    const { data } = await axios.get(url, { timeout: 10000 });

    if (!Array.isArray(data)) return [];

    return data
      .filter((p: any) => p.redeemable && Number(p.size) > 0)
      .map((p: any) => ({
        conditionId: p.conditionId,
        tokenId: p.asset,
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

    const result = await redeemPosition(pos.conditionId, wallet, address, logger);
    if (result.success) count++;

    // Delay between redemptions
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return count;
}
