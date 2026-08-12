import { ethers, network } from "hardhat";
import { BigNumber } from "ethers";

/**
 * Lower max funding so the cap is ~0.03% per 8h instead of ~0.08% (90%/yr).
 *
 * 0.03% / 8h ≈ 33%/yr. Also scales fundingIncreaseFactorPerSecond so time-to-max
 * at 100% imbalance stays ~3 hours.
 *
 * Dry-run by default:
 *   WRITE=true npx hardhat run scripts/updateFundingCaps.ts --network base
 */

const SECONDS_PER_YEAR = 31536000;
const SECONDS_PER_HOUR = 3600;

function expandDecimals(n: number | BigNumber, decimals: number): BigNumber {
  return BigNumber.from(n).mul(BigNumber.from(10).pow(decimals));
}

function hashString(s: string): string {
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], [s]));
}

function encodeData(types: string[], values: unknown[]): string {
  return ethers.utils.hexlify(ethers.utils.defaultAbiCoder.encode(types, values));
}

function getFullKey(baseKey: string, keyData: string): string {
  if (keyData === "0x") return baseKey;
  const keyArray = ethers.utils.concat([ethers.utils.arrayify(baseKey), ethers.utils.arrayify(keyData)]);
  return ethers.utils.keccak256(keyArray);
}

const KEYS = {
  MAX_FUNDING_FACTOR_PER_SECOND: hashString("MAX_FUNDING_FACTOR_PER_SECOND"),
  FUNDING_INCREASE_FACTOR_PER_SECOND: hashString("FUNDING_INCREASE_FACTOR_PER_SECOND"),
};

// ~0.03% per 8h; was ~0.082% at 90%/yr (~2.5x cut)
const TARGETS = {
  maxFundingFactorPerSecond: expandDecimals(33, 28).div(SECONDS_PER_YEAR), // 33%/yr
  fundingIncreaseFactorPerSecond: expandDecimals(33, 28)
    .div(SECONDS_PER_YEAR)
    .div(SECONDS_PER_HOUR * 3),
};

const NETWORK_CONFIG: Record<
  string,
  {
    dataStore: string;
    config: string;
    multicall: string;
    markets: Record<string, string>;
  }
> = {
  base: {
    dataStore: "0x694bC761348ac0604944fa81e510a64782A1Cd19",
    config: "0x7956dC2A1F3429E1c7DBcBe27da540AC80bf42ee",
    multicall: "0xC08611C938Ee807cc25e8b80AbB1d764cdd20057",
    markets: {
      "EUR/USD": "0xF8EEf96D4af581d60d394AFD613ea75C502945dc",
      "GBP/USD": "0x518B8cEEa7831a02143cEaDe3B68b0724964e0C8",
      "JPY/USD": "0x516dE27eeb84cD7f86035a03f29187aC3b3448f4",
      "GOLD/USD": "0x2D5832AC0553752444D8c0dCfA654105Da9897c4",
      "SILVER/USD": "0x73cc35AC21C6675eF5204078cAb42Cb5fB6c0F23",
      "WBTC/USD": "0x7D44b88a68c6222693c6aba6e7F4fd0a23393179",
      "WETH/USD": "0x35ecCBcAb7963Ea442D25aF1c405f8Cea27D8cF7",
      "TAO/USD": "0xbC711DA54efD90dD424000B8fdFa886dbFfbDe9d",
    },
  },
  baseSepolia: {
    dataStore: "0x0cA7D71845cb485B7593bBdCbcac93d82d52d053",
    config: "0x6Bb0b11ad8C6E7C4D501dd05f14daaaa4940cAF0",
    multicall: "0xdD6E2999d0a882886A50c031c7a117058B4aCB5f",
    markets: {
      "EUR/USD": "0x7054eb596aCF4fC1C0686C9B2cdAC4aE6c6D0F33",
      "GBP/USD": "0xa09b59adf15B4ED98a099441b84Ff1eABf71B548",
      "USD/JPY": "0xD847a999faCe1f862120117C33ae8faBA768fD4b",
      "GOLD/USD": "0x89c3B33bEE4b9cD1B246BE44aDcEd870F74637a3",
      "XAG/USD": "0x6D260c4229dBb55a0a91041b5c07b320fdD6303B",
      "WTI/USD": "0x80d260188c592F7F175F843EDc257b6A6Af6e5eF",
      "WBTC/USD": "0x63D05Da932541380df8d9eE20D8FdB4B02849398",
      "WETH/USD": "0x23F40e3279685413b252A6944AF9a0641D3aa6ce",
      "TAO/USD": "0x24061f45f954D880dCa0Ce122FFA60Cfd5447B5A",
    },
  },
};

interface ConfigEntry {
  baseKey: string;
  keyData: string;
  value: BigNumber;
  label: string;
}

function buildEntries(markets: Record<string, string>): ConfigEntry[] {
  const entries: ConfigEntry[] = [];

  for (const [name, marketToken] of Object.entries(markets)) {
    const keyData = encodeData(["address"], [marketToken]);

    entries.push({
      baseKey: KEYS.MAX_FUNDING_FACTOR_PER_SECOND,
      keyData,
      value: TARGETS.maxFundingFactorPerSecond,
      label: `maxFundingFactorPerSecond ${name}`,
    });
    entries.push({
      baseKey: KEYS.FUNDING_INCREASE_FACTOR_PER_SECOND,
      keyData,
      value: TARGETS.fundingIncreaseFactorPerSecond,
      label: `fundingIncreaseFactorPerSecond ${name}`,
    });
  }

  return entries;
}

async function main() {
  const write = process.env.WRITE === "true";
  const networkName = network.name;
  const cfg = NETWORK_CONFIG[networkName];

  if (!cfg) {
    throw new Error(`Unsupported network "${networkName}". Use --network base or --network baseSepolia.`);
  }

  const per8hPct = (((33 / 100) * (8 * SECONDS_PER_HOUR)) / SECONDS_PER_YEAR) * 100;

  console.log(`Network: ${networkName}`);
  console.log(`DataStore: ${cfg.dataStore}`);
  console.log(`Config:    ${cfg.config}`);
  console.log(`WRITE:     ${write}`);
  console.log("\n── Targets (funding caps) ──");
  console.log(`  maxFundingFactorPerSecond:          33%/yr (~${per8hPct.toFixed(3)}% / 8h)`);
  console.log(`  fundingIncreaseFactorPerSecond:     33%/yr / 3h to max`);

  const dataStore = await ethers.getContractAt("DataStore", cfg.dataStore);
  const config = await ethers.getContractAt("Config", cfg.config);
  const multicall = await ethers.getContractAt("Multicall3", cfg.multicall);

  const entries = buildEntries(cfg.markets);
  console.log(`\nChecking ${entries.length} keys across ${Object.keys(cfg.markets).length} markets...`);

  const readParams = entries.map((entry) => ({
    target: cfg.dataStore,
    allowFailure: false,
    callData: dataStore.interface.encodeFunctionData("getUint", [getFullKey(entry.baseKey, entry.keyData)]),
  }));

  const results = await multicall.callStatic.aggregate3(readParams);
  const configWriteParams: string[] = [];
  let changed = 0;
  let skipped = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const current = BigNumber.from(results[i].returnData);
    if (!current.eq(entry.value)) {
      console.log(`  CHANGE: ${entry.label}: ${current.toString()} -> ${entry.value.toString()}`);
      configWriteParams.push(
        config.interface.encodeFunctionData("setUint", [entry.baseKey, entry.keyData, entry.value])
      );
      changed++;
    } else {
      skipped++;
    }
  }

  console.log(`\nSummary: ${changed} changes, ${skipped} already correct`);

  if (configWriteParams.length === 0) {
    console.log("No changes needed.");
    return;
  }

  if (!write) {
    console.log("\nDry-run only. Re-run with WRITE=true to apply via Config.multicall.");
    return;
  }

  console.log(`\nApplying ${configWriteParams.length} updates via Config.multicall...`);
  const tx = await config.multicall(configWriteParams);
  console.log(`Tx: ${tx.hash}`);
  await tx.wait();
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
