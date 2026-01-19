/**
 * Simplified CLOB Client Factory
 *
 * Clean, simple client creation following the working reference bot approach:
 * - Uses SimpleAuth for credential management
 * - Clear success/failure logging with ✅/❌
 * - Minimal configuration, sensible defaults
 *
 * @see https://github.com/dappboris-dev/polymarket-trading-bot
 */

import { JsonRpcProvider, Wallet } from "ethers";
import { ClobClient, Chain } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { POLYMARKET_API } from "../constants/polymarket.constants";
import type { Logger } from "../utils/logger.util";
import { SimpleAuth } from "../clob/simple-auth";
import { asClobSigner } from "../utils/clob-signer.util";

const CLOB_HOST = POLYMARKET_API.BASE_URL;
const CHAIN_ID = Chain.POLYGON;

/**
 * Options for creating a Polymarket client
 */
export interface CreateClientOptions {
  /** RPC URL for Polygon */
  rpcUrl: string;
  /** Private key for wallet */
  privateKey: string;
  /** Pre-configured API key (optional - will derive if not provided) */
  apiKey?: string;
  /** Pre-configured API secret (optional - will derive if not provided) */
  apiSecret?: string;
  /** Pre-configured API passphrase (optional - will derive if not provided) */
  apiPassphrase?: string;
  /** Whether to derive credentials if not provided (default: true) */
  deriveApiKey?: boolean;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Extended ClobClient with additional properties
 */
export interface ExtendedClobClient extends ClobClient {
  wallet: Wallet;
  address: string;
  creds?: ApiKeyCreds;
  authOk: boolean;
  executionDisabled: boolean;
}

/**
 * Create a Polymarket CLOB client with authentication
 *
 * @param options - Configuration options
 * @returns Extended ClobClient ready for trading
 */
export async function createClient(
  options: CreateClientOptions,
): Promise<ExtendedClobClient> {
  const logger = options.logger;

  // Create wallet
  const provider = new JsonRpcProvider(options.rpcUrl);
  const pk = options.privateKey.startsWith("0x")
    ? options.privateKey
    : `0x${options.privateKey}`;
  const wallet = new Wallet(pk, provider);

  logger?.info(`[Client] 🔐 Wallet: ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`);

  // Check if credentials were provided
  const hasProvidedCreds =
    options.apiKey && options.apiSecret && options.apiPassphrase;

  let creds: ApiKeyCreds | undefined;
  let authOk = false;

  if (hasProvidedCreds) {
    // Use provided credentials
    logger?.info("[Client] 📋 Using provided API credentials");
    creds = {
      key: options.apiKey!,
      secret: options.apiSecret!,
      passphrase: options.apiPassphrase!,
    };

    // Verify provided credentials
    const valid = await verifyCredentials(wallet, creds, logger);
    if (valid) {
      logger?.info("[Client] ✅ Provided credentials verified");
      authOk = true;
    } else {
      logger?.warn("[Client] ⚠️  Provided credentials failed verification");

      // Try to derive if enabled
      if (options.deriveApiKey !== false) {
        logger?.info("[Client] 🔄 Attempting to derive new credentials...");
        const derived = await deriveCredentials(wallet, logger);
        if (derived) {
          creds = derived;
          authOk = true;
        }
      }
    }
  } else if (options.deriveApiKey !== false) {
    // No credentials provided, derive them
    logger?.info("[Client] 🔄 Deriving API credentials...");
    const derived = await deriveCredentials(wallet, logger);
    if (derived) {
      creds = derived;
      authOk = true;
    }
  } else {
    logger?.warn("[Client] ⚠️  No credentials provided and derivation disabled");
  }

  // Create the client
  const client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    asClobSigner(wallet),
    creds,
  ) as ExtendedClobClient;

  // Attach additional properties
  client.wallet = wallet;
  client.address = wallet.address;
  client.creds = creds;
  client.authOk = authOk;
  client.executionDisabled = !authOk;

  // Log final status
  if (authOk) {
    logger?.info("[Client] ✅ Client ready for trading");
  } else {
    logger?.warn("[Client] ⚠️  Client in read-only mode (auth failed)");
  }

  return client;
}

/**
 * Derive credentials using createOrDeriveApiKey
 */
async function deriveCredentials(
  wallet: Wallet,
  logger?: Logger,
): Promise<ApiKeyCreds | null> {
  try {
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      asClobSigner(wallet),
    );

    const creds = await client.createOrDeriveApiKey();

    if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
      logger?.error("[Client] ❌ Credentials incomplete");
      logger?.info("[Client] 💡 Wallet may need to trade on Polymarket first");
      logger?.info("[Client] 💡 Visit: https://polymarket.com");
      return null;
    }

    // Verify the credentials
    const valid = await verifyCredentials(wallet, creds, logger);
    if (!valid) {
      logger?.error("[Client] ❌ Derived credentials failed verification");
      return null;
    }

    const keySuffix = creds.key.slice(-6);
    logger?.info(`[Client] ✅ Credentials derived (key: ...${keySuffix})`);

    return creds;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = (error as { response?: { status?: number } })?.response?.status;

    if (status === 400 && message.toLowerCase().includes("could not create")) {
      logger?.error("[Client] ❌ Wallet has never traded on Polymarket");
      logger?.info("[Client] 💡 Visit https://polymarket.com and make a trade first");
    } else {
      logger?.error(`[Client] ❌ Failed to derive credentials: ${message}`);
    }

    return null;
  }
}

/**
 * Verify credentials by making a test API call
 */
async function verifyCredentials(
  wallet: Wallet,
  creds: ApiKeyCreds,
  logger?: Logger,
): Promise<boolean> {
  try {
    const client = new ClobClient(
      CLOB_HOST,
      CHAIN_ID,
      asClobSigner(wallet),
      creds,
    );

    const response = await client.getBalanceAllowance({
      asset_type: "COLLATERAL" as never,
    });

    // Check for error response
    const errorResponse = response as { status?: number; error?: string };
    if (errorResponse.status === 401 || errorResponse.status === 403) {
      logger?.debug?.("[Client] Verification failed: 401/403");
      return false;
    }
    if (errorResponse.error) {
      logger?.debug?.(`[Client] Verification failed: ${errorResponse.error}`);
      return false;
    }

    return true;
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      return false;
    }
    // Other errors (network, etc.) - be conservative
    logger?.debug?.(`[Client] Verification error: ${error}`);
    return false;
  }
}

/**
 * Create client from environment variables
 */
export async function createClientFromEnv(
  logger?: Logger,
): Promise<ExtendedClobClient> {
  const rpcUrl = process.env.RPC_URL || process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  const privateKey = process.env.PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  // Check for API credentials in env
  const apiKey =
    process.env.POLYMARKET_API_KEY ||
    process.env.POLY_API_KEY ||
    process.env.CLOB_API_KEY;
  const apiSecret =
    process.env.POLYMARKET_API_SECRET ||
    process.env.POLY_SECRET ||
    process.env.CLOB_API_SECRET;
  const apiPassphrase =
    process.env.POLYMARKET_API_PASSPHRASE ||
    process.env.POLY_PASSPHRASE ||
    process.env.CLOB_API_PASSPHRASE;

  // Check if derivation is enabled
  const deriveEnabled =
    process.env.CLOB_DERIVE_CREDS !== "false" &&
    process.env.CLOB_DERIVE_ENABLED !== "false";

  return createClient({
    rpcUrl,
    privateKey,
    apiKey,
    apiSecret,
    apiPassphrase,
    deriveApiKey: deriveEnabled,
    logger,
  });
}
