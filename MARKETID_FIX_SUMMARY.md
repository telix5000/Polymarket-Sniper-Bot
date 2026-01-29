# Fix: Populate marketId in TokenMarketData to prevent order rejection

## Problem
FOK and GTC orders were being rejected with `marketId: undefined` error, causing all order execution to fail.

## Root Cause
The `TokenMarketData` interface includes an optional `marketId` field, but when creating `TokenMarketData` objects in `fetchTokenMarketDataWithReason()`, the `marketId` was never populated.

## Solution
1. **Added marketId cache** (lines 295-298 in churn-engine.ts)
   - Cache tokenId → marketId mappings with 1-hour TTL
   - Avoids repeated API calls to Gamma API
   - Handles API failures gracefully

2. **Created `fetchMarketId()` helper** (lines ~2444-2481 in churn-engine.ts)
   - Checks cache first (fast path)
   - Falls back to Gamma API via `fetchMarketByTokenId()`
   - Caches results (even null to avoid repeated failed lookups)
   - Returns null on error (graceful degradation)

3. **Updated 3 locations where TokenMarketData is created**
   - `processValidOrderbook()` - line ~2532
   - `fetchTokenMarketDataWithReason()` with facade - line ~2888
   - `fetchTokenMarketDataWithReason()` with REST - line ~3016
   
   Each now fetches and populates `marketId`:
   ```typescript
   const marketId = await this.fetchMarketId(tokenId);
   // ...
   data: {
     tokenId,
     marketId: marketId ?? undefined,
     // ...
   }
   ```

4. **Added validation logging** (execution-engine.ts)
   - Warns when marketId is still undefined at order execution
   - Helps diagnose cases where Gamma API fails

## Testing
- ✅ Build succeeds (`npm run build`)
- ✅ All 472 tests pass (`npm test`)
- ✅ TypeScript compilation clean

## Impact
- **Before**: All orders rejected with `marketId: undefined`
- **After**: marketId properly populated from Gamma API with caching
- **Performance**: First call ~100-500ms, cached calls <1ms

## Files Modified
- `src/core/churn-engine.ts` - Added cache, helper function, updated data creation
- `src/core/execution-engine.ts` - Added validation warning
- `scripts/test-marketid-fetch.ts` - Test script (new)
- `MARKETID_FIX.md` - Comprehensive documentation (new)

## No Breaking Changes
The fix is backward compatible - `marketId` is optional in the interface, so existing code continues to work.
