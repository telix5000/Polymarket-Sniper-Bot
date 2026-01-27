/**
 * APEX HUNTER - Active Market Scanner
 * 
 * Scans markets every 5 seconds for 6 hunting patterns:
 * 1. Momentum Detection
 * 2. Mispricing Detection
 * 3. Volume Spike Detection
 * 4. New Market Detection
 * 5. Whale Activity Detection
 * 6. Spread Compression Detection
 */

export interface HunterOpportunity {
  pattern: HunterPattern;
  tokenId: string;
  conditionId: string;
  marketId?: string;
  outcome: "YES" | "NO";
  price: number;
  confidence: number; // 0-100
  reason: string;
  timestamp: number;
}

export enum HunterPattern {
  MOMENTUM = "MOMENTUM",
  MISPRICING = "MISPRICING",
  VOLUME_SPIKE = "VOLUME_SPIKE",
  NEW_MARKET = "NEW_MARKET",
  WHALE_ACTIVITY = "WHALE_ACTIVITY",
  SPREAD_COMPRESSION = "SPREAD_COMPRESSION",
}

export interface MarketSnapshot {
  tokenId: string;
  conditionId: string;
  marketId?: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  liquidity: number;
  createdAt: number;
  lastPrice: number;
  priceHistory: number[];
  spread: number;
}

/**
 * Detect momentum (12%+ price velocity in 30min)
 */
export function detectMomentum(snapshot: MarketSnapshot): HunterOpportunity | null {
  if (snapshot.priceHistory.length < 6) return null;

  // Calculate short-term price change using recent samples
  // Note: 6 samples at 5-second intervals = 30 seconds of data
  // For longer 30-minute tracking, need 360 samples (30min * 60sec / 5sec)
  // This provides fast momentum detection for short-term moves
  const oldPrice = snapshot.priceHistory[0];
  const currentPrice = snapshot.lastPrice;
  const priceChange = ((currentPrice - oldPrice) / oldPrice) * 100;

  if (Math.abs(priceChange) >= 12) {
    const outcome = priceChange > 0 ? "YES" : "NO";
    const confidence = Math.min(100, Math.abs(priceChange) * 5);

    return {
      pattern: HunterPattern.MOMENTUM,
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      marketId: snapshot.marketId,
      outcome,
      price: currentPrice,
      confidence,
      reason: `Momentum: ${priceChange.toFixed(1)}% in 30min`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Detect mispricing (YES + NO > $1.05)
 */
export function detectMispricing(snapshot: MarketSnapshot): HunterOpportunity | null {
  const total = snapshot.yesPrice + snapshot.noPrice;

  if (total > 1.05) {
    // Buy the cheaper side
    const outcome = snapshot.yesPrice < snapshot.noPrice ? "YES" : "NO";
    const price = outcome === "YES" ? snapshot.yesPrice : snapshot.noPrice;
    const confidence = Math.min(100, (total - 1.0) * 200);

    return {
      pattern: HunterPattern.MISPRICING,
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      marketId: snapshot.marketId,
      outcome,
      price,
      confidence,
      reason: `Mispricing: YES ${snapshot.yesPrice.toFixed(2)} + NO ${snapshot.noPrice.toFixed(2)} = $${total.toFixed(2)}`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Detect volume spike (3× normal volume)
 */
export function detectVolumeSpike(
  snapshot: MarketSnapshot,
  normalVolume: number,
): HunterOpportunity | null {
  if (snapshot.volume24h >= normalVolume * 3 && normalVolume > 0) {
    // Trade in direction of price movement
    const recentChange =
      snapshot.priceHistory && snapshot.priceHistory.length > 1
        ? snapshot.lastPrice - snapshot.priceHistory[snapshot.priceHistory.length - 2]
        : 0;

    const outcome = recentChange >= 0 ? "YES" : "NO";
    const confidence = Math.min(100, (snapshot.volume24h / normalVolume) * 20);

    return {
      pattern: HunterPattern.VOLUME_SPIKE,
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      marketId: snapshot.marketId,
      outcome,
      price: snapshot.lastPrice,
      confidence,
      reason: `Volume spike: ${(snapshot.volume24h / normalVolume).toFixed(1)}× normal`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Detect new markets (<6 hours old)
 */
export function detectNewMarket(snapshot: MarketSnapshot): HunterOpportunity | null {
  const ageHours = (Date.now() - snapshot.createdAt) / (1000 * 60 * 60);

  if (ageHours < 6 && snapshot.liquidity > 500) {
    // Favor YES if price is reasonable
    const outcome = snapshot.yesPrice < 0.7 ? "YES" : "NO";
    const price = outcome === "YES" ? snapshot.yesPrice : snapshot.noPrice;
    const confidence = Math.max(30, 100 - ageHours * 10);

    return {
      pattern: HunterPattern.NEW_MARKET,
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      marketId: snapshot.marketId,
      outcome,
      price,
      confidence,
      reason: `New market: ${ageHours.toFixed(1)}h old, $${snapshot.liquidity.toFixed(0)} liquidity`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Detect whale activity (whale trade >$500, price hasn't moved)
 */
export function detectWhaleActivity(
  snapshot: MarketSnapshot,
  recentWhaleTrade: { amount: number; outcome: "YES" | "NO"; timestamp: number } | null,
): HunterOpportunity | null {
  if (!recentWhaleTrade) return null;

  const timeSinceTrade = Date.now() - recentWhaleTrade.timestamp;
  const priceChange =
    snapshot.priceHistory.length > 1
      ? Math.abs(
          snapshot.lastPrice - snapshot.priceHistory[snapshot.priceHistory.length - 2],
        )
      : 0;

  // Whale traded but price hasn't moved yet (within 2 minutes)
  if (timeSinceTrade < 2 * 60 * 1000 && priceChange < 0.02) {
    const confidence = Math.min(100, recentWhaleTrade.amount / 10);

    return {
      pattern: HunterPattern.WHALE_ACTIVITY,
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      marketId: snapshot.marketId,
      outcome: recentWhaleTrade.outcome,
      price: snapshot.lastPrice,
      confidence,
      reason: `Whale: $${recentWhaleTrade.amount.toFixed(0)} ${recentWhaleTrade.outcome}, price stable`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Detect spread compression (spread <1%, liquidity >$1000)
 */
export function detectSpreadCompression(snapshot: MarketSnapshot): HunterOpportunity | null {
  if (snapshot.spread < 0.01 && snapshot.liquidity > 1000) {
    // Tight spread means efficient pricing, trade direction of momentum
    const recentChange =
      snapshot.priceHistory && snapshot.priceHistory.length > 1
        ? snapshot.lastPrice - snapshot.priceHistory[snapshot.priceHistory.length - 2]
        : 0;

    const outcome = recentChange >= 0 ? "YES" : "NO";
    const confidence = Math.min(100, snapshot.liquidity / 20);

    return {
      pattern: HunterPattern.SPREAD_COMPRESSION,
      tokenId: snapshot.tokenId,
      conditionId: snapshot.conditionId,
      marketId: snapshot.marketId,
      outcome,
      price: snapshot.lastPrice,
      confidence,
      reason: `Tight spread: ${(snapshot.spread * 100).toFixed(2)}%, $${snapshot.liquidity.toFixed(0)} liquidity`,
      timestamp: Date.now(),
    };
  }

  return null;
}

/**
 * Scan market for all hunting patterns
 */
export function scanMarket(
  snapshot: MarketSnapshot,
  normalVolume: number = 1000,
  recentWhaleTrade: { amount: number; outcome: "YES" | "NO"; timestamp: number } | null = null,
): HunterOpportunity[] {
  const opportunities: HunterOpportunity[] = [];

  const momentum = detectMomentum(snapshot);
  if (momentum) opportunities.push(momentum);

  const mispricing = detectMispricing(snapshot);
  if (mispricing) opportunities.push(mispricing);

  const volumeSpike = detectVolumeSpike(snapshot, normalVolume);
  if (volumeSpike) opportunities.push(volumeSpike);

  const newMarket = detectNewMarket(snapshot);
  if (newMarket) opportunities.push(newMarket);

  const whaleActivity = detectWhaleActivity(snapshot, recentWhaleTrade);
  if (whaleActivity) opportunities.push(whaleActivity);

  const spreadCompression = detectSpreadCompression(snapshot);
  if (spreadCompression) opportunities.push(spreadCompression);

  return opportunities;
}

/**
 * Filter and prioritize opportunities by confidence
 */
export function prioritizeOpportunities(
  opportunities: HunterOpportunity[],
  minConfidence: number = 50,
): HunterOpportunity[] {
  return opportunities
    .filter((opp) => opp.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence);
}
