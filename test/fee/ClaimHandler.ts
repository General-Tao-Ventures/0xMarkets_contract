import { expect } from "chai";
import { ethers } from "hardhat";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getClaimableFeeAmount } from "../../utils/fee";
import { grantRole } from "../../utils/role";
import { errorsContract } from "../../utils/error";
import * as keys from "../../utils/keys";

// ZEROMARK-14: the per-receiver protocol fees (veAlpha / treasury / buyback / validator shares accrued
// under claimableFeeAmountKey(market, token, receiver)) had no external claim route and were frozen.
// ClaimHandler exposes two routes: a pull (receiver claims its own) and a push (FEE_KEEPER routes to
// the rightful receiver). These tests accrue real protocol fees via a position open, then drain them.
describe("ClaimHandler", () => {
  let fixture;
  let user0, feeKeeper, stranger;
  let roleStore, dataStore, ethUsdMarket, wnt, claimHandler;
  let veAlphaReceiver, treasuryReceiver, buybackReceiver;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user4: feeKeeper, user5: stranger } = fixture.accounts);
    ({ roleStore, dataStore, ethUsdMarket, wnt } = fixture.contracts);
    claimHandler = await ethers.getContract("ClaimHandler");

    veAlphaReceiver = fixture.accounts.user1;
    treasuryReceiver = fixture.accounts.user2;
    buybackReceiver = fixture.accounts.user3;

    await dataStore.setAddress(keys.VEALPHA_FEE_RECEIVER, veAlphaReceiver.address);
    await dataStore.setAddress(keys.TREASURY_FEE_RECEIVER, treasuryReceiver.address);
    await dataStore.setAddress(keys.BUYBACK_FEE_RECEIVER, buybackReceiver.address);

    // 0.05% position fee, split 25% / 15% / 10% (pool keeps the residual 50%).
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(5, 4));
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(5, 4));
    await dataStore.setUint(keys.POSITION_FEE_VEALPHA_FACTOR, decimalToFloat(25, 2));
    await dataStore.setUint(keys.POSITION_FEE_TREASURY_FACTOR, decimalToFloat(15, 2));
    await dataStore.setUint(keys.POSITION_FEE_BUYBACK_FACTOR, decimalToFloat(10, 2));

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(500 * 1000, 6),
      },
    });

    // Open a $200,000 long. Position fee = 200,000 * 0.05% = 100 USD = 0.02 ETH at $5,000.
    // veAlpha 0.005 ETH, treasury 0.003 ETH, buyback 0.002 ETH.
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });
  });

  it("pull: a receiver claims its own accrued protocol fees to a destination", async () => {
    const accrued = await getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, wnt.address, veAlphaReceiver.address);
    expect(accrued).eq(expandDecimals(5, 15)); // 0.005 ETH

    const destination = fixture.accounts.user6.address;
    const balBefore = await wnt.balanceOf(destination);

    await claimHandler
      .connect(veAlphaReceiver)
      .claimFees([ethUsdMarket.marketToken], [wnt.address], destination);

    expect(await wnt.balanceOf(destination)).eq(balBefore.add(accrued));
    // claimable is zeroed after the claim
    expect(
      await getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, wnt.address, veAlphaReceiver.address)
    ).eq(0);
  });

  it("pull: a caller only sweeps fees keyed to its own address (others untouched)", async () => {
    // treasuryReceiver claims — should get its own 0.003 ETH, and veAlpha/buyback are unaffected.
    const treasuryAccrued = await getClaimableFeeAmount(
      dataStore,
      ethUsdMarket.marketToken,
      wnt.address,
      treasuryReceiver.address
    );
    expect(treasuryAccrued).eq(expandDecimals(3, 15));

    await claimHandler
      .connect(treasuryReceiver)
      .claimFees([ethUsdMarket.marketToken], [wnt.address], treasuryReceiver.address);

    expect(
      await getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, wnt.address, treasuryReceiver.address)
    ).eq(0);
    // veAlpha + buyback still credited
    expect(
      await getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, wnt.address, veAlphaReceiver.address)
    ).eq(expandDecimals(5, 15));
    expect(
      await getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, wnt.address, buybackReceiver.address)
    ).eq(expandDecimals(2, 15));
  });

  it("push: a FEE_KEEPER routes a receiver's fees to that receiver", async () => {
    await grantRole(roleStore, feeKeeper.address, "FEE_KEEPER");

    const accrued = await getClaimableFeeAmount(
      dataStore,
      ethUsdMarket.marketToken,
      wnt.address,
      buybackReceiver.address
    );
    expect(accrued).eq(expandDecimals(2, 15)); // 0.002 ETH

    const balBefore = await wnt.balanceOf(buybackReceiver.address);

    await claimHandler
      .connect(feeKeeper)
      .claimFeesForReceiver([ethUsdMarket.marketToken], [wnt.address], buybackReceiver.address);

    // funds land at the rightful receiver, not at the keeper
    expect(await wnt.balanceOf(buybackReceiver.address)).eq(balBefore.add(accrued));
    expect(
      await getClaimableFeeAmount(dataStore, ethUsdMarket.marketToken, wnt.address, buybackReceiver.address)
    ).eq(0);
  });

  it("push: reverts when the caller is not a FEE_KEEPER", async () => {
    await expect(
      claimHandler
        .connect(stranger)
        .claimFeesForReceiver([ethUsdMarket.marketToken], [wnt.address], buybackReceiver.address)
    ).to.be.revertedWithCustomError(errorsContract, "Unauthorized");
  });

  it("reverts on mismatched markets / tokens length", async () => {
    await expect(
      claimHandler.connect(veAlphaReceiver).claimFees([ethUsdMarket.marketToken], [], veAlphaReceiver.address)
    ).to.be.revertedWithCustomError(errorsContract, "InvalidClaimFeesInput");
  });
});
