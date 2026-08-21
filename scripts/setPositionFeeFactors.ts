import hre from "hardhat";
import prompts from "prompts";

import { appendUintConfigIfDifferent, getFullKey } from "../utils/config";
import { encodeData } from "../utils/hash";
import * as keys from "../utils/keys";
import { getMarketKey, getMarketTokenAddresses, getOnchainMarkets } from "../utils/market";
import { bigNumberify, percentageToFloat } from "../utils/math";

// Sets the position fee factor per market, writing only that key.
//
// updateMarketConfig.ts is the general tool, but it syncs the whole market config and the deployed
// maxLeverage currently differs from config/markets.ts, so a full sync would also change leverage
// and strand the ladders. This keeps the fee change independent of that.
//
// Live on Base today, by asset class:
//   fx         EUR GBP JPY      0.015% / 0.025%
//   commodity  GOLD XAG         0.020% / 0.030%
//   crypto     WBTC WETH TAO    0.030% / 0.040%
//
// The tiering is deliberate: config/markets.ts sets fee alongside maxPnlFactorForTraders (90/85/70%)
// and maxLeverage (100x/50x/-) in the same per-class override block, so the fee is the pricing side
// of a risk gradient rather than a standalone number. Flattening it to one rate across all three
// classes prices crypto and commodity risk the same as FX.
type AssetClass = "fx" | "commodity" | "crypto";

const CLASS_BY_INDEX_TOKEN: Record<string, AssetClass> = {
  EUR: "fx",
  GBP: "fx",
  JPY: "fx",
  GOLD: "commodity",
  XAG: "commodity",
  WBTC: "crypto",
  WETH: "crypto",
  TAO: "crypto",
};

const FEE_BY_CLASS: Record<AssetClass, { positiveImpact: string; negativeImpact: string }> = {
  fx: { positiveImpact: "0.015%", negativeImpact: "0.025%" },
  commodity: { positiveImpact: "0.015%", negativeImpact: "0.025%" },
  crypto: { positiveImpact: "0.015%", negativeImpact: "0.025%" },
};

async function main() {
  const { read } = hre.deployments;

  const tokens = await hre.gmx.getTokens();
  const markets = await hre.gmx.getMarkets();
  const dataStore = await hre.ethers.getContract("DataStore");
  const multicall = await hre.ethers.getContract("Multicall3");
  const config = await hre.ethers.getContract("Config");

  const onchainMarketsByTokens = await getOnchainMarkets(read, dataStore.address);

  const targets: {
    label: string;
    marketToken: string;
    assetClass: AssetClass;
    forPositiveImpact: boolean;
    factor: any;
  }[] = [];

  for (const marketConfig of markets) {
    const indexToken = marketConfig.tokens.indexToken;
    const assetClass = CLASS_BY_INDEX_TOKEN[indexToken];
    if (assetClass === undefined) {
      // A market with no class mapping would silently keep its old fee while every other market
      // moved, which is the kind of partial application that is hard to notice afterwards.
      throw new Error(`no asset class mapped for index token ${indexToken}`);
    }

    const [index, long, short] = getMarketTokenAddresses(marketConfig, tokens);
    const onchainMarket = onchainMarketsByTokens[getMarketKey(index, long, short)];
    if (!onchainMarket) {
      throw new Error(`market ${indexToken} is in config but not deployed`);
    }

    const fees = FEE_BY_CLASS[assetClass];
    targets.push({
      label: indexToken,
      marketToken: onchainMarket.marketToken,
      assetClass,
      forPositiveImpact: true,
      factor: percentageToFloat(fees.positiveImpact),
    });
    targets.push({
      label: indexToken,
      marketToken: onchainMarket.marketToken,
      assetClass,
      forPositiveImpact: false,
      factor: percentageToFloat(fees.negativeImpact),
    });
  }

  const results = await multicall.callStatic.aggregate3(
    targets.map((t) => ({
      target: dataStore.address,
      allowFailure: false,
      callData: dataStore.interface.encodeFunctionData("getUint", [
        getFullKey(keys.POSITION_FEE_FACTOR, encodeData(["address", "bool"], [t.marketToken, t.forPositiveImpact])),
      ]),
    }))
  );

  const dataCache: Record<string, any> = {};
  const multicallWriteParams: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const keyData = encodeData(["address", "bool"], [t.marketToken, t.forPositiveImpact]);
    const fullKey = getFullKey(keys.POSITION_FEE_FACTOR, keyData);
    const current = bigNumberify(results[i].returnData);
    dataCache[fullKey] = current;

    const pct = (v: any) => `${(Number(v.toString()) / 1e30) * 100}%`;
    console.log(
      `${t.label.padEnd(5)} ${t.assetClass.padEnd(10)} ${t.forPositiveImpact ? "improving" : "worsening"}  ` +
        `${pct(current).padStart(8)} -> ${pct(t.factor)}`
    );

    await appendUintConfigIfDifferent(
      multicallWriteParams,
      dataCache,
      keys.POSITION_FEE_FACTOR,
      keyData,
      t.factor,
      `positionFeeFactor ${t.label} ${t.forPositiveImpact}`
    );
  }

  console.log(`\nupdating ${multicallWriteParams.length} params on ${hre.network.name}`);

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
