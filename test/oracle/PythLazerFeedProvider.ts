import { expect } from "chai";
import { BigNumber, BigNumberish } from "ethers";
import { ethers } from "hardhat";

import { time } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { decodeData } from "../../utils/hash";
import { expandDecimals } from "../../utils/math";
import { parseError, errorsContract } from "../../utils/error";
import { grantRole } from "../../utils/role";
import * as keys from "../../utils/keys";

const FORMAT_MAGIC = 2479346549;
const CHANNEL_REAL_TIME = 1;
const PROP_PRICE = 0;
const PROP_CONFIDENCE = 5;

// MockPythLazer expects 69 arbitrary bytes + uint16 payload_len + payload
// (contracts/mock/MockPythLazer.sol). The payload format is documented in
// pyth-crosschain/lazer/contracts/evm/src/PythLazerLib.sol:parseUpdateFromPayload.
// We include only Price and Confidence — never BestBidPrice/BestAskPrice.
function encodePythLazerUpdate({
  feedId,
  timestamp,
  price,
  confidence,
}: {
  feedId: number;
  timestamp: BigNumberish;
  price: BigNumberish;
  confidence: BigNumberish;
}): string {
  const payload = ethers.utils.solidityPack(
    [
      "uint32", // magic
      "uint64", // timestamp
      "uint8", // channel
      "uint8", // feedsLen
      "uint32", // feedId
      "uint8", // numProperties
      "uint8", // propId(Price)
      "int64", // price
      "uint8", // propId(Confidence)
      "uint64", // confidence
    ],
    [FORMAT_MAGIC, timestamp, CHANNEL_REAL_TIME, 1, feedId, 2, PROP_PRICE, price, PROP_CONFIDENCE, confidence]
  );

  const payloadLen = ethers.utils.arrayify(payload).length;
  const prefix = "0x" + "00".repeat(69);
  const lenBytes = ethers.utils.solidityPack(["uint16"], [payloadLen]);

  return ethers.utils.hexConcat([prefix, lenBytes, payload]);
}

function decodeValidatedPrice(data: string) {
  try {
    const decoded = decodeData(["address", "uint256", "uint256", "uint256", "address"], data);
    return {
      token: decoded[0] as string,
      min: decoded[1] as BigNumber,
      max: decoded[2] as BigNumber,
      timestamp: decoded[3] as BigNumber,
      provider: decoded[4] as string,
    };
  } catch (ex) {
    throw parseError(data);
  }
}

describe("PythLazerFeedProvider", () => {
  let fixture: Awaited<ReturnType<typeof deployFixture>>;
  let dataStore: any;
  let wnt: any;
  let usdc: any;
  let oracle: any;
  let config: any;
  let roleStore: any;
  let user0: any;
  let pythLazerFeedProvider: any;

  const FEED_ID = 1;
  const TIMESTAMP_MICROS = 1_700_000_000_000_000;
  const FLOAT_PRECISION = expandDecimals(1, 30);

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ dataStore, wnt, usdc, oracle, config, roleStore } = fixture.contracts);
    ({ user0 } = fixture.accounts);
    pythLazerFeedProvider = await ethers.getContract("PythLazerFeedProvider");

    await dataStore.setUint(keys.pythLazerFeedIdKey(wnt.address), FEED_ID);
    await dataStore.setUint(keys.pythLazerFeedMultiplierKey(wnt.address), FLOAT_PRECISION);
    await dataStore.setBool(keys.pythLazerFeedInvertedKey(wnt.address), false);
  });

  async function getOraclePrice({
    price,
    confidence,
    timestamp = TIMESTAMP_MICROS,
    feedId = FEED_ID,
  }: {
    price: BigNumberish;
    confidence: BigNumberish;
    timestamp?: BigNumberish;
    feedId?: number;
  }) {
    const callData = pythLazerFeedProvider.interface.encodeFunctionData("getOraclePrice", [
      wnt.address,
      encodePythLazerUpdate({ feedId, timestamp, price, confidence }),
    ]);
    const result = await ethers.provider.call({
      to: pythLazerFeedProvider.address,
      data: callData,
      from: oracle.address, // getOraclePrice is gated to onlyOracle
    });
    return decodeValidatedPrice(result);
  }

  it("identity spread factor: scaled confidence equals raw confidence", async () => {
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), FLOAT_PRECISION);

    const price = 100_000_000;
    const confidence = 50_000;
    const { min, max } = await getOraclePrice({ price, confidence });

    expect(min).to.eq(price - confidence);
    expect(max).to.eq(price + confidence);
  });

  it("scaled confidence equals confidence times spread factor (2x widen)", async () => {
    // headline assertion: scaledConfidence = confidence * spreadFactor / 1e30
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), FLOAT_PRECISION.mul(2));

    const price = 100_000_000;
    const confidence = 50_000;
    const { min, max } = await getOraclePrice({ price, confidence });

    expect(min).to.eq(price - confidence * 2);
    expect(max).to.eq(price + confidence * 2);
  });

  it("scaled confidence shrinks with sub-identity spread factor (0.5x narrow)", async () => {
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), FLOAT_PRECISION.div(2));

    const price = 100_000_000;
    const confidence = 50_000;
    const { min, max } = await getOraclePrice({ price, confidence });

    expect(min).to.eq(price - confidence / 2);
    expect(max).to.eq(price + confidence / 2);
  });

  it("zero spread factor collapses the band to the price", async () => {
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), 0);

    const price = 100_000_000;
    const confidence = 50_000;
    const { min, max } = await getOraclePrice({ price, confidence });

    expect(min).to.eq(price);
    expect(max).to.eq(price);
  });

  it("reverts when scaled confidence reaches or exceeds the price", async () => {
    // confidence * sf / 1e30 = 50_000 * 3e33 / 1e30 = 150_000_000_000 >= price (100_000_000)
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), FLOAT_PRECISION.mul(3000));

    const callData = pythLazerFeedProvider.interface.encodeFunctionData("getOraclePrice", [
      wnt.address,
      encodePythLazerUpdate({
        feedId: FEED_ID,
        timestamp: TIMESTAMP_MICROS,
        price: 100_000_000,
        confidence: 50_000,
      }),
    ]);
    const raw = await ethers.provider.call({
      to: pythLazerFeedProvider.address,
      data: callData,
      from: oracle.address,
    });
    const err = parseError(raw) as any;
    expect(err.name).to.eq("InvalidPythLazerScaledConfidence");
  });

  it("reverts when getOraclePrice is called by a non-oracle (318 / dup-127)", async () => {
    // getOraclePrice spends the provider's own ETH on the Pyth verification fee, so a permissionless
    // caller could drain it. It must be gated to the Oracle.
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), FLOAT_PRECISION);

    const callData = pythLazerFeedProvider.interface.encodeFunctionData("getOraclePrice", [
      wnt.address,
      encodePythLazerUpdate({ feedId: FEED_ID, timestamp: TIMESTAMP_MICROS, price: 100_000_000, confidence: 50_000 }),
    ]);
    const raw = await ethers.provider.call({
      to: pythLazerFeedProvider.address,
      data: callData,
      from: user0.address, // not the Oracle
    });
    const err = parseError(raw) as any;
    expect(err.name).to.eq("Unauthorized");
  });

  it("setPythLazerFeed writes the keys/types the provider reads (112)", async () => {
    await grantRole(roleStore, user0.address, "CONFIG_KEEPER");

    // use usdc — a token the beforeEach does NOT pre-configure, so the write-once guard doesn't trip
    const token = usdc.address;
    const feedId = 327;
    const multiplier = FLOAT_PRECISION; // identity, so the resolved band is just price ∓ confidence
    const spreadFactor = FLOAT_PRECISION;

    await config.connect(user0).setPythLazerFeed(token, feedId, false, multiplier, spreadFactor);

    // the provider reads these via getUint / getBool — they must be populated
    expect(await dataStore.getUint(keys.pythLazerFeedIdKey(token))).to.eq(feedId);
    expect(await dataStore.getUint(keys.pythLazerFeedMultiplierKey(token))).to.eq(multiplier);
    expect(await dataStore.getBool(keys.pythLazerFeedInvertedKey(token))).to.eq(false);
    expect(await dataStore.getUint(keys.pythLazerFeedSpreadFactorKey(token))).to.eq(spreadFactor);

    // and it must NOT write the wrong dataStream* key the buggy version used
    expect(await dataStore.getBytes32(keys.dataStreamIdKey(token))).to.eq(ethers.constants.HashZero);

    // end-to-end: a price pulled through the Oracle now resolves against the configured feed
    const callData = pythLazerFeedProvider.interface.encodeFunctionData("getOraclePrice", [
      token,
      encodePythLazerUpdate({ feedId, timestamp: TIMESTAMP_MICROS, price: 100_000_000, confidence: 50_000 }),
    ]);
    const result = await ethers.provider.call({
      to: pythLazerFeedProvider.address,
      data: callData,
      from: oracle.address,
    });
    const { min, max } = decodeValidatedPrice(result);
    const expectedMin = BigNumber.from(100_000_000 - 50_000).mul(multiplier).div(FLOAT_PRECISION);
    const expectedMax = BigNumber.from(100_000_000 + 50_000).mul(multiplier).div(FLOAT_PRECISION);
    expect(min).to.eq(expectedMin);
    expect(max).to.eq(expectedMax);
  });

  it("setPythLazerFeed / setDataStream enforce one feed config per token (CursorBot guard)", async () => {
    await grantRole(roleStore, user0.address, "CONFIG_KEEPER");

    const token = usdc.address;
    await config.connect(user0).setPythLazerFeed(token, 327, false, FLOAT_PRECISION, FLOAT_PRECISION);

    // a second pyth-lazer config must not silently overwrite
    await expect(
      config.connect(user0).setPythLazerFeed(token, 333, false, FLOAT_PRECISION, FLOAT_PRECISION)
    ).to.be.revertedWithCustomError(errorsContract, "PythLazerFeedIdAlreadyExistsForToken");

    // and a data-stream feed must not be added on top of a pyth-lazer feed
    await expect(
      config.connect(user0).setDataStream(token, ethers.utils.formatBytes32String("feed"), false, FLOAT_PRECISION, 0)
    ).to.be.revertedWithCustomError(errorsContract, "PythLazerFeedIdAlreadyExistsForToken");
  });

  it("applies feed multiplier (the hardcoded exponent config) after confidence scaling", async () => {
    // raw feed values are 8dp; multiplier 1e22 normalizes to 30dp.
    // expected min = (price - confidence) * 1e22 / 1e30
    //          max = (price + confidence) * 1e22 / 1e30
    const multiplier = expandDecimals(1, 22);
    await dataStore.setUint(keys.pythLazerFeedMultiplierKey(wnt.address), multiplier);
    await dataStore.setUint(keys.pythLazerFeedSpreadFactorKey(wnt.address), FLOAT_PRECISION);

    const price = 100_000_000;
    const confidence = 50_000;
    const { min, max } = await getOraclePrice({ price, confidence });

    const expectedMin = BigNumber.from(price - confidence)
      .mul(multiplier)
      .div(FLOAT_PRECISION);
    const expectedMax = BigNumber.from(price + confidence)
      .mul(multiplier)
      .div(FLOAT_PRECISION);
    expect(min).to.eq(expectedMin);
    expect(max).to.eq(expectedMax);
  });
});
