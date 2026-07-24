import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { scenes } from "../../scenes";
import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getClaimableCollateralTimeKey } from "../../../utils/collateral";
import { errorsContract } from "../../../utils/error";
import * as keys from "../../../utils/keys";

describe("Exchange.DecreasePosition.ClaimableCollateralAutoRelease", () => {
  let fixture;
  let user0;
  let exchangeRouter, dataStore, ethUsdMarket, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0 } = fixture.accounts);
    ({ exchangeRouter, dataStore, ethUsdMarket, usdc } = fixture.contracts);
    await scenes.deposit(fixture);
  });

  // accrue 20 USDC of claimable collateral for user0 via a capped negative price impact decrease,
  // mirroring test/exchange/DecreasePosition/CappedPriceImpact.ts ("capped price impact")
  const accrueClaimableCollateral = async () => {
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(5, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 7));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));
    await dataStore.setUint(keys.maxPositionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(5, 4));
    await dataStore.setUint(keys.maxPositionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1, 3));

    await scenes.increasePosition.long(fixture);
    await scenes.increasePosition.short(fixture);

    const timeKey = await getClaimableCollateralTimeKey();
    await scenes.decreasePosition.long(fixture, {
      create: { receiver: fixture.accounts.user1, initialCollateralDeltaAmount: 0 },
    });

    expect(
      await dataStore.getUint(
        keys.claimableCollateralAmountKey(ethUsdMarket.marketToken, usdc.address, timeKey, user0.address)
      )
    ).eq(expandDecimals(20, 6));

    return timeKey;
  };

  it("keeps collateral frozen before the delay, then auto-releases 100% with no keeper factor", async () => {
    const timeKey = await accrueClaimableCollateral();

    // no factor was set: before the delay the claim reverts -> funds are frozen
    await expect(
      exchangeRouter
        .connect(user0)
        .claimCollateral([ethUsdMarket.marketToken], [usdc.address], [timeKey], user0.address)
    ).to.be.revertedWithCustomError(errorsContract, "CollateralAlreadyClaimed");

    // still no factor set, but past the delay floor (1 day) the full amount auto-releases
    await time.increase(25 * 60 * 60);

    const balBefore = await usdc.balanceOf(user0.address);
    await exchangeRouter
      .connect(user0)
      .claimCollateral([ethUsdMarket.marketToken], [usdc.address], [timeKey], user0.address);
    const balAfter = await usdc.balanceOf(user0.address);

    expect(balAfter.sub(balBefore)).eq(expandDecimals(20, 6));
  });

  it("still releases early when a keeper sets the factor (normal path unaffected)", async () => {
    const timeKey = await accrueClaimableCollateral();

    // keeper sets 100% factor -> claimable immediately, no delay needed
    await dataStore.setUint(
      keys.claimableCollateralFactorKey(ethUsdMarket.marketToken, usdc.address, timeKey),
      decimalToFloat(1, 0)
    );

    const balBefore = await usdc.balanceOf(user0.address);
    await exchangeRouter
      .connect(user0)
      .claimCollateral([ethUsdMarket.marketToken], [usdc.address], [timeKey], user0.address);
    expect((await usdc.balanceOf(user0.address)).sub(balBefore)).eq(expandDecimals(20, 6));
  });
});
