/**
 * Services Index
 *
 * Central export point for all service modules.
 * Services encapsulate external API interactions and provide clean interfaces.
 *
 * Available services:
 * - polymarket: Polymarket REST and WebSocket clients with centralized
 *   rate limiting, retry logic, and reconnect handling
 *
 * Usage:
 *   // Import from services
 *   import { createClobClient, rateLimiters, getWebSocketMarketClient } from './services';
 *
 *   // Or import directly from polymarket submodule
 *   import { withRateLimitAndRetry } from './services/polymarket';
 */

// Polymarket services
export * from "./polymarket";
