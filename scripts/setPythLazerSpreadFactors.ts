import hre from "hardhat";
import prompts from "prompts";

import { TokenConfig } from "../config/tokens";
import { appendUintConfigIfDifferent, getFullKey } from "../utils/config";
import * as keys from "../utils/keys";
import { bigNumberify, decimalToFloat } from "../utils/math";

// Per-pair widening applied to the Pyth Lazer confidence.
//
// PythLazerFeedProvider prices the band as mid +/- (confidence * factor), so a factor of 1 is the
// raw confidence on each side and a round trip crosses twice that. Keyed by Lazer feed id rather
// than symbol because config/tokens.ts reuses symbols across networks.
//
// USDC (feed 7) is deliberately absent. It is the collateral and pool token rather than a traded
// pair, so there is no pair spread to widen, and writing a factor here would change collateral
// valuation instead. Leaving it out keeps it at whatever it is already set to.
// BTC is listed at 1x, which is already the deployed value. Kept in the table so the intent is
// recorded rather than looking like an omission; the run skips it because nothing changes.
// Expressed in hundredths so a factor can be fractional: 125 is 1.25x. decimalToFloat takes an
// integer, so the value is scaled with 2 decimals rather than passed as a JS float.
//
// A factor of 1.00 quotes exactly the Pyth confidence band and is the practical floor. Below that
// the quote sits inside the feed's own uncertainty, taking the other side of moves the feed has
// not resolved yet. BTC and ETH are already at the floor and cannot be tightened by this table.
//
// bps figures below are a round trip at the confidence reading of 2026-08-19 and move with it, so
// treat them as the shape of the change rather than a guarantee.
const FACTOR_HUNDREDTHS_BY_FEED_ID: Record<number, number> = {
  36: 200, // TAO/USD    2.00x  49.40 -> 9.88 bps  (was 10x, by far the widest)
  346: 150, // GOLD/USD  1.50x   3.38 -> 1.27 bps
  327: 200, // EUR/USD   2.00x   2.08 -> 1.04 bps
  340: 200, // USD/JPY   2.00x   1.51 -> 0.76 bps
  2: 100, // ETH/USD     1.00x   8.66 -> 4.33 bps  (floor)
  345: 125, // SILVER    1.25x   8.12 -> 5.08 bps
  333: 125, // GBP/USD   1.25x   2.07 -> 1.29 bps
  1: 100, // BTC/USD     1.00x   unchanged, already at floor
};

async function main() {
  const tokens: Record<string, TokenConfig> = await hre.gmx.getTokens();
  const dataStore = await hre.ethers.getContract("DataStore");
  const multicall = await hre.ethers.getContract("Multicall3");
  const config = await hre.ethers.getContract("Config");

  const targets: { label: string; address: string; feedId: number; factor: number }[] = [];
  for (const [symbol, token] of Object.entries(tokens)) {
    const factor = token.pythLazerFeedId ? FACTOR_HUNDREDTHS_BY_FEED_ID[token.pythLazerFeedId] : undefined;
    if (factor === undefined) {
      continue;
    }
    if (!token.address) {
      throw new Error(`token ${symbol} has no address`);
    }
    targets.push({ label: symbol, address: token.address, feedId: token.pythLazerFeedId, factor });
  }

  const missing = Object.keys(FACTOR_HUNDREDTHS_BY_FEED_ID)
    .map(Number)
    .filter((feedId) => !targets.some((t) => t.feedId === feedId));
  if (missing.length > 0) {
    // A feed id in the table that no configured token claims means the table and the token config
    // have drifted. Writing the rest would leave a pair silently un-widened.
    throw new Error(`no token configured for pyth lazer feed ids: ${missing.join(", ")}`);
  }

  const readParams = targets.map((t) => ({
    target: dataStore.address,
    allowFailure: false,
    callData: dataStore.interface.encodeFunctionData("getUint", [
      getFullKey(keys.PYTH_LAZER_FEED_SPREAD_FACTOR, hre.ethers.utils.defaultAbiCoder.encode(["address"], [t.address])),
    ]),
  }));

  const results = await multicall.callStatic.aggregate3(readParams);

  const dataCache: Record<string, any> = {};
  const multicallWriteParams: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const keyData = hre.ethers.utils.defaultAbiCoder.encode(["address"], [t.address]);
    const fullKey = getFullKey(keys.PYTH_LAZER_FEED_SPREAD_FACTOR, keyData);
    const current = bigNumberify(results[i].returnData);
    dataCache[fullKey] = current;

    console.log(
      `${t.label.padEnd(6)} ${t.address}  feed ${String(t.feedId).padStart(3)}  ` +
        `${(Number(current.toString()) / 1e30).toFixed(2).padStart(5)}x -> ${(t.factor / 100).toFixed(2)}x`
    );

    await appendUintConfigIfDifferent(
      multicallWriteParams,
      dataCache,
      keys.PYTH_LAZER_FEED_SPREAD_FACTOR,
      keyData,
      decimalToFloat(t.factor, 2),
      `pythLazerFeedSpreadFactor ${t.label}`
    );
  }

  console.log(`\nupdating ${multicallWriteParams.length} params on ${hre.network.name}`);

  if (multicallWriteParams.length === 0) {
    console.log("no changes to apply");
    return;
  }

  // WRITE unset prompts; WRITE=false is an explicit dry run so it must not stop on a prompt that
  // a non-interactive shell cannot answer.
  let write = process.env.WRITE === "true";
  if (process.env.WRITE === undefined) {
    ({ write } = await prompts({
      type: "confirm",
      name: "write",
      message: "Do you want to execute the transactions?",
    }));
  }

  if (!write) {
    // Config.multicall is onlyKeeper, so a simulation from an unfunded local signer reverts with
    // Unauthorized before it can prove anything about the calldata. Set CONFIG_KEEPER to the
    // holder address to simulate as them and get a real dry run without holding the key.
    const from = process.env.CONFIG_KEEPER;
    await config.callStatic.multicall(multicallWriteParams, from ? { from } : {});
    console.log(
      from
        ? `NOTE: simulated as ${from}, no transactions were sent`
        : "NOTE: executed in read-only mode, no transactions were sent"
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
