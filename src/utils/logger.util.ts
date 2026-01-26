/**
 * Simple Console Logger
 *
 * This module re-uses the shared Logger interface from src/lib/types.ts
 * to avoid duplication and divergence.
 */

import type { Logger } from "../lib/types";

export type { Logger };

/**
 * Console-based implementation of the shared Logger interface.
 */
export class ConsoleLogger implements Logger {
  info(msg: string): void {
    console.log(msg);
  }

  warn(msg: string): void {
    console.warn(msg);
  }

  error(msg: string): void {
    console.error(msg);
  }

  debug(msg: string): void {
    if (process.env.LOG_LEVEL === "debug") {
      console.log(`[DEBUG] ${msg}`);
    }
  }
}
