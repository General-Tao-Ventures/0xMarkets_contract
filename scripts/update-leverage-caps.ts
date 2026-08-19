/**
 * Sync on-chain MAX_LEVERAGE + leverage ladders from config/markets.ts.
 *
 * Order matters: MAX_LEVERAGE must be mined before setLeverageLadder,
 * because Config.setLeverageLadder rejects any tier above the market max.
 *
 * Usage:
 *   yarn hardhat run scripts/update-leverage-caps.ts --network base
 *   WRITE=true yarn hardhat run scripts/update-leverage-caps.ts --network base
 */
import prompts from "prompts";

import { encodeData } from "../utils/hash";
import * as keys from "../utils/keys";
import { getMarketKey, getMarketTokenAddresses, getOnchainMarkets } from "../utils/market";
import { bigNumberify } from "../utils/math";

async function main() {
  const writeEnv = process.env.WRITE === "true";
  const { read } = hre.deployments;

  const tokens = await hre.gmx.getTokens();
  const markets = await hre.gmx.getMarkets();
  const dataStore = await hre.ethers.getContract("DataStore");
  const config = await hre.ethers.getContract("Config");
  const onchainMarketsByTokens = await getOnchainMarkets(read, dataStore.address);

  const maxLevCalls: string[] = [];
  const ladderPlans: {
    marketToken: string;
    label: string;
    notionals: ReturnType<typeof bigNumberify>[];
    leverages: ReturnType<typeof bigNumberify>[];
  }[] = [];

  for (const marketConfig of markets) {
    if (marketConfig.swapOnly) continue;
    if (marketConfig.maxLeverage === undefined && !marketConfig.leverageLadder?.length) continue;

    let indexToken: string;
    let longToken: string;
    let shortToken: string;
    try {
      [indexToken, longToken, shortToken] = getMarketTokenAddresses(marketConfig, tokens);
    } catch {
      continue;
    }

    const marketKey = getMarketKey(indexToken, longToken, shortToken, marketConfig.reversed);
    const onchainMarket = onchainMarketsByTokens[marketKey];
    const marketToken = onchainMarket?.marketToken;

    if (!marketToken) {
      console.warn(
        `skip: no on-chain market for ${marketConfig.tokens.indexToken}/${marketConfig.tokens.longToken}/${marketConfig.tokens.shortToken}`
      );
      continue;
    }

    const label = `${marketConfig.tokens.indexToken} [${marketConfig.tokens.longToken}-${marketConfig.tokens.shortToken}] (${marketToken})`;

    if (marketConfig.maxLeverage !== undefined) {
      const prev = await dataStore.getUint(keys.maxLeverageKey(marketToken));
      const next = bigNumberify(marketConfig.maxLeverage);
      if (!prev.eq(next)) {
        console.log(
          `maxLeverage ${label}: ${hre.ethers.utils.formatUnits(prev, 30)}x → ${hre.ethers.utils.formatUnits(
            next,
            30
          )}x`
        );
        maxLevCalls.push(
          config.interface.encodeFunctionData("setUint", [
            keys.MAX_LEVERAGE,
            encodeData(["address"], [marketToken]),
            next,
          ])
        );
      }
    }

    const ladder = marketConfig.leverageLadder as { maxNotionalUsd: any; maxLeverage: any }[] | undefined;
    if (ladder?.length) {
      const count = (await dataStore.getUint(keys.leverageLadderTierCountKey(marketToken))).toNumber();
      let changed = count !== ladder.length;
      if (!changed) {
        for (let i = 0; i < ladder.length; i++) {
          const onN = await dataStore.getUint(keys.leverageLadderMaxNotionalKey(marketToken, i));
          const onL = await dataStore.getUint(keys.leverageLadderMaxLeverageKey(marketToken, i));
          if (!onN.eq(bigNumberify(ladder[i].maxNotionalUsd)) || !onL.eq(bigNumberify(ladder[i].maxLeverage))) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        const notionals = ladder.map((t) => bigNumberify(t.maxNotionalUsd));
        const leverages = ladder.map((t) => bigNumberify(t.maxLeverage));
        console.log(
          `ladder ${label}: ${ladder
            .map((t) => hre.ethers.utils.formatUnits(bigNumberify(t.maxLeverage), 30) + "x")
            .join(" → ")}`
        );
        ladderPlans.push({ marketToken, label, notionals, leverages });
      }
    }
  }

  if (maxLevCalls.length === 0 && ladderPlans.length === 0) {
    console.log("no leverage cap changes to apply");
    return;
  }

  console.log(`\npending: ${maxLevCalls.length} maxLeverage + ${ladderPlans.length} ladders`);

  if (maxLevCalls.length > 0) {
    await config.callStatic.multicall(maxLevCalls);
    console.log("maxLeverage multicall simulation ok");
  }

  let shouldWrite = writeEnv;
  if (!shouldWrite) {
    ({ shouldWrite } = await prompts({
      type: "confirm",
      name: "shouldWrite",
      message: "Execute on-chain leverage cap updates?",
      initial: false,
    }));
  }

  if (!shouldWrite) {
    console.log("NOTE: read-only — no transactions sent");
    return;
  }

  if (maxLevCalls.length > 0) {
    const tx = await config.multicall(maxLevCalls);
    console.log(`maxLeverage tx: ${tx.hash}`);
    await tx.wait(1);
  }

  for (const plan of ladderPlans) {
    await config.callStatic.setLeverageLadder(plan.marketToken, plan.notionals, plan.leverages);
    const tx = await config.setLeverageLadder(plan.marketToken, plan.notionals, plan.leverages);
    console.log(`ladder ${plan.label}: ${tx.hash}`);
    await tx.wait(1);
  }

  console.log("done");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
