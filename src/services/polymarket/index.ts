/**
 * Polymarket Services Index
 *
 * Central export point for all Polymarket API services.
 * Provides a clean API for interacting with Polymarket's REST and WebSocket APIs.
 *
 * Usage:
 *   import { createClobClient, WebSocketMarketClient } from '../services/polymarket';
 */

// REST API client and functions
export * from "./rest-client";

// WebSocket clients and data layer
export * from "./ws-client";
