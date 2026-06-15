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
  let pythLazerFeedProvider: any;

  const FEED_ID = 1;
  const TIMESTAMP_MICROS = 1_700_000_000_000_000;
  const FLOAT_PRECISION = expandDecimals(1, 30);

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ dataStore, wnt } = fixture.contracts);
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
    });
    const err = parseError(raw) as any;
    expect(err.name).to.eq("InvalidPythLazerScaledConfidence");
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

// ZEROMARK-112 (dup-33): the on-chain Pyth Lazer config setters (Config + Timelock) must write
// the exact DataStore slots AND value-types that PythLazerFeedProvider reads. The provider reads
// the feed id with getUint(pythLazerFeedIdKey). Before the fix:
//   - Config wrote id/inverted/multiplier to the Chainlink dataStream* keys (wrong slot), and
//   - Timelock wrote the id to the right key but via setBytes32 (wrong type-map: getUint saw 0).
// Both made the provider revert EmptyPythLazerFeedId. The existing tests above set the keys
// directly via DataStore, so they never exercised the setters — which is why both bugs shipped.
describe("PythLazerFeed config wiring (ZEROMARK-112)", () => {
  let fixture: Awaited<ReturnType<typeof deployFixture>>;
  let config: any, timelock: any, dataStore: any, roleStore: any, wnt: any;
  let pythLazerFeedProvider: any, oracle: any;
  let configKeeper: any, timelockAdmin: any;

  const FEED_ID = 1;
  const TIMESTAMP_MICROS = 1_700_000_000_000_000;
  const FLOAT_PRECISION = expandDecimals(1, 30);
  const PRICE = 100_000_000;
  const CONFIDENCE = 50_000;
  // Timelock delay is 1 day; add a small buffer so the action is executable.
  const TIMELOCK_DELAY = 1 * 24 * 60 * 60 + 10;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ config, timelock, dataStore, roleStore, wnt } = fixture.contracts);
    ({ user0: configKeeper, user1: timelockAdmin } = fixture.accounts);
    pythLazerFeedProvider = await ethers.getContract("PythLazerFeedProvider");
    oracle = await ethers.getContract("Oracle");

    await grantRole(roleStore, configKeeper.address, "CONFIG_KEEPER");
    await grantRole(roleStore, timelockAdmin.address, "TIMELOCK_ADMIN");
  });

  // Price wnt through the provider's real read path. Reverts EmptyPythLazerFeedId /
  // EmptyPythLazerFeedMultiplier if the config didn't land in the slots/types it reads.
  // Called as the Oracle so the onlyOracle guard (ZEROMARK-127) is satisfied if present.
  async function getOraclePrice() {
    const callData = pythLazerFeedProvider.interface.encodeFunctionData("getOraclePrice", [
      wnt.address,
      encodePythLazerUpdate({ feedId: FEED_ID, timestamp: TIMESTAMP_MICROS, price: PRICE, confidence: CONFIDENCE }),
    ]);
    const result = await ethers.provider.call({
      to: pythLazerFeedProvider.address,
      data: callData,
      from: oracle.address,
    });
    return decodeValidatedPrice(result);
  }

  it("Config.setPythLazerFeed writes the slots the provider reads, and the provider can price the token", async () => {
    await config.connect(configKeeper).setPythLazerFeed(wnt.address, FEED_ID, false, FLOAT_PRECISION, FLOAT_PRECISION);

    // landed in the pythLazerFeed* slots (what the provider reads), as uint
    expect(await dataStore.getUint(keys.pythLazerFeedIdKey(wnt.address))).to.eq(FEED_ID);
    expect(await dataStore.getUint(keys.pythLazerFeedMultiplierKey(wnt.address))).to.eq(FLOAT_PRECISION);
    expect(await dataStore.getBool(keys.pythLazerFeedInvertedKey(wnt.address))).to.eq(false);
    expect(await dataStore.getUint(keys.pythLazerFeedSpreadFactorKey(wnt.address))).to.eq(FLOAT_PRECISION);

    // and did NOT pollute the Chainlink Data Stream slots (the pre-fix behaviour)
    expect(await dataStore.getBytes32(keys.dataStreamIdKey(wnt.address))).to.eq(ethers.constants.HashZero);

    // round-trip: the provider now reads a real feed id and prices the token
    const { min, max } = await getOraclePrice();
    expect(min).to.eq(PRICE - CONFIDENCE);
    expect(max).to.eq(PRICE + CONFIDENCE);
  });

  it("Timelock signal/afterSignal stores the feed id as uint (not bytes32), and the provider can price the token", async () => {
    await timelock
      .connect(timelockAdmin)
      .signalSetPythLazerFeed(wnt.address, FEED_ID, false, FLOAT_PRECISION, FLOAT_PRECISION);
    await time.increase(TIMELOCK_DELAY);
    await timelock
      .connect(timelockAdmin)
      .setPythLazerFeedAfterSignal(wnt.address, FEED_ID, false, FLOAT_PRECISION, FLOAT_PRECISION);

    // stored in the uint type-map (what the provider reads via getUint), not the bytes32 type-map
    expect(await dataStore.getUint(keys.pythLazerFeedIdKey(wnt.address))).to.eq(FEED_ID);
    expect(await dataStore.getBytes32(keys.pythLazerFeedIdKey(wnt.address))).to.eq(ethers.constants.HashZero);

    const { min, max } = await getOraclePrice();
    expect(min).to.eq(PRICE - CONFIDENCE);
    expect(max).to.eq(PRICE + CONFIDENCE);
  });

  it("Config duplicate guard blocks re-registering a Pyth Lazer feed for the same token", async () => {
    await config.connect(configKeeper).setPythLazerFeed(wnt.address, FEED_ID, false, FLOAT_PRECISION, FLOAT_PRECISION);
    await expect(
      config.connect(configKeeper).setPythLazerFeed(wnt.address, FEED_ID + 1, false, FLOAT_PRECISION, FLOAT_PRECISION)
    ).to.be.revertedWithCustomError(errorsContract, "PythLazerFeedIdAlreadyExistsForToken");
  });
});
