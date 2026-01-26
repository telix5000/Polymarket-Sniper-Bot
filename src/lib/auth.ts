/**
 * V2 Auth - CLOB client authentication
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_API, POLYGON } from "./constants";
import type { Logger } from "./types";

export interface AuthResult {
  success: boolean;
  client?: ClobClient;
  wallet?: Wallet;
  address?: string;
  error?: string;
}

/**
 * Create authenticated CLOB client
 */
export async function createClobClient(
  privateKey: string,
  rpcUrl: string,
  logger?: Logger,
): Promise<AuthResult> {
  try {
    if (!privateKey?.startsWith("0x")) {
      return { success: false, error: "PRIVATE_KEY must start with 0x" };
    }
    if (!rpcUrl) {
      return { success: false, error: "RPC_URL is required" };
    }

    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(privateKey, provider);
    const address = wallet.address.toLowerCase();

    logger?.info?.(`Authenticating wallet ${address.slice(0, 10)}...`);

    const client = new ClobClient(
      POLYMARKET_API.CLOB,
      POLYGON.CHAIN_ID,
      wallet as any,
    );

    // Derive API credentials
    await client.createOrDeriveApiKey();

    logger?.info?.("Authentication successful");

    return { success: true, client, wallet, address };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`Auth failed: ${msg}`);
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
