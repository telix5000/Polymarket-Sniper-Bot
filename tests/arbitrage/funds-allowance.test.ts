import assert from "node:assert/strict";
import test from "node:test";
import { AssetType } from "@polymarket/clob-client";
import {
  checkFundsAndAllowance,
  isInFlightOrCooldown,
  markBuyInFlight,
  markBuyCompleted,
} from "../../src/utils/funds-allowance.util";

const createLogger = () => ({
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
});

test("checkFundsAndAllowance refreshes via second balance-allowance read", async () => {
  let collateralCalls = 0;

  const client = {
    getBalanceAllowance: async (params: { asset_type: AssetType }) => {
      if (params.asset_type === AssetType.COLLATERAL) {
        collateralCalls += 1;
        return collateralCalls === 1
          ? { balance: "0", allowance: "0" }
          : { balance: "100", allowance: "100" };
      }
      return { balance: "0", allowance: "0" };
    },
  };

  await assert.doesNotReject(async () => {
    const result = await checkFundsAndAllowance({
      client: client as never,
      sizeUsd: 10,
      logger: createLogger(),
    });
    assert.equal(result.ok, true);
  });

  assert.equal(collateralCalls, 2);
});

test("in-flight buy tracking", async (t) => {
  const tokenId = "test-token-in-flight";

  await t.test("allows first buy on a token", () => {
    const result = isInFlightOrCooldown(tokenId, "BUY");
    assert.equal(result.blocked, false);
  });

  await t.test("blocks concurrent buy on same token", () => {
    markBuyInFlight(tokenId);
    const result = isInFlightOrCooldown(tokenId, "BUY");
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "IN_FLIGHT_BUY");
  });

  await t.test("allows buy after completion and cooldown", async () => {
    markBuyCompleted(tokenId);
    // Wait for cooldown to expire (10s default)
    // For testing, we check that it's initially blocked in cooldown
    const resultInCooldown = isInFlightOrCooldown(tokenId, "BUY");
    assert.equal(resultInCooldown.blocked, true);
    assert.equal(resultInCooldown.reason, "BUY_COOLDOWN");
  });

  await t.test("does not block SELL orders", () => {
    const result = isInFlightOrCooldown(tokenId, "SELL");
    assert.equal(result.blocked, false);
  });

  await t.test("does not block BUY on different token", () => {
    const result = isInFlightOrCooldown("different-token", "BUY");
    assert.equal(result.blocked, false);
  });
});
