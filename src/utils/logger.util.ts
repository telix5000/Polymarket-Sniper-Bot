/**
 * Simple Console Logger
 */

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

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
