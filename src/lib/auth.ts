/**
 * V2 Authentication Utility
 * Clean CLOB client creation for Polymarket
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { POLYGON, POLYMARKET_API } from "./constants";

export interface AuthConfig {
  privateKey: string;
  rpcUrl: string;
}

export interface AuthResult {
  success: boolean;
  client?: ClobClient;
  wallet?: Wallet;
  address?: string;
  error?: string;
}

/**
 * Create an authenticated CLOB client
 * Derives API credentials from wallet signature
 */
export async function createClobClient(config: AuthConfig): Promise<AuthResult> {
  try {
    const { privateKey, rpcUrl } = config;

    if (!privateKey || !privateKey.startsWith("0x")) {
      return { success: false, error: "Invalid PRIVATE_KEY format (must start with 0x)" };
    }

    if (!rpcUrl) {
      return { success: false, error: "Missing RPC_URL" };
    }

    // Create provider and wallet
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const address = wallet.address.toLowerCase();

    // Create CLOB client with credential derivation
    const client = new ClobClient(
      POLYMARKET_API.CLOB_API,
      POLYGON.CHAIN_ID,
      wallet as any, // Type cast needed due to ethers version differences
    );

    // Derive API credentials (this signs a message with the wallet)
    await client.createOrDeriveApiKey();

    return {
      success: true,
      client,
      wallet,
      address,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}

/**
 * Check if live trading is enabled
 */
export function isLiveTradingEnabled(): boolean {
  const flag = process.env.LIVE_TRADING ?? process.env.ARB_LIVE_TRADING ?? "";
  return flag === "I_UNDERSTAND_THE_RISKS";
}
