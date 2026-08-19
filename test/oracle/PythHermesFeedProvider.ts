import { expect } from "chai";
import { BigNumber, BigNumberish } from "ethers";
import { ethers } from "hardhat";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals } from "../../utils/math";
import { errorsContract } from "../../utils/error";
import * as keys from "../../utils/keys";

// PythHermesFeedProvider decodes (uint256 price, uint256 conf, int32 expo, uint256 publishTime)
function encodeHermes({
  price,
  conf,
  expo,
  publishTime,
}: {
  price: BigNumberish;
  conf: BigNumberish;
  expo: number;
  publishTime: BigNumberish;
}): string {
  return ethers.utils.defaultAbiCoder.encode(
    ["uint256", "uint256", "int32", "uint256"],
    [price, conf, expo, publishTime]
  );
}

describe("PythHermesFeedProvider", () => {
  let fixture;
  let dataStore, wnt, usdc;
  let pythHermesFeedProvider;

  // GMX convention: storedPrice == realPrice * 10^(30 - tokenDecimals).
  // The per-token Hermes multiplier captures exactly that token-decimals correction.
  const WNT_DECIMALS = 18;
  const USDC_DECIMALS = 6;
  const wntMultiplier = expandDecimals(1, 30 - WNT_DECIMALS); // 1e12
  const usdcMultiplier = expandDecimals(1, 30 - USDC_DECIMALS); // 1e24

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ dataStore, wnt, usdc } = fixture.contracts);
    pythHermesFeedProvider = await ethers.getContract("PythHermesFeedProvider");
  });

  it("reverts when no per-token multiplier is configured (fail-closed)", async () => {
    const data = encodeHermes({ price: expandDecimals(3000, 8), conf: 0, expo: -8, publishTime: 1000 });
    await expect(pythHermesFeedProvider.getOraclePrice(wnt.address, data))
      .to.be.revertedWithCustomError(errorsContract, "EmptyPythHermesFeedMultiplier")
      .withArgs(wnt.address);
  });

  it("scales an 18-decimal token to realPrice * 10^(30 - decimals)", async () => {
    await dataStore.setUint(keys.pythHermesFeedMultiplierKey(wnt.address), wntMultiplier);

    // WETH at $3000, Pyth expo -8 (price carries 8 decimals)
    const data = encodeHermes({ price: expandDecimals(3000, 8), conf: 0, expo: -8, publishTime: 1234 });
    const p = await pythHermesFeedProvider.getOraclePrice(wnt.address, data);

    // realPrice 3000 -> 3000 * 10^(30-18) = 3e15  (NOT 3e33, which would be 10^18 too large)
    const expected = expandDecimals(3000, 12);
    expect(p.min).to.eq(expected);
    expect(p.max).to.eq(expected);
    expect(p.timestamp).to.eq(1234);
    expect(p.provider).to.eq(pythHermesFeedProvider.address);
  });

  it("scales a 6-decimal token to realPrice * 10^(30 - decimals)", async () => {
    await dataStore.setUint(keys.pythHermesFeedMultiplierKey(usdc.address), usdcMultiplier);

    // USDC at $1, Pyth expo -8
    const data = encodeHermes({ price: expandDecimals(1, 8), conf: 0, expo: -8, publishTime: 1 });
    const p = await pythHermesFeedProvider.getOraclePrice(usdc.address, data);

    // realPrice 1 -> 1 * 10^(30-6) = 1e24
    expect(p.min).to.eq(expandDecimals(1, 24));
    expect(p.max).to.eq(expandDecimals(1, 24));
  });

  it("applies the confidence band symmetrically", async () => {
    await dataStore.setUint(keys.pythHermesFeedMultiplierKey(wnt.address), wntMultiplier);

    const price = expandDecimals(3000, 8);
    const conf = expandDecimals(5, 8); // +/- $5
    const data = encodeHermes({ price, conf, expo: -8, publishTime: 1 });
    const p = await pythHermesFeedProvider.getOraclePrice(wnt.address, data);

    expect(p.min).to.eq(expandDecimals(2995, 12));
    expect(p.max).to.eq(expandDecimals(3005, 12));
    expect(p.min).to.lt(p.max);
  });

  it("handles a non-negative exponent", async () => {
    await dataStore.setUint(keys.pythHermesFeedMultiplierKey(wnt.address), wntMultiplier);

    // realPrice = 3000 with expo 0 -> price is the integer 3000
    const data = encodeHermes({ price: 3000, conf: 0, expo: 0, publishTime: 1 });
    const p = await pythHermesFeedProvider.getOraclePrice(wnt.address, data);
    expect(p.min).to.eq(expandDecimals(3000, 12));
  });
});
