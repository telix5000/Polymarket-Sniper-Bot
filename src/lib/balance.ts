/**
 * V2 Balance - Wallet balance utilities
 */

import { Contract, type Wallet } from "ethers";
import { POLYGON, ERC20_ABI } from "./constants";

/**
 * Get USDC balance
 */
export async function getUsdcBalance(wallet: Wallet): Promise<number> {
  try {
    const contract = new Contract(POLYGON.USDC_ADDRESS, ERC20_ABI, wallet.provider);
    const balance = await contract.balanceOf(wallet.address);
    return Number(balance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}

/**
 * Get POL (native token) balance
 */
export async function getPolBalance(wallet: Wallet): Promise<number> {
  try {
    const balance = await wallet.provider?.getBalance(wallet.address);
    return balance ? Number(balance) / 1e18 : 0;
  } catch {
    return 0;
  }
}
