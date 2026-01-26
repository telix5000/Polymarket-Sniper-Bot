/**
 * V2 Types - All type definitions in one place
 */

export type Preset = "conservative" | "balanced" | "aggressive";
export type OrderSide = "BUY" | "SELL";
export type OrderOutcome = "YES" | "NO";

export interface Position {
  tokenId: string;
  conditionId: string;
  marketId?: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  pnlPct: number;
  pnlUsd: number;
  gainCents: number;
  value: number;
  entryTime?: number;
  lastPrice?: number;
  priceHistory?: number[];
  marketEndTime?: number;
}

export interface TradeSignal {
  tokenId: string;
  conditionId: string;
  marketId?: string;
  outcome: string;
  side: OrderSide;
  sizeUsd: number;
  price: number;
  trader: string;
  timestamp: number;
}

export interface OrderResult {
  success: boolean;
  reason?: string;
  filledUsd?: number;
  avgPrice?: number;
  orderId?: string;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}
