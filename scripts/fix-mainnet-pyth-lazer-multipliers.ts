/**
 * Fix Base mainnet Pyth Lazer feed multipliers that were configured with
 * tokenDecimals=6 while the synthetic index ERC20s are 18 decimals.
 *
 * Symptom: GOLD/EUR/GBP/XAG/JPY positions store sizeInTokens ~1e12 too small,
 * so the UI shows Entry NA and absurd PnL (e.g. +4900%) while mark looks fine.
 *
 * Formula (non-inverted): 10^(60 - tokenDecimals - feedDecimals)
 * Formula (inverted):     10^(60 + tokenDecimals - feedDecimals)
 *
 * IMPORTANT: Existing open positions were filled with the bad scale. Closing them
 * after this fix (with correct oracle prices) will settle PnL incorrectly.
 * Prefer closing affected positions BEFORE running this, while multipliers are
 * still wrong (open/close stay self-consistent), then apply the fix.
 *
 * Usage (controller/admin key required):
 *   ACCOUNT_KEY=0x... npx hardhat run scripts/fix-mainnet-pyth-lazer-multipliers.ts --network base
 *
 * Dry-run (default): omits ACCOUNT_KEY / set DRY_RUN=1
 */
import { ethers } from "hardhat";

import * as keys from "../utils/keys";

const DATASTORE = "0x694bC761348ac0604944fa81e510a64782A1Cd19";

type Fix = {
  name: string;
  address: string;
  tokenDecimals: number;
  feedDecimals: number;
  inverted: boolean;
};

const FIXES: Fix[] = [
  {
    name: "EUR",
    address: "0x2C6bdB9ab7d2d48710B7dd3349Ba099cdAB3B328",
    tokenDecimals: 18,
    feedDecimals: 5,
    inverted: false,
  },
  {
    name: "GBP",
    address: "0x915327F0726eC569107C1B3F38c8e0Cf87eC9e72",
    tokenDecimals: 18,
    feedDecimals: 5,
    inverted: false,
  },
  {
    name: "GOLD",
    address: "0x82aB51eb790D1C5f1B1434057A215Eb8cF360Da5",
    tokenDecimals: 18,
    feedDecimals: 3,
    inverted: false,
  },
  {
    name: "XAG",
    address: "0xA927aA364535ba04d88Fc5326D0773CC05d92c08",
    tokenDecimals: 18,
    feedDecimals: 5,
    inverted: false,
  },
  {
    name: "JPY",
    address: "0xF40d284eF3F79451E19D500A57539F753dd79Dbf",
    tokenDecimals: 18,
    feedDecimals: 3,
    inverted: true,
  },
];

function expectedMultiplier(tokenDecimals: number, feedDecimals: number, inverted: boolean) {
  const exp = inverted ? 60 + tokenDecimals - feedDecimals : 60 - tokenDecimals - feedDecimals;
  return ethers.BigNumber.from(10).pow(exp);
}

async function main() {
  const dryRun = process.env.DRY_RUN === "1" || !process.env.ACCOUNT_KEY;
  const dataStore = await ethers.getContractAt("DataStore", DATASTORE);

  console.log(`DataStore ${DATASTORE}`);
  console.log(dryRun ? "DRY RUN — no txs will be sent\n" : "LIVE — will update multipliers\n");

  for (const fix of FIXES) {
    const key = keys.pythLazerFeedMultiplierKey(fix.address);
    const current: ReturnType<typeof ethers.BigNumber.from> = await dataStore.getUint(key);
    const next = expectedMultiplier(fix.tokenDecimals, fix.feedDecimals, fix.inverted);
    const match = current.eq(next);

    console.log(`${fix.name} (${fix.address})`);
    console.log(`  inverted=${fix.inverted} tokenDec=${fix.tokenDecimals} feedDec=${fix.feedDecimals}`);
    console.log(`  current  ${current.toString()}  (~1e${current.toString().length - 1})`);
    console.log(`  expected ${next.toString()}  (~1e${next.toString().length - 1})`);

    if (match) {
      console.log("  OK — already correct\n");
      continue;
    }

    if (dryRun) {
      console.log("  WOULD UPDATE\n");
      continue;
    }

    const tx = await dataStore.setUint(key, next);
    console.log(`  tx ${tx.hash}`);
    await tx.wait();
    console.log("  updated\n");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
