import { POLYMARKET_API } from "../constants/polymarket.constants";
import { httpGet } from "./fetch-data.util";
import type { Logger } from "./logger.util";

/**
 * Response from the Polymarket geoblock API
 * @see https://docs.polymarket.com/developers/CLOB/geoblock
 */
export interface GeoblockResponse {
  blocked: boolean;
  ip: string;
  country: string;
  region: string;
}

/**
 * Check if the current IP is geographically blocked from trading on Polymarket.
 * Trading is restricted in certain countries and regions per Polymarket's compliance requirements.
 *
 * @see https://docs.polymarket.com/developers/CLOB/geoblock
 * @returns GeoblockResponse containing blocked status and location info
 */
export async function checkGeoblock(): Promise<GeoblockResponse> {
  return httpGet<GeoblockResponse>(POLYMARKET_API.GEOBLOCK_ENDPOINT);
}

/**
 * Check if the current IP is geographically blocked and log the result.
 * Returns true if blocked (trading not allowed), false if allowed.
 *
 * @param logger - Logger instance for output
 * @returns true if blocked, false if allowed
 */
export async function isGeoblocked(logger?: Logger): Promise<boolean> {
  try {
    const response = await checkGeoblock();

    if (response.blocked) {
      logger?.warn(
        `[Geoblock] Trading restricted: country=${response.country} region=${response.region} ip=${response.ip}`,
      );
      return true;
    }

    logger?.info(
      `[Geoblock] Trading allowed: country=${response.country} region=${response.region}`,
    );
    return false;
  } catch (error) {
    // If we can't reach the geoblock API, log warning but don't block
    // This allows operation to continue if the API is temporarily unavailable
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn(
      `[Geoblock] Unable to verify geographic eligibility: ${message}`,
    );
    return false;
  }
}

/**
 * Verify geographic eligibility and throw if blocked.
 * Use this for strict enforcement before trading operations.
 *
 * @param logger - Logger instance for output
 * @throws Error if user is geographically blocked
 */
export async function verifyGeographicEligibility(
  logger?: Logger,
): Promise<void> {
  const response = await checkGeoblock();

  if (response.blocked) {
    const message = `Trading not available in ${response.country}${response.region ? ` (${response.region})` : ""}`;
    logger?.error(`[Geoblock] ${message}`);
    throw new Error(message);
  }

  logger?.info(
    `[Geoblock] Geographic eligibility verified: country=${response.country}`,
  );
}
