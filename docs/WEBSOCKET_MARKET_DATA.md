# WebSocket Market Data Architecture

## Overview

This document describes the new WebSocket-based market data layer that provides real-time orderbook streaming instead of constant REST API polling.

## Problem

The original architecture called REST `/book` endpoints for every trading decision:
- Entry checks needed fresh bid/ask
- Exit checks polled orderbook
- Hedge decisions required multiple orderbook fetches
- This caused high API load and latency

## Solution

A new streaming architecture with three layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Trading Logic                                │
│            (DecisionEngine, PositionManager, etc.)                  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      MarketDataFacade                                │
│   Single entry point for all market data requests                    │
│   - Reads from store first (instant)                                 │
│   - Falls back to REST if stale (rate-limited)                       │
│   - Tracks WS hit rate, latency, mode                                │
└─────────────────────────────────────────────────────────────────────┘
         │                                           │
         ▼                                           ▼
┌─────────────────────────────┐      ┌──────────────────────────────┐
│     MarketDataStore          │      │     REST Fallback (CLOB)     │
│   In-memory cache per token  │      │   Rate-limited getOrderBook  │
│   - bestBid, bestAsk, mid    │      │   - Min 500ms between calls  │
│   - spreadCents, depth       │      │   - Updates store on fetch   │
│   - updatedAt, source        │      └──────────────────────────────┘
│   - LRU eviction (max 500)   │
└─────────────────────────────┘
                ▲
                │ Updates in real-time
┌─────────────────────────────────────────────────────────────────────┐
│                    WebSocketMarketClient                             │
│   Connects to wss://ws-subscriptions-clob.polymarket.com/ws/         │
│   - Subscribes to "market" channel for tokenIds                      │
│   - Handles L2 snapshots and deltas                                  │
│   - Exponential backoff reconnection with jitter                     │
│   - Heartbeat keep-alive                                             │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. MarketDataStore (`src/lib/market-data-store.ts`)

Single source of truth for live market data. Thread-safe, non-blocking.

**Stored per tokenId:**
- `bestBid`, `bestAsk`, `mid` - Core prices (0-1 decimal)
- `spreadCents` - Spread in cents
- `bidDepthUsd`, `askDepthUsd` - Depth within configurable window
- `updatedAt` - Unix timestamp of last update
- `source` - "WS" or "REST"

**Features:**
- Staleness detection (configurable `WS_STALE_MS`, default 2s)
- Deduplication (doesn't report unchanged data as update)
- LRU eviction (caps at `MARKETDATA_MAX_TOKENS`, default 500)
- Metrics: WS updates, REST fallbacks, stale count, mode

### 2. WebSocketMarketClient (`src/lib/ws-market-client.ts`)

Manages WebSocket connection to CLOB Market channel.

**Features:**
- Subscribe/unsubscribe to multiple tokenIds
- L2 orderbook reconstruction (snapshots + deltas)
- Exponential backoff reconnection (500ms base, 30s max, 30% jitter)
- Heartbeat ping/pong (30s interval)
- Connection timeout handling (10s)

**Message Types Handled:**
- `book` - Full L2 snapshot, rebuilds orderbook
- `price_change` - Incremental delta, applies changes
- `subscribed`/`unsubscribed` - Subscription confirmations

### 3. WebSocketUserClient (`src/lib/ws-user-client.ts`)

Authenticated WebSocket for user's order/trade events.

**Eliminates polling for:**
- Order status changes (LIVE → MATCHED → etc.)
- Trade/fill events
- Balance updates

**Stores state in OrderStateStore:**
- Tracked orders with status, fill amounts
- Recent trades/fills
- Metrics for monitoring

### 4. MarketDataFacade (`src/lib/market-data-facade.ts`)

Unified interface that all trading code should use.

**API:**
```typescript
// Primary method - replaces all getOrderBook calls
const state = await facade.getOrderbookState(tokenId);
// Returns: { bestBidCents, bestAskCents, spreadCents, midPriceCents, bidDepthUsd, askDepthUsd }

// Convenience methods
const bid = await facade.getBestBid(tokenId);   // decimal
const ask = await facade.getBestAsk(tokenId);   // decimal
const mid = await facade.getMidPrice(tokenId);  // decimal

// Bulk operation
const states = await facade.getOrderbookStates(tokenIds);

// Check freshness
const isFresh = facade.isFresh(tokenId);
const mode = facade.getMode(); // "WS_OK" | "WS_STALE_FALLBACK" | "REST_ONLY"
```

**Behavior:**
1. Read from store (instant if fresh)
2. If stale/missing, check rate limiter
3. If allowed, fetch REST and update store
4. If rate-limited, return stale data (better than nothing)

## VPN Bypass

WebSocket traffic to `ws-subscriptions-clob.polymarket.com` bypasses VPN:

- Market channel is public, read-only data
- User channel uses application-layer auth (not IP-based)
- Bypass reduces latency for real-time streaming

Configured via `setupWebSocketBypass()` in `src/lib/vpn.ts`.

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `POLY_WS_BASE_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/` | Market WS endpoint |
| `POLY_WS_USER_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/user` | User WS endpoint |
| `WS_RECONNECT_BASE_MS` | `500` | Initial reconnect delay |
| `WS_RECONNECT_MAX_MS` | `30000` | Max reconnect delay |
| `WS_STALE_MS` | `2000` | Data staleness threshold |
| `REST_FALLBACK_MIN_INTERVAL_MS` | `500` | Min interval between REST calls |
| `MARKETDATA_MAX_TOKENS` | `500` | Max tracked tokens (LRU eviction) |
| `MARKETDATA_DEPTH_WINDOW_CENTS` | `5` | Depth calculation window |

## Observability

### Metrics Available

**MarketDataStore:**
```typescript
const metrics = store.getMetrics();
// { totalTokens, wsUpdates, restFallbacks, staleTokens, mode, oldestUpdateMs, newestUpdateMs }
```

**MarketDataFacade:**
```typescript
const metrics = facade.getMetrics();
// { wsHits, restFallbacks, rateLimitHits, mode, avgResponseTimeMs }
```

**WebSocketMarketClient:**
```typescript
const metrics = client.getMetrics();
// { state, subscriptions, messagesReceived, lastMessageAgeMs, reconnectAttempts, uptimeMs }
```

### Mode Indicator

The system reports its current mode:
- `WS_OK` - WebSocket connected, data fresh
- `WS_STALE_FALLBACK` - WS connected but some tokens have stale data
- `REST_ONLY` - WebSocket disconnected, using REST only

### Logging

Key events are logged:
- WebSocket connection/disconnection
- Reconnection attempts with backoff time
- Subscription confirmations
- Order state transitions (from User channel)
- Trade/fill events

## Migration Guide

### Before (Direct REST calls)
```typescript
const orderbook = await client.getOrderBook(tokenId);
const bestBid = parseFloat(orderbook.bids[0].price);
```

### After (Via Facade)
```typescript
import { getMarketDataFacade } from "./lib";

const facade = getMarketDataFacade(client);
const state = await facade.getOrderbookState(tokenId);
const bestBid = state.bestBidCents / 100;
```

## Safety Features

1. **Rate Limiting**: REST fallback is rate-limited per-token and globally to prevent thundering herd
2. **Graceful Degradation**: If WS fails, system continues with REST fallback
3. **Memory Protection**: LRU eviction caps tracked tokens
4. **Idempotency**: Duplicate WS messages don't cause duplicate state changes
5. **Staleness Detection**: Per-token freshness tracking triggers fallback when needed

## Testing

Tests in `tests/lib/market-data-store.test.ts` cover:
- Basic store operations
- Staleness detection and timing
- Deduplication of updates
- REST fallback behavior
- LRU eviction
- Metrics accuracy
- Singleton management
