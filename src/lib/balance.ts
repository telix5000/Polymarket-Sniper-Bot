/**
 * V2 Balance - Wallet balance utilities
 */

import { Contract, type Wallet } from "ethers";
import { POLYGON, ERC20_ABI } from "./constants";

/**
 * Get USDC balance for a specific address
 */
export async function getUsdcBalance(
  wallet: Wallet,
  address: string,
): Promise<number> {
  try {
    const contract = new Contract(
      POLYGON.USDC_ADDRESS,
      ERC20_ABI,
      wallet.provider,
    );
    const balance = await contract.balanceOf(address);
    return Number(balance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}

/**
 * Get POL (native token) balance for a specific address
 */
export async function getPolBalance(
  wallet: Wallet,
  address: string,
): Promise<number> {
  try {
    const balance = await wallet.provider?.getBalance(address);
    return balance ? Number(balance) / 1e18 : 0;
  } catch {
    return 0;
  }
}

/**
 * Get USDC allowance for CTF Exchange
 * This checks if the address has approved USDC spending for trading
 */
export async function getUsdcAllowance(
  wallet: Wallet,
  ownerAddress: string,
): Promise<number> {
  try {
    const contract = new Contract(
      POLYGON.USDC_ADDRESS,
      ERC20_ABI,
      wallet.provider,
    );
    const allowance = await contract.allowance(
      ownerAddress,
      POLYGON.CTF_EXCHANGE,
    );
    return Number(allowance) / 10 ** POLYGON.USDC_DECIMALS;
  } catch {
    return 0;
  }
}
