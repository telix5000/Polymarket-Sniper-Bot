/**
 * VolumeScanner - Scan for most active markets by 24h volume
 *
 * This scanner identifies markets with high trading activity,
 * which are good candidates for trading opportunities.
 */

import axios from "axios";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ActiveMarket {
  tokenId: string;
  conditionId: string;
  marketId: string;
  question: string;
  volume24h: number;
  price: number;
  lastTradeTime: number;
}

/** Minimal config interface for VolumeScanner */
export interface VolumeScannerConfig {
  scanIntervalSeconds: number;
  scanTopNMarkets: number;
  scanMinVolumeUsd: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// VOLUME SCANNER
// ═══════════════════════════════════════════════════════════════════════════

export class VolumeScanner {
  private readonly config: VolumeScannerConfig;
  private readonly DATA_API = "https://data-api.polymarket.com";
  private readonly GAMMA_API = "https://gamma-api.polymarket.com";
  private activeMarkets: ActiveMarket[] = [];
  private lastScanTime = 0;

  constructor(config: VolumeScannerConfig) {
    this.config = config;
  }

  /**
   * Scan for the most active markets on Polymarket
   * Returns markets sorted by 24h volume that meet minimum criteria
   */
  async scanActiveMarkets(): Promise<ActiveMarket[]> {
    const now = Date.now();

    // Only scan at configured interval
    if (now - this.lastScanTime < this.config.scanIntervalSeconds * 1000) {
      return this.activeMarkets;
    }

    try {
      // Fetch active markets from Gamma API sorted by volume
      const url = `${this.GAMMA_API}/markets?closed=false&active=true&limit=${this.config.scanTopNMarkets * 2}&order=volume24hr&ascending=false`;
      const { data } = await axios.get(url, { timeout: 10000 });

      if (!Array.isArray(data)) {
        console.warn("[Scanner] Invalid response from markets API");
        return this.activeMarkets;
      }

      const markets: ActiveMarket[] = [];

      for (const market of data) {
        try {
          // Parse token IDs from clobTokenIds JSON string
          const tokenIds = JSON.parse(market.clobTokenIds || "[]");
          if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;

          const volume24h = parseFloat(market.volume24hr || "0");

          // Skip markets below minimum volume
          if (volume24h < this.config.scanMinVolumeUsd) continue;

          // Parse prices
          const prices = JSON.parse(market.outcomePrices || "[]");
          const yesPrice = parseFloat(prices[0] || "0.5");

          // Only consider markets in tradeable price range (20-80¢)
          if (yesPrice < 0.2 || yesPrice > 0.8) continue;

          markets.push({
            tokenId: tokenIds[0], // YES token
            conditionId: market.conditionId,
            marketId: market.id,
            question: market.question || "Unknown",
            volume24h,
            price: yesPrice,
            lastTradeTime: new Date(market.updatedAt || Date.now()).getTime(),
          });
        } catch {
          // Skip malformed market entries
          continue;
        }
      }

      // Sort by volume and take top N
      this.activeMarkets = markets
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, this.config.scanTopNMarkets);

      this.lastScanTime = now;

      if (this.activeMarkets.length > 0) {
        console.log(
          `📊 Scanned ${this.activeMarkets.length} active markets (top by 24h volume)`,
        );
      }

      return this.activeMarkets;
    } catch (err) {
      console.warn(
        `[Scanner] Failed to scan markets: ${err instanceof Error ? err.message : err}`,
      );
      return this.activeMarkets;
    }
  }

  /**
   * Get token IDs from scanned active markets
   * These can be used as additional trading opportunities
   */
  getActiveTokenIds(): string[] {
    return this.activeMarkets.map((m) => m.tokenId);
  }

  /**
   * Get count of active markets being tracked
   */
  getActiveMarketCount(): number {
    return this.activeMarkets.length;
  }

  /**
   * Clear scanner cache (for testing)
   */
  clear(): void {
    this.activeMarkets = [];
    this.lastScanTime = 0;
  }
}
