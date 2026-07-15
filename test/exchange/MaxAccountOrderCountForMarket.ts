import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, createOrder, getAccountOrderCount, getOrderKeys, handleOrder } from "../../utils/order";
import { handleDeposit } from "../../utils/deposit";
import { executeLiquidation } from "../../utils/liquidation";
import { grantRole } from "../../utils/role";
import { getAccountPositionCount } from "../../utils/position";
import { errorsContract } from "../../utils/error";
import * as keys from "../../utils/keys";

// Cap on how many pending orders one account can hold in a single market. The min-execution-fee that
// would normally rate-limit order spam is waived on 0xM, so this cap is what stops junk-order spam.
describe("Exchange.MaxAccountOrderCountForMarket", () => {
  const CAP = 3;

  let fixture;
  let user0, user1;
  let wallet;
  let dataStore, roleStore, ethUsdMarket, solUsdMarket, wnt, usdc, exchangeRouter;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0, user1 } = fixture.accounts);
    ({ dataStore, roleStore, ethUsdMarket, solUsdMarket, wnt, usdc, exchangeRouter } = fixture.contracts);
  });

  function orderParams(overrides = {}) {
    return {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(1000),
      acceptablePrice: expandDecimals(5001, 12),
      triggerPrice: expandDecimals(5000, 12),
      executionFee: expandDecimals(1, 15),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      ...overrides,
    };
  }

  function countKey(account, market) {
    return keys.accountOrderCountForMarketKey(account, market.marketToken);
  }

  it("blocks the order that would exceed the cap", async () => {
    await dataStore.setUint(keys.MAX_ACCOUNT_ORDER_COUNT_FOR_MARKET, CAP);

    for (let i = 0; i < CAP; i++) {
      await createOrder(fixture, orderParams());
    }
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(CAP);

    await expect(createOrder(fixture, orderParams())).to.be.revertedWithCustomError(
      errorsContract,
      "MaxAccountOrderCountForMarketExceeded"
    );
  });

  it("counts per market, so a different market has its own budget", async () => {
    await dataStore.setUint(keys.MAX_ACCOUNT_ORDER_COUNT_FOR_MARKET, CAP);

    for (let i = 0; i < CAP; i++) {
      await createOrder(fixture, orderParams());
    }
    // ethUsdMarket is full, but solUsdMarket still has room
    await createOrder(fixture, orderParams({ market: solUsdMarket }));
    expect(await dataStore.getUint(countKey(user0.address, solUsdMarket))).eq(1);
  });

  it("counts per account, so another account is not blocked", async () => {
    await dataStore.setUint(keys.MAX_ACCOUNT_ORDER_COUNT_FOR_MARKET, CAP);

    for (let i = 0; i < CAP; i++) {
      await createOrder(fixture, orderParams());
    }
    await createOrder(fixture, orderParams({ account: user1 }));
    expect(await dataStore.getUint(countKey(user1.address, ethUsdMarket))).eq(1);
  });

  it("frees a slot when an order is cancelled", async () => {
    await dataStore.setUint(keys.MAX_ACCOUNT_ORDER_COUNT_FOR_MARKET, CAP);

    for (let i = 0; i < CAP; i++) {
      await createOrder(fixture, orderParams());
    }
    await expect(createOrder(fixture, orderParams())).to.be.revertedWithCustomError(
      errorsContract,
      "MaxAccountOrderCountForMarketExceeded"
    );

    const orderKeys = await getOrderKeys(dataStore, 0, 20);
    await exchangeRouter.connect(user0).cancelOrder(orderKeys[0]);
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(CAP - 1);

    // room again after the cancel
    await createOrder(fixture, orderParams());
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(CAP);
  });

  it("cap of 0 disables the limit (the old, unlimited behaviour)", async () => {
    await dataStore.setUint(keys.MAX_ACCOUNT_ORDER_COUNT_FOR_MARKET, 0);

    for (let i = 0; i < CAP + 2; i++) {
      await createOrder(fixture, orderParams());
    }
    expect(await getAccountOrderCount(dataStore, user0.address)).eq(CAP + 2);
  });

  // Liquidation/ADL create their own orders straight through OrderStoreUtils (not createOrder). The
  // count is maintained in set/remove so those transient orders net to zero and don't desync it.
  it("stays accurate through a liquidation (protocol orders don't corrupt the count)", async () => {
    await handleDeposit(fixture, {
      create: { market: ethUsdMarket, longTokenAmount: expandDecimals(1000, 18) },
    });

    // opening a position: the market-increase order is created then executed, so it nets to zero
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
      execute: { tokens: [wnt.address, usdc.address] },
    });
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(0);

    // two pending orders take two slots
    await createOrder(fixture, orderParams());
    await createOrder(fixture, orderParams());
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(2);

    // liquidation creates + executes its own order; the user's count must be untouched
    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");
    await executeLiquidation(fixture, {
      account: user0.address,
      market: ethUsdMarket,
      collateralToken: wnt,
      isLong: true,
      minPrices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
    });

    // still 2 (the two pending orders). before the fix this drifted down to 1.
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(2);
  });

  // Safety-critical: liquidation must NEVER be blocked by the cap, even when the account is at it —
  // otherwise a trader could dodge liquidation by filling their own order slots. Liquidation (and
  // ADL) create their order straight through OrderStoreUtils, so the createOrder cap check never runs.
  it("never blocks liquidation when the account is at the cap", async () => {
    await handleDeposit(fixture, {
      create: { market: ethUsdMarket, longTokenAmount: expandDecimals(1000, 18) },
    });

    // open a position that will later be liquidated
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
      execute: { tokens: [wnt.address, usdc.address] },
    });

    // fill the account's order slots right up to the cap
    await dataStore.setUint(keys.MAX_ACCOUNT_ORDER_COUNT_FOR_MARKET, CAP);
    for (let i = 0; i < CAP; i++) {
      await createOrder(fixture, orderParams());
    }
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(CAP);
    // a further user order is now blocked...
    await expect(createOrder(fixture, orderParams())).to.be.revertedWithCustomError(
      errorsContract,
      "MaxAccountOrderCountForMarketExceeded"
    );

    // ...but liquidation still goes through
    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");
    await executeLiquidation(fixture, {
      account: user0.address,
      market: ethUsdMarket,
      collateralToken: wnt,
      isLong: true,
      minPrices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
  });

  it("updating an order does not change the count", async () => {
    await createOrder(fixture, orderParams());
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 20);
    await exchangeRouter
      .connect(user0)
      .updateOrder(orderKeys[0], decimalToFloat(2000), expandDecimals(5001, 12), expandDecimals(5000, 12), 0, 0, false);

    // re-storing an existing order must not bump the count
    expect(await dataStore.getUint(countKey(user0.address, ethUsdMarket))).eq(1);
  });
});
