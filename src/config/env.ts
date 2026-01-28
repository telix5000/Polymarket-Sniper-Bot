/**
 * Environment Variable Parsing Helpers
 *
 * Centralized utilities for parsing environment variables with type safety
 * and validation. These helpers reduce duplication and ensure consistent
 * behavior across the application.
 */

/**
 * Parse a numeric environment variable with a default value
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @returns Parsed number or default
 */
export function envNum(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a boolean environment variable with a default value
 *
 * Accepts: "true", "false", "1", "0", "yes", "no" (case-insensitive)
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns Parsed boolean or default
 */
export function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase().trim();
  if (normalized === "true" || normalized === "1" || normalized === "yes")
    return true;
  if (normalized === "false" || normalized === "0" || normalized === "no")
    return false;
  return defaultValue;
}

/**
 * Parse a string environment variable with optional validation
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @param validValues - Optional array of valid values to check against
 * @returns Parsed string or default
 */
export function envStr<T extends string>(
  key: string,
  defaultValue: T,
  validValues?: T[],
): T {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  if (validValues && !validValues.includes(value as T)) {
    console.warn(
      `Invalid value for ${key}: ${value}. Using default: ${defaultValue}`,
    );
    return defaultValue;
  }
  return value as T;
}

/**
 * Parse an optional float with a default value
 * Returns default if not set, undefined if explicitly set to empty string (to disable)
 * Warns if value is outside expected [0,1] range
 *
 * @param value - Raw environment variable value
 * @param defaultValue - Default value if not set
 * @returns Parsed number, undefined, or default
 */
export function parseOptionalFloatWithDefault(
  value: string | undefined,
  defaultValue: number,
): number | undefined {
  // If env var is not set at all, use default
  if (value === undefined) return defaultValue;

  // If env var is explicitly set to empty string, disable (return undefined)
  if (value === "") return undefined;

  const parsed = parseFloat(value);
  if (isNaN(parsed)) return defaultValue;

  // Warn if value seems like a percentage (outside [0,1] range)
  if (parsed < 0 || parsed > 1) {
    console.warn(
      `[WARN] Price value ${parsed} is outside expected [0,1] range. ` +
        `Use decimal format (e.g., 0.25 for 25 cents, not 25).`,
    );
    // Fall back to the provided default to avoid using an invalid configuration value
    return defaultValue;
  }

  return parsed;
}

/**
 * Parse an enum-like environment variable
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @param validValues - Array of valid values
 * @param aliases - Optional map of alias -> canonical value (alias values must be in validValues)
 * @returns Parsed value or default
 */
export function envEnum<T extends string>(
  key: string,
  defaultValue: T,
  validValues: T[],
  aliases?: Record<string, T>,
): T {
  const value = process.env[key];
  if (value === undefined) return defaultValue;

  const normalized = value.toLowerCase().trim();

  // Check aliases first - ensure the alias maps to a valid value
  if (aliases && normalized in aliases) {
    const aliasedValue = aliases[normalized];
    if (validValues.includes(aliasedValue)) {
      return aliasedValue;
    }
    // Alias maps to invalid value - fall through to default handling
  }

  // Check valid values
  if (validValues.includes(normalized as T)) {
    return normalized as T;
  }

  console.warn(
    `Invalid value for ${key}: ${value}. Valid values: ${validValues.join(", ")}. Using default: ${defaultValue}`,
  );
  return defaultValue;
}

/**
 * Get a required environment variable or throw
 *
 * @param key - Environment variable name
 * @returns The value
 * @throws Error if not set
 */
export function envRequired(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

/**
 * Parse an environment variable as a comma-separated list
 *
 * @param key - Environment variable name
 * @param defaultValue - Default value if not set
 * @returns Array of trimmed strings
 */
export function envList(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];
  if (value === undefined || value === "") return defaultValue;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
