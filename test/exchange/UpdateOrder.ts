import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat, FLOAT_PRECISION } from "../../utils/math";
import { printGasUsage } from "../../utils/gas";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, getAutoCancelOrderKeys, createOrder } from "../../utils/order";
import { errorsContract } from "../../utils/error";
import { getPositionKey } from "../../utils/position";
import * as keys from "../../utils/keys";

describe("Exchange.UpdateOrder", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1;
  let reader, dataStore, exchangeRouter, orderHandler, orderVault, ethUsdMarket, wnt;
  let executionFee;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1 } = fixture.accounts);
    ({ reader, dataStore, exchangeRouter, orderHandler, orderVault, ethUsdMarket, wnt } = fixture.contracts);
    ({ executionFee } = fixture.props);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
    });
  });

  it("updateOrder validations", async () => {
    expect(await getOrderCount(dataStore)).eq(0);
    const params = {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: decimalToFloat(200 * 1000),
      triggerPrice: expandDecimals(5000, 12),
      acceptablePrice: expandDecimals(5001, 12),
      executionFee,
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, params);

    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    const _updateOrderFeatureDisabledKey = keys.updateOrderFeatureDisabledKey(
      orderHandler.address,
      OrderType.MarketIncrease
    );

    await dataStore.setBool(_updateOrderFeatureDisabledKey, true);

    const validFromTime = 100;

    await expect(
      exchangeRouter.connect(user1).updateOrder(
        orderKeys[0],
        decimalToFloat(250 * 1000),
        expandDecimals(4950, 12),
        expandDecimals(5050, 12),
        expandDecimals(52000, 6),
        validFromTime,
        false // autoCancel
      )
    )
      .to.be.revertedWithCustomError(errorsContract, "Unauthorized")
      .withArgs(user1.address, "updateOrder");

    await expect(
      exchangeRouter.connect(user0).updateOrder(
        orderKeys[0],
        decimalToFloat(250 * 1000),
        expandDecimals(4950, 12),
        expandDecimals(5050, 12),
        expandDecimals(52000, 6),
        validFromTime,
        false // autoCancel
      )
    )
      .to.be.revertedWithCustomError(errorsContract, "DisabledFeature")
      .withArgs(_updateOrderFeatureDisabledKey);

    await dataStore.setBool(_updateOrderFeatureDisabledKey, false);

    await expect(
      exchangeRouter.connect(user0).updateOrder(
        orderKeys[0],
        decimalToFloat(250 * 1000),
        expandDecimals(4950, 12),
        expandDecimals(5050, 12),
        expandDecimals(52000, 6),
        validFromTime,
        false // autoCancel
      )
    )
      .to.be.revertedWithCustomError(errorsContract, "OrderNotUpdatable")
      .withArgs(OrderType.MarketIncrease);
  });

  it("updateOrder", async () => {
    expect(await getOrderCount(dataStore)).eq(0);
    const params = {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: decimalToFloat(200 * 1000),
      triggerPrice: expandDecimals(5000, 12),
      acceptablePrice: expandDecimals(5001, 12),
      executionFee,
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.StopLossDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, params);

    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    let order = await reader.getOrder(dataStore.address, orderKeys[0]);

    expect(order.addresses.account).eq(user0.address);
    expect(order.addresses.market).eq(ethUsdMarket.marketToken);
    expect(order.addresses.initialCollateralToken).eq(wnt.address);
    expect(order.addresses.swapPath).eql([ethUsdMarket.marketToken]);
    expect(order.numbers.orderType).eq(OrderType.StopLossDecrease);
    expect(order.numbers.sizeDeltaUsd).eq(decimalToFloat(200 * 1000));
    expect(order.numbers.initialCollateralDeltaAmount).eq(expandDecimals(10, 18));
    expect(order.numbers.acceptablePrice).eq(expandDecimals(5001, 12));
    expect(order.numbers.triggerPrice).eq(expandDecimals(5000, 12));
    // expect(order.numbers.executionFee).eq(expandDecimals(1, 15));
    expect(order.numbers.minOutputAmount).eq(expandDecimals(50000, 6));
    expect(order.flags.isLong).eq(true);
    expect(order.flags.shouldUnwrapNativeToken).eq(false);
    expect(order.flags.autoCancel).eq(false);

    const positionKey = getPositionKey(
      order.addresses.account,
      order.addresses.market,
      order.addresses.initialCollateralToken,
      order.flags.isLong
    );

    expect(await getAutoCancelOrderKeys(dataStore, positionKey, 0, 10)).eql([]);

    // mint wnt to top up execution fee
    await wnt.mint(orderVault.address, "700");

    const validFromTime = 100;

    const txn = await exchangeRouter.connect(user0).updateOrder(
      orderKeys[0],
      decimalToFloat(250 * 1000),
      expandDecimals(4950, 12),
      expandDecimals(5050, 12),
      expandDecimals(52000, 6),
      validFromTime,
      true // autoCancel
    );

    await printGasUsage(provider, txn, "updateOrder");

    order = await reader.getOrder(dataStore.address, orderKeys[0]);
    expect(order.addresses.account).eq(user0.address);
    expect(order.addresses.market).eq(ethUsdMarket.marketToken);
    expect(order.addresses.initialCollateralToken).eq(wnt.address);
    expect(order.addresses.swapPath).eql([ethUsdMarket.marketToken]);
    expect(order.numbers.orderType).eq(OrderType.StopLossDecrease);
    expect(order.numbers.sizeDeltaUsd).eq(decimalToFloat(250 * 1000));
    expect(order.numbers.initialCollateralDeltaAmount).eq(expandDecimals(10, 18));
    expect(order.numbers.acceptablePrice).eq(expandDecimals(4950, 12));
    expect(order.numbers.triggerPrice).eq(expandDecimals(5050, 12));
    // expect(order.numbers.executionFee).eq("1000000000000700");
    expect(order.numbers.minOutputAmount).eq(expandDecimals(52000, 6));
    expect(order.numbers.validFromTime).eq(validFromTime);
    expect(order.flags.isLong).eq(true);
    expect(order.flags.shouldUnwrapNativeToken).eq(false);
    expect(order.flags.autoCancel).eq(true);

    expect(await getAutoCancelOrderKeys(dataStore, positionKey, 0, 10)).eql([orderKeys[0]]);

    const newValidFromTime = 200;

    await exchangeRouter.connect(user0).updateOrder(
      orderKeys[0],
      decimalToFloat(250 * 1000),
      expandDecimals(4950, 12),
      expandDecimals(5050, 12),
      expandDecimals(52000, 6),
      newValidFromTime,
      false // autoCancel
    );

    order = await reader.getOrder(dataStore.address, orderKeys[0]);
    expect(order.flags.autoCancel).eq(false);
    expect(order.numbers.validFromTime).eq(newValidFromTime);

    expect(await getAutoCancelOrderKeys(dataStore, positionKey, 0, 10)).eql([]);
  });

  // createOrder inverts trigger/acceptable prices on reversed
  // markets, but updateOrder used to write raw user-domain prices, executing the
  // order immediately at the wrong price. updateOrder must mirror the inversion.
  it("updateOrder inverts trigger/acceptable prices on reversed markets", async () => {
    // invert(p) = FLOAT_PRECISION^2 / p, matching OrderHandler.createOrder.
    const invert = (p) => FLOAT_PRECISION.mul(FLOAT_PRECISION).div(p);

    const triggerPriceInput = expandDecimals(5050, 12);
    const acceptablePriceInput = expandDecimals(4950, 12);

    const createParams = {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: decimalToFloat(200 * 1000),
      triggerPrice: expandDecimals(5000, 12),
      acceptablePrice: expandDecimals(5001, 12),
      executionFee,
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.StopLossDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };
    await createOrder(fixture, createParams);
    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // Flag the market as reversed (mirrors MarketStoreUtils' REVERSED slot).
    await dataStore.setBool(keys.reversedKey(ethUsdMarket.marketToken), true);

    await wnt.mint(orderVault.address, "700");

    await exchangeRouter
      .connect(user0)
      .updateOrder(orderKeys[0], decimalToFloat(250 * 1000), acceptablePriceInput, triggerPriceInput, expandDecimals(52000, 6), 0, false);

    const order = await reader.getOrder(dataStore.address, orderKeys[0]);
    // Stored prices are inverted into the internal (reversed) domain.
    expect(order.numbers.triggerPrice).eq(invert(triggerPriceInput));
    expect(order.numbers.acceptablePrice).eq(invert(acceptablePriceInput));
    // Sanity: the stored values are NOT the raw user inputs (the pre-fix bug).
    expect(order.numbers.triggerPrice).to.not.eq(triggerPriceInput);
    expect(order.numbers.acceptablePrice).to.not.eq(acceptablePriceInput);
  });

  // Control: non-reversed markets must keep storing the raw prices unchanged.
  it("updateOrder leaves prices unchanged on non-reversed markets", async () => {
    const createParams = {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [ethUsdMarket.marketToken],
      sizeDeltaUsd: decimalToFloat(200 * 1000),
      triggerPrice: expandDecimals(5000, 12),
      acceptablePrice: expandDecimals(5001, 12),
      executionFee,
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.StopLossDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };
    await createOrder(fixture, createParams);
    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    await wnt.mint(orderVault.address, "700");

    const triggerPriceInput = expandDecimals(5050, 12);
    const acceptablePriceInput = expandDecimals(4950, 12);
    await exchangeRouter
      .connect(user0)
      .updateOrder(orderKeys[0], decimalToFloat(250 * 1000), acceptablePriceInput, triggerPriceInput, expandDecimals(52000, 6), 0, false);

    const order = await reader.getOrder(dataStore.address, orderKeys[0]);
    expect(order.numbers.triggerPrice).eq(triggerPriceInput);
    expect(order.numbers.acceptablePrice).eq(acceptablePriceInput);
  });
});
