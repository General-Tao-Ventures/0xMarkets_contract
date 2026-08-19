import { expect } from "chai";
import { ethers } from "hardhat";

import { deployFixture } from "../../utils/fixture";
import { grantRole } from "../../utils/role";
import { expandDecimals } from "../../utils/math";
import { errorsContract } from "../../utils/error";
import * as keys from "../../utils/keys";

describe("InsuranceFundHandler", () => {
  let fixture;
  let wallet, user0;
  let dataStore, roleStore, insuranceFundHandler, insuranceVault, ethUsdMarket, usdc;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0 } = fixture.accounts);
    ({ dataStore, roleStore, insuranceFundHandler, insuranceVault, ethUsdMarket, usdc } = fixture.contracts);

    await dataStore.setAddress(keys.INSURANCE_FUND_ADDRESS, insuranceVault.address);
    await grantRole(roleStore, wallet.address, "CONFIG_KEEPER");
  });

  it("credits the reserve after the tokens are transferred in", async () => {
    const market = ethUsdMarket.marketToken;
    const amount = expandDecimals(50_000, 6);

    const balanceKey = keys.insuranceFundBalanceKey(market, usdc.address);
    expect(await dataStore.getUint(balanceKey)).eq(0);

    // two-phase: fund the vault, then record it
    await usdc.mint(insuranceVault.address, amount);
    await insuranceFundHandler.topUp(market, usdc.address, amount);

    expect(await dataStore.getUint(balanceKey)).eq(amount);
  });

  it("reverts when the caller is not a config keeper", async () => {
    await expect(
      insuranceFundHandler.connect(user0).topUp(ethUsdMarket.marketToken, usdc.address, expandDecimals(1, 6))
    ).to.be.revertedWithCustomError(errorsContract, "Unauthorized");
  });

  it("reverts when no insurance vault is configured", async () => {
    await dataStore.setAddress(keys.INSURANCE_FUND_ADDRESS, ethers.constants.AddressZero);

    await expect(
      insuranceFundHandler.topUp(ethUsdMarket.marketToken, usdc.address, expandDecimals(1, 6))
    ).to.be.revertedWithCustomError(errorsContract, "EmptyInsuranceFundAddress");
  });
});
