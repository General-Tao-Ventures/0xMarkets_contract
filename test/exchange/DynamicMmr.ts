import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { decimalToFloat, expandDecimals, percentageToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getPositionKey } from "../../utils/position";
import * as keys from "../../utils/keys";

describe("DynamicMmr", () => {
  let fixture;
  let user0;
  let reader, referralStorage, dataStore, ethUsdMarket, wnt, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0 } = fixture.accounts);
    ({ reader, referralStorage, dataStore, ethUsdMarket, wnt, usdc } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(5_000_000, 6),
      },
    });
  });

  describe("isPositionLiquidatable reason codes", () => {
    it("returns 'mmr breach' when collateral is positive but below required", async () => {
      // Required collateral now multiplies the position's collateralUsd, not the notional
      // (Erkin's spec correction: mmr * IMR, not mmr * sizeInUsd). Set the floors so that
      // the dynamic curve gets clamped to a known mmr and the floor governs.
      await dataStore.setUint(keys.minMmrKey(ethUsdMarket.marketToken), percentageToFloat("15%"));
      await dataStore.setUint(keys.maxMmrKey(ethUsdMarket.marketToken), percentageToFloat("20%"));

      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: decimalToFloat(200 * 1000),
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: {
          tokens: [wnt.address, usdc.address],
        },
      });

      const positionKey = getPositionKey(user0.address, ethUsdMarket.marketToken, wnt.address, true);

      // At mark $4100: collateralUsd (10 WETH @ $4100) = $41k, PnL = 40 * (4100-5000) = -$36k
      //   → remaining ≈ $5k.
      // Required = collateralUsd * mmr = $41k * 15% = $6.15k → remaining < required → mmr breach
      const pricesMmrBreach = {
        indexTokenPrice: { min: expandDecimals(4100, 12), max: expandDecimals(4100, 12) },
        longTokenPrice: { min: expandDecimals(4100, 12), max: expandDecimals(4100, 12) },
        shortTokenPrice: { min: expandDecimals(1, 24), max: expandDecimals(1, 24) },
      };

      const [isLiquidatable, reason, info] = await reader.isPositionLiquidatable(
        dataStore.address,
        referralStorage.address,
        positionKey,
        ethUsdMarket,
        pricesMmrBreach,
        false
      );

      expect(isLiquidatable).to.eq(true);
      expect(reason).to.eq("mmr breach");
      expect(info.mmr).to.eq(percentageToFloat("15%"));
      // requiredCollateralUsd = collateralUsd * 15%. collateralUsd ≈ 10 WETH * $4100 = $41k
      // minus the small WETH fee deduction on open, so required lands just under $6,150.
      expect(info.requiredCollateralUsd).to.be.gt(decimalToFloat(6000));
      expect(info.requiredCollateralUsd).to.be.lt(decimalToFloat(6200));
      expect(info.remainingCollateralUsd).to.be.gt(0);
      expect(info.remainingCollateralUsd).to.be.lt(info.requiredCollateralUsd);
    });

    it("returns 'insolvent' when remaining collateral falls below zero", async () => {
      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: decimalToFloat(200 * 1000),
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: {
          tokens: [wnt.address, usdc.address],
        },
      });

      const positionKey = getPositionKey(user0.address, ethUsdMarket.marketToken, wnt.address, true);

      // At $3000 the position's collateral (10 WETH = $30k) + PnL (-$80k) is deeply
      // negative → "insolvent".
      const pricesInsolvent = {
        indexTokenPrice: { min: expandDecimals(3000, 12), max: expandDecimals(3000, 12) },
        longTokenPrice: { min: expandDecimals(3000, 12), max: expandDecimals(3000, 12) },
        shortTokenPrice: { min: expandDecimals(1, 24), max: expandDecimals(1, 24) },
      };

      const [isLiquidatable, reason, info] = await reader.isPositionLiquidatable(
        dataStore.address,
        referralStorage.address,
        positionKey,
        ethUsdMarket,
        pricesInsolvent,
        false
      );

      expect(isLiquidatable).to.eq(true);
      expect(reason).to.eq("insolvent");
      expect(info.remainingCollateralUsd).to.be.lt(0);
    });
  });

  describe("willPositionCollateralBeSufficient (leverage band enforcement)", () => {
    it("rejects increases above max_leverage with InsufficientCollateralUsd", async () => {
      // Tighten max_leverage to 5x so that a 10x position fails the upper bound.
      await dataStore.setUint(keys.maxLeverageKey(ethUsdMarket.marketToken), decimalToFloat(5));

      // 10 WETH collateral ($50k at entry $5k) + $500k size → 10x leverage.
      // Upper bound requires collateral >= sizeInUsd / 5 = $100k → fails.
      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: decimalToFloat(500 * 1000),
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: {
          tokens: [wnt.address, usdc.address],
          expectedCancellationReason: "InsufficientCollateralUsd",
        },
      });
    });
  });

  describe("validatePosition (min_leverage gate)", () => {
    it("rejects increases below min_leverage with InvalidLeverage", async () => {
      // Require at least 10x leverage on this market.
      await dataStore.setUint(keys.minLeverageKey(ethUsdMarket.marketToken), decimalToFloat(10));

      // 10 WETH collateral ($50k at entry $5k) + $50k size → 1x leverage → below the
      // market's 10x floor. validatePosition should revert with InvalidLeverage.
      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: decimalToFloat(50 * 1000),
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: {
          tokens: [wnt.address, usdc.address],
          expectedCancellationReason: "InvalidLeverage",
        },
      });
    });

    it("allows a partial decrease that drops leverage below min_leverage", async () => {
      await dataStore.setUint(keys.minLeverageKey(ethUsdMarket.marketToken), decimalToFloat(10));

      // open at the 10x floor: 10 WETH ($50k) collateral, $500k size
      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: decimalToFloat(500 * 1000),
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: { tokens: [wnt.address, usdc.address] },
      });

      const posKey = getPositionKey(user0.address, ethUsdMarket.marketToken, wnt.address, true);

      // decrease $450k → ~$50k size against ~$50k collateral = ~1x, below the 10x floor.
      // must execute (not cancel with InvalidLeverage) — de-risking is always allowed.
      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: 0,
          sizeDeltaUsd: decimalToFloat(450 * 1000),
          acceptablePrice: expandDecimals(4999, 12),
          orderType: OrderType.MarketDecrease,
          isLong: true,
        },
        execute: { tokens: [wnt.address, usdc.address] },
      });

      expect((await reader.getPosition(dataStore.address, posKey)).numbers.sizeInUsd).to.eq(decimalToFloat(50 * 1000));
    });

    it("allows a collateral-only top-up that drops leverage below min_leverage", async () => {
      await dataStore.setUint(keys.minLeverageKey(ethUsdMarket.marketToken), decimalToFloat(10));

      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: decimalToFloat(500 * 1000),
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: { tokens: [wnt.address, usdc.address] },
      });

      const posKey = getPositionKey(user0.address, ethUsdMarket.marketToken, wnt.address, true);
      const collateralBefore = (await reader.getPosition(dataStore.address, posKey)).numbers.collateralAmount;

      // add 10 WETH collateral, no size change → leverage halves to ~5x, below the 10x floor.
      // must execute — adding collateral strictly reduces risk.
      await handleOrder(fixture, {
        create: {
          market: ethUsdMarket,
          initialCollateralToken: wnt,
          initialCollateralDeltaAmount: expandDecimals(10, 18),
          sizeDeltaUsd: 0,
          acceptablePrice: expandDecimals(5001, 12),
          orderType: OrderType.MarketIncrease,
          isLong: true,
        },
        execute: { tokens: [wnt.address, usdc.address] },
      });

      expect((await reader.getPosition(dataStore.address, posKey)).numbers.collateralAmount).to.eq(
        collateralBefore.add(expandDecimals(10, 18))
      );
    });
  });
});
