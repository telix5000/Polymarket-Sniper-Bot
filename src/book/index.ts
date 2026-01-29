/**
 * Book Module - Unified orderbook resolution and health checking
 *
 * This module provides a shared interface for both WHALE and SCAN flows
 * to fetch and validate orderbook data in a consistent manner.
 *
 * Usage:
 *   import { getBookResolver, type BookHealth } from "../book";
 *
 *   const resolver = getBookResolver(clobClient);
 *   const result = await resolver.resolveHealthyBook({
 *     tokenId: "...",
 *     flow: "whale", // or "scan"
 *   });
 *
 *   if (result.success) {
 *     // Use result.snapshot and result.health
 *   }
 */

// Export types
export type {
  NormalizedLevel,
  OrderBookSnapshot,
  BookHealth,
  BookResolverHealthStatus,
  ResolveBookParams,
  ResolveBookResult,
} from "./types";

// Export thresholds constant
export { BOOK_THRESHOLDS } from "./types";

// Export BookResolver class and singleton functions
export {
  BookResolver,
  getBookResolver,
  initBookResolver,
  isBookResolverInitialized,
} from "./BookResolver";
