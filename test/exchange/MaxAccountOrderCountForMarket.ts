import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, createOrder, getAccountOrderCount, getOrderKeys } from "../../utils/order";
import { errorsContract } from "../../utils/error";
import * as keys from "../../utils/keys";

// Cap on how many pending orders one account can hold in a single market. The min-execution-fee that
// would normally rate-limit order spam is waived on 0xM, so this cap is what stops junk-order spam.
describe("Exchange.MaxAccountOrderCountForMarket", () => {
  const CAP = 3;

  let fixture;
  let user0, user1;
  let dataStore, ethUsdMarket, solUsdMarket, wnt, exchangeRouter;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1 } = fixture.accounts);
    ({ dataStore, ethUsdMarket, solUsdMarket, wnt, exchangeRouter } = fixture.contracts);
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
});
