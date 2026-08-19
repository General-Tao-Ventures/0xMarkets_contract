import hre from "hardhat";
import prompts from "prompts";

import { appendUintConfigIfDifferent, getFullKey } from "../utils/config";
import { encodeData } from "../utils/hash";
import * as keys from "../utils/keys";
import { getMarketKey, getMarketTokenAddresses, getOnchainMarkets } from "../utils/market";
import { bigNumberify } from "../utils/math";

// Switches the borrow fee from the scale-dependent legacy curve to the utilisation kink, writing
// only the four keys that change and nothing else.
//
// updateMarketConfig.ts is the general tool for this, but it syncs the whole market config. On Base
// the deployed maxLeverage is currently 2x what config/markets.ts says on every market, so a full
// sync would also halve leverage — and it writes MAX_LEVERAGE without touching the ladders, which
// would leave tier 0 above the market max and make every later setLeverageLadder call revert. This
// script exists to keep the borrow change independent of that until the drift is resolved.
const BORROW_KEYS = [
  {
    baseKey: keys.OPTIMAL_USAGE_FACTOR,
    longField: "optimalUsageFactorForLongs",
    shortField: "optimalUsageFactorForShorts",
  },
  {
    baseKey: keys.BASE_BORROWING_FACTOR,
    longField: "baseBorrowingFactorForLongs",
    shortField: "baseBorrowingFactorForShorts",
  },
  {
    baseKey: keys.ABOVE_OPTIMAL_USAGE_BORROWING_FACTOR,
    longField: "aboveOptimalUsageBorrowingFactorForLongs",
    shortField: "aboveOptimalUsageBorrowingFactorForShorts",
  },
  { baseKey: keys.BORROWING_FACTOR, longField: "borrowingFactorForLongs", shortField: "borrowingFactorForShorts" },
] as const;

async function main() {
  const { read } = hre.deployments;

  const tokens = await hre.gmx.getTokens();
  const markets = await hre.gmx.getMarkets();
  const dataStore = await hre.ethers.getContract("DataStore");
  const multicall = await hre.ethers.getContract("Multicall3");
  const config = await hre.ethers.getContract("Config");

  const onchainMarketsByTokens = await getOnchainMarkets(read, dataStore.address);

  const entries: { label: string; fullKey: string; value: any }[] = [];

  for (const marketConfig of markets) {
    const [indexToken, longToken, shortToken] = getMarketTokenAddresses(marketConfig, tokens);
    const marketKey = getMarketKey(indexToken, longToken, shortToken);
    const onchainMarket = onchainMarketsByTokens[marketKey];
    if (!onchainMarket) {
      // A market in config that was never deployed is not something to skip quietly: the run would
      // report success having left that market on the old curve.
      throw new Error(`market ${marketConfig.tokens.indexToken} is in config but not deployed`);
    }
    const marketToken = onchainMarket.marketToken;
    const label = `${marketConfig.tokens.indexToken}`;

    for (const { baseKey, longField, shortField } of BORROW_KEYS) {
      for (const [isLong, field] of [
        [true, longField],
        [false, shortField],
      ] as const) {
        const value = marketConfig[field];
        if (value === undefined) {
          throw new Error(`${label}: ${field} is not set in config`);
        }
        entries.push({
          label: `${field} ${label}`,
          fullKey: getFullKey(baseKey, encodeData(["address", "bool"], [marketToken, isLong])),
          value,
        });
      }
    }
  }

  const results = await multicall.callStatic.aggregate3(
    entries.map((e) => ({
      target: dataStore.address,
      allowFailure: false,
      callData: dataStore.interface.encodeFunctionData("getUint", [e.fullKey]),
    }))
  );

  const dataCache: Record<string, any> = {};
  for (let i = 0; i < entries.length; i++) {
    dataCache[entries[i].fullKey] = bigNumberify(results[i].returnData);
  }

  const multicallWriteParams: string[] = [];
  for (const marketConfig of markets) {
    const [indexToken, longToken, shortToken] = getMarketTokenAddresses(marketConfig, tokens);
    const marketToken = onchainMarketsByTokens[getMarketKey(indexToken, longToken, shortToken)].marketToken;
    const label = `${marketConfig.tokens.indexToken}`;

    for (const { baseKey, longField, shortField } of BORROW_KEYS) {
      for (const [isLong, field] of [
        [true, longField],
        [false, shortField],
      ] as const) {
        await appendUintConfigIfDifferent(
          multicallWriteParams,
          dataCache,
          baseKey,
          encodeData(["address", "bool"], [marketToken, isLong]),
          marketConfig[field],
          `${field} ${label} (${marketToken})`
        );
      }
    }
  }

  console.log(`\nupdating ${multicallWriteParams.length} params on ${hre.network.name}`);
  console.log(
    `(${markets.length} markets x 2 sides x ${BORROW_KEYS.length} keys = ${
      markets.length * 2 * BORROW_KEYS.length
    } checked)`
  );

  if (multicallWriteParams.length === 0) {
    console.log("no changes to apply");
    return;
  }

  // WRITE unset prompts; WRITE=false is an explicit dry run so it must not stop on a prompt that a
  // non-interactive shell cannot answer.
  let write = process.env.WRITE === "true";
  if (process.env.WRITE === undefined) {
    ({ write } = await prompts({
      type: "confirm",
      name: "write",
      message: "Do you want to execute the transactions?",
    }));
  }

  if (!write) {
    // Config.multicall is onlyKeeper, so simulating from an unfunded local signer reverts with
    // Unauthorized before it proves anything about the calldata. Set CONFIG_KEEPER to simulate as
    // the holder and get a real dry run without the key.
    const from = process.env.CONFIG_KEEPER;
    await config.callStatic.multicall(multicallWriteParams, from ? { from } : {});
    console.log(
      from ? `NOTE: simulated as ${from}, no transactions were sent` : "NOTE: read-only, no transactions were sent"
    );
    return;
  }

  const tx = await config.multicall(multicallWriteParams);
  console.log(`tx sent: ${tx.hash}`);
  await tx.wait(1);
  console.log("confirmed");
}

main()
  .then(() => process.exit(0))
  .catch((ex) => {
    console.error(ex);
    process.exit(1);
  });
