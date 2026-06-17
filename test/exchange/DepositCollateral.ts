import { expect } from "chai";

import { usingResult } from "../../utils/use";
import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getPositionKeys } from "../../utils/position";
import { getExecuteParams } from "../../utils/exchange";
import { getEventData } from "../../utils/event";
import { prices } from "../../utils/prices";
import * as keys from "../../utils/keys";

describe("Exchange.DepositCollateral", () => {
  let fixture;
  let user0;
  let reader, dataStore, referralStorage, ethUsdMarket, wnt;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0 } = fixture.accounts);
    ({ reader, dataStore, referralStorage, ethUsdMarket, wnt } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000 * 1000, 6),
      },
    });
  });

  it("deposits collateral", async () => {
    const params = {
      account: user0,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(0),
      acceptablePrice: expandDecimals(5001, 12),
      executionFee: expandDecimals(1, 15),
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: { ...params, sizeDeltaUsd: decimalToFloat(0) },
      execute: {
        ...getExecuteParams(fixture, { prices: [prices.usdc, prices.wnt.withSpread] }),
        gasUsageLabel: "executeOrder",
        expectedCancellationReason: "InvalidPositionSizeValues",
      },
    });

    await handleOrder(fixture, {
      create: { ...params, sizeDeltaUsd: decimalToFloat(200_000), acceptablePrice: expandDecimals(5020, 12) },
      execute: {
        ...getExecuteParams(fixture, { prices: [prices.usdc, prices.wnt.withSpread] }),
        gasUsageLabel: "executeOrder",
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq(expandDecimals(5010, 12));
          expect(positionIncreaseEvent.priceImpactUsd).eq("0");
        },
      },
    });

    const positionKeys = await getPositionKeys(dataStore, 0, 10);
    await usingResult(
      reader.getPositionInfo(
        dataStore.address,
        referralStorage.address,
        positionKeys[0],
        prices.ethUsdMarket,
        0, // sizeDeltaUsd
        ethers.constants.AddressZero,
        true // usePositionSizeAsSizeDeltaUsd
      ),
      (positionInfo) => {
        expect(positionInfo.position.numbers.sizeInUsd).eq(decimalToFloat(200_000));
        expect(positionInfo.position.numbers.collateralAmount).eq(expandDecimals(10, 18));
      }
    );

    await handleOrder(fixture, {
      create: { ...params, sizeDeltaUsd: decimalToFloat(0) },
      execute: {
        ...getExecuteParams(fixture, { prices: [prices.usdc, prices.wnt.withSpread] }),
        gasUsageLabel: "executeOrder",
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq(expandDecimals(5010, 12));
          expect(positionIncreaseEvent.priceImpactUsd).eq("0");
        },
      },
    });

    await usingResult(
      reader.getPositionInfo(
        dataStore.address,
        referralStorage.address,
        positionKeys[0],
        prices.ethUsdMarket,
        0, // sizeDeltaUsd
        ethers.constants.AddressZero,
        true // usePositionSizeAsSizeDeltaUsd
      ),
      (positionInfo) => {
        expect(positionInfo.position.numbers.sizeInUsd).eq(decimalToFloat(200_000));
        expect(positionInfo.position.numbers.collateralAmount).eq(expandDecimals(20, 18));
      }
    );
  });

  // ZEROMARK-182: a zero-size MarketIncrease must still enforce the collateral / max-leverage floor.
  // Previously the floor check was gated on sizeDeltaUsd > 0, so a dust zero-size increase could
  // crystallize fees and leave a position above max leverage without ever reverting.
  it("zero-size increase enforces the collateral / max-leverage floor (ZEROMARK-182)", async () => {
    const params = {
      account: user0,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(0),
      acceptablePrice: expandDecimals(5020, 12),
      executionFee: expandDecimals(1, 15),
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    // Open a ~4x long: $200k size on 10 WETH (~$50k) collateral, under a generous 10x cap.
    await dataStore.setUint(keys.maxLeverageKey(ethUsdMarket.marketToken), decimalToFloat(10));
    await handleOrder(fixture, {
      create: { ...params, sizeDeltaUsd: decimalToFloat(200_000) },
      execute: getExecuteParams(fixture, { prices: [prices.usdc, prices.wnt.withSpread] }),
    });

    // Tighten the cap below the position's ~4x; the floor is now $200k / 2x = $100k > ~$50k collateral.
    await dataStore.setUint(keys.maxLeverageKey(ethUsdMarket.marketToken), decimalToFloat(2));

    // A zero-size increase with dust collateral must now be rejected, not silently accepted.
    await handleOrder(fixture, {
      create: { ...params, initialCollateralDeltaAmount: expandDecimals(1, 12), sizeDeltaUsd: decimalToFloat(0) },
      execute: {
        ...getExecuteParams(fixture, { prices: [prices.usdc, prices.wnt.withSpread] }),
        expectedCancellationReason: "InsufficientCollateralUsd",
      },
    });
  });
});
