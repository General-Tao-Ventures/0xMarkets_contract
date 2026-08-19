import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getAccountPositionCount } from "../../utils/position";
import { deployContract } from "../../utils/deploy";
import { executeLiquidation } from "../../utils/liquidation";

describe("Guardian.Callback", () => {
  let fixture;
  let user0;
  let dataStore, ethUsdMarket, solUsdMarket, wnt, usdc, exchangeRouter;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0 } = fixture.accounts);
    ({ dataStore, ethUsdMarket, solUsdMarket, wnt, usdc, exchangeRouter } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(5_000_000, 6),
      },
    });

    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
  });

  it("setSavedCallback test", async () => {
    const mockCallbackReceiver = await deployContract("MockCallbackReceiver", []);

    // Create a position
    // Normal Market - Long 200K
    // user0 opens a $200k long position, using usdc as collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25_000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Save a callback contract
    await exchangeRouter
      .connect(user0)
      .setSavedCallbackContract(ethUsdMarket.marketToken, mockCallbackReceiver.address);

    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(1);

    // Under requiredCollateralUsd = collateralUsd * mmr, only PnL losses trip liq.
    // $25k USDC collateral, 40 ETH long: required = $25k * 1% = $250. Liquidates
    // when remaining < $250, i.e., loss > $24,750. Mark = $5000 - $24,750/40 = $4381.
    // Use $4380 for safety margin against fees.

    // Get liquidated
    await executeLiquidation(fixture, {
      account: user0.address,
      market: ethUsdMarket,
      collateralToken: usdc,
      isLong: true,
      minPrices: [expandDecimals(4380, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(4380, 4), expandDecimals(1, 6)],
    });

    // The saved callback must NOT fire on a forced liquidation: the liquidation order is now built with
    // no callback (address(0)), so a trader cannot force unpaid callback gas onto the keeper during their
    // own liquidation. (Previously this asserted eq(1) — the saved callback ran with MAX gas for free.)
    expect(await mockCallbackReceiver.called()).to.eq(0);

    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(0);

    // Create another position in the same market, this time short
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25_000, 6),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(4950, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(1);

    // Short side: $25k collateral, 40 ETH short at $5000. Loss > $24,750 needs
    // mark > $5000 + $24,750/40 = $5618.75. Use $5620 for safety margin.

    // Get liquidated
    await executeLiquidation(fixture, {
      account: user0.address,
      market: ethUsdMarket,
      collateralToken: usdc,
      isLong: false,
      minPrices: [expandDecimals(5620, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5620, 4), expandDecimals(1, 6)],
    });

    // Still not called after the second forced liquidation — saved callbacks never run on liquidation.
    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(0);
    expect(await mockCallbackReceiver.called()).to.eq(0);
  });
});
