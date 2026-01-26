/**
 * V2 Balance Utilities
 * Fetch wallet balances
 */

import { Contract, type Wallet } from "ethers";
import { POLYGON } from "./constants";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/**
 * Get USDC balance for a wallet
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
 * Get POL (native token) balance for a wallet
 */
export async function getPolBalance(wallet: Wallet): Promise<number> {
  try {
    const balance = await wallet.provider?.getBalance(wallet.address);
    return balance ? Number(balance) / 10 ** 18 : 0;
  } catch {
    return 0;
  }
}
