/**
 * V2 Redeem - Auto-redeem resolved positions
 */

import { Contract, type Wallet, ZeroHash } from "ethers";
import axios from "axios";
import { POLYGON, CTF_ABI, POLYMARKET_API } from "./constants";
import type { Logger } from "./types";

interface RedeemablePosition {
  conditionId: string;
  tokenId: string;
  size: number;
  value: number;
}

/**
 * Fetch redeemable positions
 */
export async function getRedeemablePositions(
  address: string,
): Promise<RedeemablePosition[]> {
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
 * Redeem a position
 */
export async function redeemPosition(
  wallet: Wallet,
  conditionId: string,
  logger?: Logger,
): Promise<boolean> {
  try {
    const ctf = new Contract(POLYGON.CTF_ADDRESS, CTF_ABI, wallet);

    // Check if resolved
    const denom = await ctf.payoutDenominator(conditionId);
    if (denom === 0n) {
      logger?.warn?.(
        `Position ${conditionId.slice(0, 10)}... not resolved yet`,
      );
      return false;
    }

    // Redeem
    const tx = await ctf.redeemPositions(
      POLYGON.USDC_ADDRESS,
      ZeroHash,
      conditionId,
      [1, 2], // Both outcomes
    );

    await tx.wait();
    logger?.info?.(`Redeemed ${conditionId.slice(0, 10)}...`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`Redeem failed: ${msg}`);
    return false;
  }
}

/**
 * Redeem all redeemable positions
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

    const success = await redeemPosition(wallet, pos.conditionId, logger);
    if (success) count++;
  }

  return count;
}
