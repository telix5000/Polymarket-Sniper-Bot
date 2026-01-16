import { DEFAULT_CONFIG, POLYGON_USDC_ADDRESS } from '../constants/polymarket.constants';

export type RuntimeEnv = {
  targetAddresses: string[];
  proxyWallet: string;
  privateKey: string;
  mongoUri?: string;
  rpcUrl: string;
  fetchIntervalSeconds: number;
  tradeMultiplier: number;
  retryLimit: number;
  aggregationEnabled: boolean;
  aggregationWindowSeconds: number;
  collateralTokenAddress: string;
  collateralTokenDecimals: number;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketApiPassphrase?: string;
  minTradeSizeUsd: number; // Minimum trade size to frontrun (USD)
  frontrunSizeMultiplier?: number; // Frontrun size as percentage of target trade (0.0-1.0)
  gasPriceMultiplier?: number; // Gas price multiplier for frontrunning (e.g., 1.2 = 20% higher)
};

type MinTradeChoice = {
  key: string;
  raw: string | undefined;
};

const LEGACY_MIN_TRADE_KEYS = ['MIN_TRADE_SIZE', 'MIN_TRADE_USDC', 'MIN_TRADE_SIZE_USDC'] as const;

export function loadEnv(): RuntimeEnv {
  const read = (key: string): string | undefined => process.env[key] ?? process.env[key.toLowerCase()];

  const parseNumber = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
  };

  const resolveMinTradeSizeUsd = (): number => {
    const canonical = { key: 'MIN_TRADE_SIZE_USD', raw: read('MIN_TRADE_SIZE_USD') };
    const legacy = LEGACY_MIN_TRADE_KEYS.map((key) => ({ key, raw: read(key) }));
    const candidates: MinTradeChoice[] = [canonical, ...legacy];
    const parsedValues = candidates
      .map((choice) => ({ ...choice, parsed: parseNumber(choice.raw) }))
      .filter((choice) => choice.raw !== undefined);

    const canonicalParsed = parseNumber(canonical.raw);
    let selected = canonicalParsed;
    let selectedKey = canonical.raw !== undefined ? canonical.key : undefined;

    if (selected === undefined) {
      const legacyMatch = legacy.map((choice) => ({ ...choice, parsed: parseNumber(choice.raw) })).find((choice) => {
        return choice.parsed !== undefined;
      });
      if (legacyMatch) {
        selected = legacyMatch.parsed;
        selectedKey = legacyMatch.key;
      }
    }

    if (selected === undefined) {
      selected = DEFAULT_CONFIG.MIN_TRADE_SIZE_USD;
      selectedKey = 'DEFAULT_CONFIG.MIN_TRADE_SIZE_USD';
    }

    const legacyUsed = legacy.some((choice) => choice.raw !== undefined);
    const canonicalSet = canonical.raw !== undefined;
    if (legacyUsed || (canonicalSet && canonicalParsed === undefined)) {
      const legacyList = legacy.filter((choice) => choice.raw !== undefined).map((choice) => choice.key);
      const details = legacyList.length ? ` Legacy vars detected: ${legacyList.join(', ')}.` : '';
      const rawValues = parsedValues
        .map((choice) => `${choice.key}=${choice.raw}`)
        .join(', ');
      const rawSuffix = rawValues ? ` Raw: ${rawValues}.` : '';
      // eslint-disable-next-line no-console
      console.warn(
        `[Config] Using MIN_TRADE_SIZE_USD=${selected} (source=${selectedKey}).${details}${rawSuffix}`,
      );
    }

    return selected;
  };

  const parseList = (val: string | undefined): string[] => {
    if (!val) return [];
    try {
      const maybeJson = JSON.parse(val);
      if (Array.isArray(maybeJson)) return maybeJson.map(String);
    } catch (_) {
      // not JSON, parse as comma separated
    }
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const required = (name: string, v: string | undefined): string => {
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  const targetAddresses = parseList(read('TARGET_ADDRESSES'));
  if (targetAddresses.length === 0) {
    throw new Error('TARGET_ADDRESSES must contain at least one trader address');
  }

  const env: RuntimeEnv = {
    targetAddresses,
    proxyWallet: required('PUBLIC_KEY', read('PUBLIC_KEY')),
    privateKey: required('PRIVATE_KEY', read('PRIVATE_KEY')),
    mongoUri: read('MONGO_URI'),
    rpcUrl: required('RPC_URL', read('RPC_URL')),
    fetchIntervalSeconds: Number(read('FETCH_INTERVAL') ?? DEFAULT_CONFIG.FETCH_INTERVAL_SECONDS),
    tradeMultiplier: Number(read('TRADE_MULTIPLIER') ?? DEFAULT_CONFIG.TRADE_MULTIPLIER),
    retryLimit: Number(read('RETRY_LIMIT') ?? DEFAULT_CONFIG.RETRY_LIMIT),
    aggregationEnabled: String(read('TRADE_AGGREGATION_ENABLED') ?? 'false') === 'true',
    aggregationWindowSeconds: Number(read('TRADE_AGGREGATION_WINDOW_SECONDS') ?? DEFAULT_CONFIG.AGGREGATION_WINDOW_SECONDS),
    collateralTokenAddress: read('COLLATERAL_TOKEN_ADDRESS') || read('USDC_CONTRACT_ADDRESS') || POLYGON_USDC_ADDRESS,
    collateralTokenDecimals: Number(read('COLLATERAL_TOKEN_DECIMALS') ?? 6),
    polymarketApiKey: read('POLYMARKET_API_KEY'),
    polymarketApiSecret: read('POLYMARKET_API_SECRET'),
    polymarketApiPassphrase: read('POLYMARKET_API_PASSPHRASE'),
    minTradeSizeUsd: resolveMinTradeSizeUsd(),
    frontrunSizeMultiplier: Number(read('FRONTRUN_SIZE_MULTIPLIER') ?? DEFAULT_CONFIG.FRONTRUN_SIZE_MULTIPLIER),
    gasPriceMultiplier: Number(read('GAS_PRICE_MULTIPLIER') ?? DEFAULT_CONFIG.GAS_PRICE_MULTIPLIER),
  };

  return env;
}
