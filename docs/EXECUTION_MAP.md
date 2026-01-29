# Execution Map: Order Pricing & Placement

This document maps the complete execution flow for order placement, including
all price variables, their units, and where bestBid/bestAsk originate.

## Price Units Reference

| Unit Type | Format | Example | Where Used |
|-----------|--------|---------|------------|
| **DECIMAL** | 0.xx | 0.59 | Internal computation, API payload |
| **CENTS** | xx | 59 | Logging/display only |
| **API_UNITS** | 0.xx | 0.59 | Same as DECIMAL for Polymarket |

**CRITICAL**: Polymarket CLOB API expects prices in DECIMAL format (0.01-0.99).
There is NO conversion needed - internal decimal = API units.

---

## Execution Flow: WHALE Entry

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FILE: src/core/churn-engine.ts                                          │
│ FUNCTION: runCycle() → processBiasTokens()                              │
│                                                                         │
│ 1. Detect whale trades via BiasAccumulator                              │
│ 2. Filter by bias criteria (staleness, min trades, min flow)            │
│ 3. Call: fetchTokenMarketDataWithReason(tokenId)                        │
│    └─ Returns: TokenMarketData { orderbook, activity, ... }             │
│    └─ orderbook.bestBidCents, bestAskCents: CENTS (for display)         │
│                                                                         │
│ 4. Call: executionEngine.processEntry(tokenId, marketData, balance)     │
│    └─ bypassBias = false (4th param omitted)                            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ FILE: src/core/execution-engine.ts                                      │
│ FUNCTION: processEntry(tokenId, marketData, balance, skipBiasCheck?)    │
│                                                                         │
│ 1. Check cooldowns, EV allowed, bankroll                                │
│ 2. Evaluate entry via DecisionEngine                                    │
│ 3. Call: executeEntry(tokenId, marketId, side, priceCents, sizeUsd...)  │
│    └─ priceCents: CENTS (from DecisionEngine)                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ FILE: src/core/execution-engine.ts                                      │
│ FUNCTION: executeEntry(...)                                             │
│                                                                         │
│ 1. Fetch fresh orderbook: client.getOrderBook(tokenId)                  │
│    └─ Returns raw API response with bids/asks as string arrays          │
│                                                                         │
│ 2. Parse prices:                                                        │
│    └─ bestAsk = parseFloat(asks[0].price)  → DECIMAL (e.g., 0.60)       │
│    └─ bestBid = parseFloat(bids[0].price)  → DECIMAL (e.g., 0.59)       │
│                                                                         │
│ 3. Validate book health: isBookHealthyForExecution(bestBid, bestAsk)    │
│    └─ DUST_BOOK: bid ≤ 0.02 AND ask ≥ 0.98                              │
│    └─ EMPTY_BOOK: bid ≤ 0.01 AND ask ≥ 0.99                             │
│                                                                         │
│ 4. Compute FOK limit price:                                             │
│    └─ computeExecutionLimitPrice({ bestBid, bestAsk, side, slippageFrac })
│    └─ All inputs/outputs: DECIMAL                                       │
│    └─ Returns: { limitPrice: DECIMAL, basePrice: DECIMAL, ... }         │
│                                                                         │
│ 5. Calculate shares: shares = sizeUsd / fokPrice                        │
│    └─ fokPrice: DECIMAL                                                 │
│                                                                         │
│ 6. Create and post order:                                               │
│    └─ client.createMarketOrder({ price: fokPrice })                     │
│    └─ price param: DECIMAL (API expects 0.01-0.99)                      │
└─────────────────────────────────────────────────────────────────────────┘

---

## Execution Flow: SCAN Entry

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FILE: src/core/churn-engine.ts                                          │
│ FUNCTION: runCycle() → processScannedMarkets()                          │
│                                                                         │
│ 1. Get active tokens from VolumeScanner                                 │
│ 2. Filter by cooldowns and existing positions                           │
│ 3. Call: fetchTokenMarketDataWithReason(tokenId)                        │
│    └─ Same as whale path                                                │
│                                                                         │
│ 4. Call: executionEngine.processEntry(tokenId, marketData, balance, true)
│    └─ bypassBias = true (4th param = true)                              │
│    └─ SAME FUNCTION AS WHALE PATH                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    (Same flow as Whale Entry from here)

---

## bestBid/bestAsk Sources

### Primary Source: WebSocket Cache (fastest)
```
FILE: src/lib/market-data-store.ts
FUNCTION: getOrderbook(tokenId)
RETURNS: { bids: OrderbookLevel[], asks: OrderbookLevel[] }
         where OrderbookLevel = { price: DECIMAL, size: number }
```

### Fallback Source: REST API
```
FILE: @polymarket/clob-client
FUNCTION: client.getOrderBook(tokenId)
RETURNS: { bids: [{price: "0.59", size: "100"}], asks: [...] }
         price is STRING, must parseFloat() to get DECIMAL
```

### BookResolver (unified)
```
FILE: src/book/BookResolver.ts
FUNCTION: fetchBook(tokenId)
LOGIC: Try WS cache first, fall back to REST if stale
RETURNS: BookResult with prices in DECIMAL
```

---

## Price Computation Chain (computeExecutionLimitPrice)

```
FILE: src/lib/price-safety.ts
FUNCTION: computeExecutionLimitPrice(input)

INPUT:
  bestBid: DECIMAL (0.59)
  bestAsk: DECIMAL (0.60)
  side: "BUY" | "SELL"
  slippageFrac: fraction (0.06 = 6%)
  tickSize: DECIMAL (0.01)

COMPUTATION (BUY example with bestAsk=0.60, slippage=6%):
  1. basePrice = bestAsk = 0.60 (DECIMAL)
  2. rawPrice = basePrice * (1 + slippageFrac) = 0.60 * 1.06 = 0.636 (DECIMAL)
  3. clampedToStrategy = clamp(rawPrice, basePrice, STRATEGY_MAX)
     = clamp(0.636, 0.60, 0.65) = 0.636 (DECIMAL)
  4. clampedToHard = clamp(clampedToStrategy, HARD_MIN, HARD_MAX)
     = clamp(0.636, 0.01, 0.99) = 0.636 (DECIMAL)
  5. roundedFinal = roundToTick(clampedToHard, tickSize, side)
     BUY: ceiling → 0.64 (DECIMAL)
     SELL: floor
  6. Must-not-cross check:
     BUY: if roundedFinal < basePrice → bump up to ceiling(basePrice/tick)*tick
     SELL: if roundedFinal > basePrice → bump down to floor(basePrice/tick)*tick

OUTPUT:
  limitPrice: DECIMAL (0.64)
  basePrice: DECIMAL (0.60) - the actual bestAsk or bestBid used
  rawPrice: DECIMAL (0.636)
  wasClamped: boolean
```

---

## Order Payload (API Boundary)

```
FILE: src/lib/order.ts (postOrder) and src/core/execution-engine.ts (executeEntry)
FUNCTION: client.createMarketOrder()

PAYLOAD:
  {
    side: Side.BUY | Side.SELL,
    tokenID: string,
    amount: number (shares, NOT USD),
    price: DECIMAL (0.01-0.99)  ← MUST BE DECIMAL, NOT CENTS
  }

VALIDATION:
  - price MUST be in [0.01, 0.99] range (HARD bounds)
  - price SHOULD be in [0.35, 0.65] range (STRATEGY bounds, configurable)
```

---

## Constants & Bounds

```
FILE: src/lib/price-safety.ts

HARD_MIN_PRICE = 0.01  (DECIMAL) - API minimum
HARD_MAX_PRICE = 0.99  (DECIMAL) - API maximum

STRATEGY_MIN_PRICE = 0.35 (DECIMAL) - "Profit Law" lower bound
STRATEGY_MAX_PRICE = 0.65 (DECIMAL) - "Profit Law" upper bound

DEFAULT_TICK_SIZE = 0.01 (DECIMAL) - 1 cent tick

DUST/EMPTY Thresholds (in CENTS for comparison):
  DEAD_BID_CENTS = 2   → 0.02 DECIMAL
  DEAD_ASK_CENTS = 98  → 0.98 DECIMAL
  EMPTY_BID_CENTS = 1  → 0.01 DECIMAL
  EMPTY_ASK_CENTS = 99 → 0.99 DECIMAL
```

---

## Shared Functions (Used by BOTH Whale & Scan)

| Function | File | Purpose |
|----------|------|---------|
| `processEntry()` | execution-engine.ts | Entry point for all entries |
| `executeEntry()` | execution-engine.ts | Actual order execution |
| `computeExecutionLimitPrice()` | price-safety.ts | Compute safe limit price |
| `isBookHealthyForExecution()` | price-safety.ts | Validate book health |
| `roundToTick()` | price-safety.ts | Round price to tick (directional) |
| `getTickSizeForToken()` | price-safety.ts | Get tick size for market |
| `placeOrderWithFallback()` | order-execution.ts | FOK→GTC fallback logic |

---

## Debugging: ORDER_PRICE_DEBUG Log

When order pricing occurs, a JSON log is emitted:

```json
{
  "event": "ORDER_PRICE_DEBUG",
  "tokenIdPrefix": "abc123...",
  "side": "BUY",
  "bestBid": "0.5900",      // DECIMAL - actual bid from orderbook
  "bestAsk": "0.6000",      // DECIMAL - actual ask from orderbook
  "basePriceUsed": "0.6000", // DECIMAL - bestAsk for BUY, bestBid for SELL
  "strategyMin": 0.35,
  "strategyMax": 0.65,
  "hardMin": 0.01,
  "hardMax": 0.99,
  "slippageFrac": "0.0600",
  "raw": "0.636000",        // DECIMAL - before any clamping
  "clampedToStrategy": "0.636000",
  "clampedToHard": "0.636000",
  "roundedFinal": "0.640000", // DECIMAL - final limit price
  "tickSize": 0.01,
  "wouldCrossBookAfterRounding": false,
  "units": "DECIMAL"        // Explicit unit marker
}
```

---

## Common Bugs to Avoid

1. **Using 0.99 as default bestPrice**: Never default to 0.99 for bestAsk or 0.01 for bestBid.
   Instead, REJECT the order if book is unhealthy.

2. **Mixing cents and decimal**: All internal computation uses DECIMAL (0.xx).
   Convert to cents ONLY for display/logging.

3. **Rounding direction**: BUY must round UP (ceiling), SELL must round DOWN (floor).
   "Round to nearest" causes crossing bugs.

4. **Missing must-not-cross check**: After rounding, BUY limit must be >= bestAsk,
   SELL limit must be <= bestBid.

---

*Last updated: 2026-01-29*
*Maintainer: Copilot Agent*
