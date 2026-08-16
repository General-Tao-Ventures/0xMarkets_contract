import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { hashString } from "../../../utils/hash";
import { OrderType, DecreasePositionSwapType, getOrderCount } from "../../../utils/order";
import { errorsContract } from "../../../utils/error";
import { grantRole } from "../../../utils/role";
import { sendCreateOrder } from "../../../utils/relay/subaccountRelay";
import * as keys from "../../../utils/keys";

describe("SubaccountRelayRouter", () => {
  let fixture;
  let user0, user1, user2, user3, relayKeeper;
  let dataStore, roleStore, router, subaccountRelayRouter, ethUsdMarket, wnt, usdc, chainlinkPriceFeedProvider;
  let chainId;
  const referralCode = hashString("referralCode");

  let defaultParams;
  let createOrderParams;
  let subaccount;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2, user3 } = fixture.accounts);
    ({ dataStore, roleStore, router, subaccountRelayRouter, ethUsdMarket, wnt, usdc, chainlinkPriceFeedProvider } =
      fixture.contracts);

    relayKeeper = user2;
    await grantRole(roleStore, relayKeeper.address, "RELAY_KEEPER");

    // user1 is the session key held in the browser, user0 is the real account
    subaccount = user1;

    defaultParams = {
      addresses: {
        receiver: user0.address,
        cancellationReceiver: ethers.constants.AddressZero,
        callbackContract: ethers.constants.AddressZero,
        uiFeeReceiver: ethers.constants.AddressZero,
        market: ethUsdMarket.marketToken,
        initialCollateralToken: ethUsdMarket.longToken,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd: decimalToFloat(1000),
        initialCollateralDeltaAmount: 0,
        triggerPrice: decimalToFloat(4800),
        acceptablePrice: decimalToFloat(4900),
        executionFee: expandDecimals(1, 15),
        callbackGasLimit: "200000",
        minOutputAmount: 700,
        validFromTime: 0,
      },
      orderType: OrderType.LimitIncrease,
      decreasePositionSwapType: DecreasePositionSwapType.SwapCollateralTokenToPnlToken,
      isLong: true,
      shouldUnwrapNativeToken: false,
      autoCancel: false,
      referralCode,
    };

    await usdc.mint(user0.address, expandDecimals(100_000, 6));
    await wnt.mint(user0.address, expandDecimals(1000, 18));
    await usdc.connect(user0).approve(router.address, expandDecimals(100_000, 6));
    await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));

    await wnt.mint(relayKeeper.address, expandDecimals(100, 18));
    await wnt.connect(relayKeeper).approve(router.address, expandDecimals(100, 18));

    // the fee the session key may spend from the main account is capped by value
    await dataStore.setUint(keys.MAX_RELAY_FEE_SWAP_USD_FOR_SUBACCOUNT, decimalToFloat(10));

    chainId = await hre.ethers.provider.getNetwork().then((network) => network.chainId);

    createOrderParams = {
      sender: relayKeeper,
      signer: subaccount,
      subaccountApprovalSigner: user0,
      feeParams: {
        feeToken: usdc.address,
        feeAmount: expandDecimals(2, 6),
      },
      tokenPermits: [],
      // the subaccount fee cap is priced by the oracle, so the fee token price must be supplied
      oracleParams: {
        tokens: [usdc.address, wnt.address],
        providers: [chainlinkPriceFeedProvider.address, chainlinkPriceFeedProvider.address],
        data: ["0x", "0x"],
      },
      collateralDeltaAmount: expandDecimals(1, 17),
      account: user0.address,
      subaccount: subaccount.address,
      params: defaultParams,
      deadline: 9999999999,
      relayRouter: subaccountRelayRouter,
      chainId,
      subaccountApproval: {
        subaccount: subaccount.address,
        shouldAdd: true,
        expiresAt: 9999999999,
        maxAllowedCount: 10,
        actionType: keys.SUBACCOUNT_ORDER_ACTION,
        deadline: 9999999999,
      },
    };
  });

  it("lets an approved session key place an order for the main account", async () => {
    const userEthBefore = await hre.ethers.provider.getBalance(user0.address);
    const subaccountEthBefore = await hre.ethers.provider.getBalance(subaccount.address);

    await sendCreateOrder(createOrderParams);

    expect(await getOrderCount(dataStore)).eq(1);
    // neither the account nor the session key spends native token
    expect(await hre.ethers.provider.getBalance(user0.address)).eq(userEthBefore);
    expect(await hre.ethers.provider.getBalance(subaccount.address)).eq(subaccountEthBefore);
  });

  it("rejects an order whose receiver is not the main account", async () => {
    await expect(
      sendCreateOrder({
        ...createOrderParams,
        params: {
          ...defaultParams,
          addresses: { ...defaultParams.addresses, receiver: subaccount.address },
        },
      })
    ).to.be.revertedWithCustomError(errorsContract, "InvalidReceiver");
  });

  it("rejects a cancellationReceiver that is not the main account", async () => {
    await expect(
      sendCreateOrder({
        ...createOrderParams,
        params: {
          ...defaultParams,
          addresses: { ...defaultParams.addresses, cancellationReceiver: subaccount.address },
        },
      })
    ).to.be.revertedWithCustomError(errorsContract, "InvalidCancellationReceiverForSubaccountOrder");
  });

  it("caps the relay fee a session key can spend from the main account", async () => {
    await expect(
      sendCreateOrder({
        ...createOrderParams,
        feeParams: { feeToken: usdc.address, feeAmount: expandDecimals(50, 6) },
      })
    ).to.be.revertedWithCustomError(errorsContract, "MaxRelayFeeSwapForSubaccountExceeded");
  });

  it("stops the session key once the action count is used up", async () => {
    await sendCreateOrder({
      ...createOrderParams,
      subaccountApproval: { ...createOrderParams.subaccountApproval, maxAllowedCount: 1 },
    });

    // approval already consumed, so re-use the existing authorisation with no new approval
    await expect(
      sendCreateOrder({ ...createOrderParams, subaccountApproval: undefined })
    ).to.be.revertedWithCustomError(errorsContract, "MaxSubaccountActionCountExceeded");
  });

  it("stops the session key once the approval has expired", async () => {
    const now = await time.latest();

    await sendCreateOrder({
      ...createOrderParams,
      subaccountApproval: { ...createOrderParams.subaccountApproval, expiresAt: now + 100 },
    });

    await time.increase(200);

    await expect(
      sendCreateOrder({ ...createOrderParams, subaccountApproval: undefined })
    ).to.be.revertedWithCustomError(errorsContract, "SubaccountApprovalExpired");
  });

  it("rejects a session key the account never approved", async () => {
    await expect(
      sendCreateOrder({
        ...createOrderParams,
        signer: user3,
        subaccount: user3.address,
        subaccountApproval: undefined,
      })
    ).to.be.revertedWithCustomError(errorsContract, "SubaccountNotAuthorized");
  });

  it("rejects an approval signed by someone other than the main account", async () => {
    await expect(
      sendCreateOrder({
        ...createOrderParams,
        subaccountApprovalSigner: user3,
      })
    ).to.be.revertedWithCustomError(errorsContract, "InvalidSignature");
  });
});
