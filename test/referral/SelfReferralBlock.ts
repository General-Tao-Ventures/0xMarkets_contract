import { expect } from "chai";
import { ethers } from "hardhat";

import { deployFixture } from "../../utils/fixture";
import { hashString } from "../../utils/hash";

// A1 — self-referral block.
//
// A partner must not earn a rebate on their own trading. The guard lives in ReferralStorage rather
// than in ReferralUtils.getReferralInfo because that function is `internal` and is compiled into
// every caller; putting it here keeps the change to one contract while producing the identical
// fee-path behaviour (empty code -> no affiliate -> no rebate, no revert).
describe("Referral: self-referral block (A1)", () => {
  let fixture;
  let referralStorage;
  let partner, trader, handler;
  const CODE = hashString("SELFTEST");

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ referralStorage } = fixture.contracts);
    ({ user0: partner, user1: trader, user2: handler } = fixture.accounts);

    await referralStorage.connect(partner).registerCode(CODE);
  });

  it("lets a genuine third-party referral through untouched", async () => {
    await referralStorage.connect(trader).setTraderReferralCodeByUser(CODE);

    // the trader is not the code owner, so the code resolves normally and the partner earns
    expect(await referralStorage.traderReferralCodes(trader.address)).to.eq(CODE);
    const [code, referrer] = await referralStorage.getTraderReferralInfo(trader.address);
    expect(code).to.eq(CODE);
    expect(referrer).to.eq(partner.address);
  });

  it("rejects a partner attaching to their own code, with a clear error", async () => {
    await expect(referralStorage.connect(partner).setTraderReferralCodeByUser(CODE)).to.be.revertedWith(
      "ReferralStorage: self-referral"
    );
  });

  it("does NOT revert on the handler path — an order must never fail over a referral", async () => {
    await referralStorage.connect(fixture.accounts.wallet).setHandler(handler.address, true);

    // the handler attaches the partner to their own code: this must be a silent no-op, because it
    // is called inside order creation and a revert here would reject the user's order
    await expect(referralStorage.connect(handler).setTraderReferralCode(partner.address, CODE)).to.not.be.reverted;

    expect(await referralStorage.traderReferralCodes(partner.address)).to.eq(ethers.constants.HashZero);
  });

  it("suppresses the code even when ownership moves to the trader AFTER attaching", async () => {
    // the ordering attack the attach-time check alone cannot catch
    await referralStorage.connect(trader).setTraderReferralCodeByUser(CODE);
    expect(await referralStorage.traderReferralCodes(trader.address)).to.eq(CODE);

    await referralStorage.connect(partner).setCodeOwner(CODE, trader.address);

    // trader now owns the code they are attached to -> fee path must see nothing
    expect(await referralStorage.traderReferralCodes(trader.address)).to.eq(ethers.constants.HashZero);
    const [, referrer] = await referralStorage.getTraderReferralInfo(trader.address);
    expect(referrer).to.eq(ethers.constants.AddressZero);
  });

  it("keeps the raw stored value readable for reconciliation", async () => {
    await referralStorage.connect(trader).setTraderReferralCodeByUser(CODE);
    await referralStorage.connect(partner).setCodeOwner(CODE, trader.address);

    // suppressed for pricing, still visible for support/off-chain reconciliation
    expect(await referralStorage.traderReferralCodes(trader.address)).to.eq(ethers.constants.HashZero);
    expect(await referralStorage.traderReferralCodesRaw(trader.address)).to.eq(CODE);
  });

  it("restores the rebate if the code is transferred away again", async () => {
    await referralStorage.connect(trader).setTraderReferralCodeByUser(CODE);
    await referralStorage.connect(partner).setCodeOwner(CODE, trader.address);
    expect(await referralStorage.traderReferralCodes(trader.address)).to.eq(ethers.constants.HashZero);

    // the suppression is derived, not destructive — hand the code back and the referral is live again
    await referralStorage.connect(trader).setCodeOwner(CODE, partner.address);
    expect(await referralStorage.traderReferralCodes(trader.address)).to.eq(CODE);
  });
});
