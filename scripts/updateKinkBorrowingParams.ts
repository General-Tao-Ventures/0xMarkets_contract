import { ethers, network } from "hardhat";
import { BigNumber } from "ethers";

/**
 * Enable / align the kink borrow model on all listed markets.
 *
 * Why: the legacy curve `borrowingFactor * reserved^exponent / poolUsd` is
 * NOT scale-invariant (same util, different pool ⇒ different rate) when
 * borrowingExponentFactor != 1. With optimalUsageFactor != 0,
 * MarketUtils.getKinkBorrowingFactor uses utilization
 * (reserved / (pool * openInterestReserveFactor)). Skew remains via
 * SKIP_BORROWING_FEE_FOR_SMALLER_SIDE.
 *
 * Note: Base mainnet already has kink enabled (as of 2026-08); this script
 * reconciles rates to borrowingRateConfig_LowMax_WithLowerBase. Base Sepolia
 * still has optimalUsageFactor=0 (curve model) and needs this to switch.
 *
 * Dry-run by default. Apply with:
 *   WRITE=true npx hardhat run scripts/updateKinkBorrowingParams.ts --network base
 *   WRITE=true npx hardhat run scripts/updateKinkBorrowingParams.ts --network baseSepolia
 */

const SECONDS_PER_YEAR = 31536000;

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
  BASE_BORROWING_FACTOR: hashString("BASE_BORROWING_FACTOR"),
  OPTIMAL_USAGE_FACTOR: hashString("OPTIMAL_USAGE_FACTOR"),
  ABOVE_OPTIMAL_USAGE_BORROWING_FACTOR: hashString("ABOVE_OPTIMAL_USAGE_BORROWING_FACTOR"),
  SKIP_BORROWING_FEE_FOR_SMALLER_SIDE: hashString("SKIP_BORROWING_FEE_FOR_SMALLER_SIDE"),
};

// Matches borrowingRateConfig_LowMax_WithLowerBase in config/markets.ts
// (~10x prior mainnet kink: ~6%/yr base, ~15%/yr above)
const TARGETS = {
  optimalUsageFactor: expandDecimals(75, 28), // 75%
  baseBorrowingFactor: expandDecimals(60, 28).div(SECONDS_PER_YEAR), // 60%/yr
  aboveOptimalUsageBorrowingFactor: expandDecimals(150, 28).div(SECONDS_PER_YEAR), // 150%/yr
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
  type: "uint" | "bool";
  baseKey: string;
  keyData: string;
  value: BigNumber | boolean;
  label: string;
}

function buildEntries(markets: Record<string, string>): ConfigEntry[] {
  const entries: ConfigEntry[] = [
    {
      type: "bool",
      baseKey: KEYS.SKIP_BORROWING_FEE_FOR_SMALLER_SIDE,
      keyData: "0x",
      value: true,
      label: "skipBorrowingFeeForSmallerSide (global)",
    },
  ];

  for (const [name, marketToken] of Object.entries(markets)) {
    for (const isLong of [true, false]) {
      const side = isLong ? "Long" : "Short";
      const keyData = encodeData(["address", "bool"], [marketToken, isLong]);

      entries.push({
        type: "uint",
        baseKey: KEYS.OPTIMAL_USAGE_FACTOR,
        keyData,
        value: TARGETS.optimalUsageFactor,
        label: `optimalUsageFactor${side} ${name}`,
      });
      entries.push({
        type: "uint",
        baseKey: KEYS.BASE_BORROWING_FACTOR,
        keyData,
        value: TARGETS.baseBorrowingFactor,
        label: `baseBorrowingFactor${side} ${name}`,
      });
      entries.push({
        type: "uint",
        baseKey: KEYS.ABOVE_OPTIMAL_USAGE_BORROWING_FACTOR,
        keyData,
        value: TARGETS.aboveOptimalUsageBorrowingFactor,
        label: `aboveOptimalUsageBorrowingFactor${side} ${name}`,
      });
    }
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

  console.log(`Network: ${networkName}`);
  console.log(`DataStore: ${cfg.dataStore}`);
  console.log(`Config:    ${cfg.config}`);
  console.log(`WRITE:     ${write}`);
  console.log("\n── Targets (kink borrow) ──");
  console.log(`  optimalUsageFactor:              75%`);
  console.log(`  baseBorrowingFactor:             60%/yr`);
  console.log(`  aboveOptimalUsageBorrowingFactor: 150%/yr`);
  console.log(`  skipBorrowingFeeForSmallerSide:  true`);

  const dataStore = await ethers.getContractAt("DataStore", cfg.dataStore);
  const config = await ethers.getContractAt("Config", cfg.config);
  const multicall = await ethers.getContractAt("Multicall3", cfg.multicall);

  const entries = buildEntries(cfg.markets);
  console.log(`\nChecking ${entries.length} keys across ${Object.keys(cfg.markets).length} markets...`);

  const readParams = entries.map((entry) => {
    const fullKey = getFullKey(entry.baseKey, entry.keyData);
    const method = entry.type === "bool" ? "getBool" : "getUint";
    return {
      target: cfg.dataStore,
      allowFailure: false,
      callData: dataStore.interface.encodeFunctionData(method, [fullKey]),
    };
  });

  const results = await multicall.callStatic.aggregate3(readParams);

  const configWriteParams: string[] = [];
  let changed = 0;
  let skipped = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const returnData = results[i].returnData;

    if (entry.type === "bool") {
      const current = ethers.utils.defaultAbiCoder.decode(["bool"], returnData)[0] as boolean;
      if (current !== entry.value) {
        console.log(`  CHANGE: ${entry.label}: ${current} -> ${entry.value}`);
        configWriteParams.push(
          config.interface.encodeFunctionData("setBool", [entry.baseKey, entry.keyData, entry.value])
        );
        changed++;
      } else {
        skipped++;
      }
    } else {
      const current = BigNumber.from(returnData);
      const target = entry.value as BigNumber;
      if (!current.eq(target)) {
        console.log(`  CHANGE: ${entry.label}: ${current.toString()} -> ${target.toString()}`);
        configWriteParams.push(config.interface.encodeFunctionData("setUint", [entry.baseKey, entry.keyData, target]));
        changed++;
      } else {
        skipped++;
      }
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
