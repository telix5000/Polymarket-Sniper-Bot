import chalk from "chalk";
import { getLogDedupe, type LogLevel as DedupeLevel } from "./log-dedupe.util";

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string, err?: Error) => void;
  debug: (msg: string) => void;
}

const DEBUG_LEVELS = new Set(["", "debug", "trace"]);

const shouldLogDebug = (): boolean => {
  const read = (key: string): string | undefined =>
    process.env[key] ?? process.env[key.toLowerCase()];
  const logLevel = (read("LOG_LEVEL") ?? "").toLowerCase();
  if (read("DEBUG") === "1") {
    return true;
  }
  return DEBUG_LEVELS.has(logLevel);
};

export class ConsoleLogger implements Logger {
  info(msg: string): void {
    const dedupe = getLogDedupe();
    const result = dedupe.shouldEmit("info" as DedupeLevel, msg);
    if (!result.emit) return;

    const outputMsg = result.suffix ? `${msg} ${result.suffix}` : msg;
    console.log(chalk.cyan("[INFO]"), outputMsg);
  }

  warn(msg: string): void {
    const dedupe = getLogDedupe();
    const result = dedupe.shouldEmit("warn" as DedupeLevel, msg);
    if (!result.emit) return;

    const outputMsg = result.suffix ? `${msg} ${result.suffix}` : msg;
    console.warn(chalk.yellow("[WARN]"), outputMsg);
  }

  error(msg: string, err?: Error): void {
    const dedupe = getLogDedupe();
    const result = dedupe.shouldEmit("error" as DedupeLevel, msg);
    if (!result.emit) return;

    const outputMsg = result.suffix ? `${msg} ${result.suffix}` : msg;
    console.error(
      chalk.red("[ERROR]"),
      outputMsg,
      err ? `\n${err.stack ?? err.message}` : "",
    );
  }

  debug(msg: string): void {
    if (!shouldLogDebug()) return;

    const dedupe = getLogDedupe();
    const result = dedupe.shouldEmit("debug" as DedupeLevel, msg);
    if (!result.emit) return;

    const outputMsg = result.suffix ? `${msg} ${result.suffix}` : msg;
    console.debug(chalk.gray("[DEBUG]"), outputMsg);
  }
}
