export const formatClobAuthFailureHint = (deriveEnabled: boolean): string => {
  const deriveHint = deriveEnabled
    ? "Derived keys are enabled; ensure the wallet has traded on Polymarket at least once."
    : "If you want wallet-derived keys, set CLOB_DERIVE_CREDS=true (or CLOB_DERIVE_API_KEY=true) and remove manual API keys.";
  return [
    "[CLOB] Auth hint: If this is a NEW WALLET that has never traded on Polymarket,",
    "you MUST make at least one trade on https://polymarket.com before the API will create credentials.",
    "Otherwise, verify POLYMARKET_API_KEY/SECRET/PASSPHRASE are CLOB API keys (not browser/session tokens),",
    "match the production environment, and regenerate them if rotated.",
    "IMPORTANT: Builder API keys (POLY_BUILDER_*) are NOT the same as CLOB API keys - they are for gasless relayer transactions only.",
    deriveHint,
  ].join(" ");
};
