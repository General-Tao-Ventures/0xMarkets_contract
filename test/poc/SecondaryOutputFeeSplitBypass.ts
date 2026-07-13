import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat, percentageToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getClaimableFeeAmount } from "../../utils/fee";
import { hashString } from "../../utils/hash";
import * as keys from "../../utils/keys";

describe("Fix: secondary output token fee split", () => {
  let fixture;
  let user0, user1, user2, user3;
  let dataStore, ethUsdMarket, wnt, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2, user3 } = fixture.accounts);
    ({ dataStore, ethUsdMarket, wnt, usdc } = fixture.contracts);

    await dataStore.setAddress(keys.VEALPHA_FEE_RECEIVER, user1.address);
    await dataStore.setAddress(keys.TREASURY_FEE_RECEIVER, user2.address);
    await dataStore.setAddress(keys.BUYBACK_FEE_RECEIVER, user3.address);

    // 25% / 15% / 10% split — pool keeps residual 50%
    await dataStore.setUint(keys.POSITION_FEE_VEALPHA_FACTOR, decimalToFloat(25, 2));
    await dataStore.setUint(keys.POSITION_FEE_TREASURY_FACTOR, decimalToFloat(15, 2));
    await dataStore.setUint(keys.POSITION_FEE_BUYBACK_FACTOR, decimalToFloat(10, 2));

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(5_000_000, 6),
      },
    });
  });

  const openLong = async () =>
    handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(20_000, 6),
        sizeDeltaUsd: decimalToFloat(100_000),
        acceptablePrice: expandDecimals(5050, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

  const closeLongAt6000 = async () =>
    handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(100_000),
        acceptablePrice: expandDecimals(4000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(6000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(6000, 4), expandDecimals(1, 6)],
      },
    });

  const claim = async (token, r) => getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, token, r.address);

  it("splits a secondary-output fee payment across BOTH tokens to the receivers (was bypassed → pool)", async () => {
    await openLong();

    // 30% fee → $30k on the $100k close, exceeding the 20k USDC collateral. Positive PnL in WNT (NoSwap)
    // pays the remainder, hitting the secondary-output branch. Fee: veAlpha 25% / treasury 15% / buyback 10%.
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(30, 2));
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(30, 2));

    await closeLongAt6000();

    const vUsdc = await claim(usdc.address, user1);
    const vWnt = await claim(wnt.address, user1);
    const tUsdc = await claim(usdc.address, user2);
    const tWnt = await claim(wnt.address, user2);
    const bUsdc = await claim(usdc.address, user3);
    const bWnt = await claim(wnt.address, user3);

    console.log("veAlpha  USDC:", vUsdc.toString(), "WNT:", vWnt.toString());
    console.log("treasury USDC:", tUsdc.toString(), "WNT:", tWnt.toString());
    console.log("buyback  USDC:", bUsdc.toString(), "WNT:", bWnt.toString());

    // The fix: every receiver is credited in BOTH tokens (before the fix all six were 0).
    for (const amt of [vUsdc, vWnt, tUsdc, tWnt, bUsdc, bWnt]) {
      expect(amt).to.be.gt(0);
    }

    // ~2/3 of the fee was paid in USDC, ~1/3 in WNT. Fee = $30k → veAlpha $7.5k, treasury $4.5k, buyback $3k.
    // USDC slice ≈ 2/3 of each cut (fixed-point scaling floors, so allow ≤2 wei of dust): $5k / $3k / $2k.
    const nearUsdc = (actual, dollars) => {
      const exp = expandDecimals(dollars, 6);
      expect(actual).to.be.gte(exp.sub(2));
      expect(actual).to.be.lte(exp);
    };
    nearUsdc(vUsdc, 5_000);
    nearUsdc(tUsdc, 3_000);
    nearUsdc(bUsdc, 2_000);

    // Split ordering is preserved in WNT too (25 > 15 > 10).
    expect(vWnt).to.be.gt(tWnt);
    expect(tWnt).to.be.gt(bWnt);
  });

  it("control: a collateral-only fee still splits to the receivers in the collateral token", async () => {
    await openLong();

    // 1% fee → $1k on the $100k close, fully covered by the 20k USDC collateral (no secondary token used).
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 2));
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 2));

    await closeLongAt6000();

    // Fee $1k → veAlpha $250, treasury $150, buyback $100, all in USDC; no WNT fee credit.
    expect(await claim(usdc.address, user1)).to.eq(expandDecimals(250, 6));
    expect(await claim(usdc.address, user2)).to.eq(expandDecimals(150, 6));
    expect(await claim(usdc.address, user3)).to.eq(expandDecimals(100, 6));
    expect(await claim(wnt.address, user1)).to.eq(0);
    expect(await claim(wnt.address, user2)).to.eq(0);
    expect(await claim(wnt.address, user3)).to.eq(0);
  });

  it("distributes the affiliate reward across BOTH tokens in the secondary-output branch", async () => {
    const { referralStorage } = fixture.contracts;
    const affiliate = fixture.accounts.user4;
    const code = hashString("fee-split-poc");

    // Set up a referral so user0's trades earn the affiliate a rebate on the position fee.
    await referralStorage.connect(affiliate).registerCode(code);
    await referralStorage.setTier(1, 1000, 2000); // 10% rebate / 20% discount
    await referralStorage.setReferrerTier(affiliate.address, 1);
    await dataStore.setUint(keys.minAffiliateRewardFactorKey(1), percentageToFloat("10%"));

    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(20_000, 6),
        sizeDeltaUsd: decimalToFloat(100_000),
        acceptablePrice: expandDecimals(5050, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
        referralCode: code,
      },
    });

    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(30, 2));
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(30, 2));

    await closeLongAt6000();

    const affUsdc = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, usdc.address, affiliate.address)
    );
    const affWnt = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, affiliate.address)
    );
    console.log("affiliate USDC:", affUsdc.toString(), "WNT:", affWnt.toString());

    // The affiliate reward is credited in BOTH payment tokens (like every other fee bucket).
    expect(affUsdc).to.be.gt(0);
    expect(affWnt).to.be.gt(0);
  });
});
