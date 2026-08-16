import { expect } from "chai";

import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { hashString } from "../../../utils/hash";
import { OrderType, DecreasePositionSwapType, getOrderCount, getOrderKeys } from "../../../utils/order";
import { errorsContract } from "../../../utils/error";
import { grantRole } from "../../../utils/role";
import { getTokenPermit } from "../../../utils/relay/tokenPermit";
import { getCreateOrderSignature, sendCancelOrder, sendCreateOrder, sendUpdateOrder } from "../../../utils/relay/relay";
import * as keys from "../../../utils/keys";

const BAD_SIGNATURE =
  "0x122e3efab9b46c82dc38adf4ea6cd2c753b00f95c217a0e3a0f4dd110839f07a08eb29c1cc414d551349510e23a75219cd70c8b88515ed2b83bbd88216ffdb051f";

describe("RelayRouter", () => {
  let fixture;
  let user0, user1, user2, relayKeeper;
  let dataStore, roleStore, router, relayRouter, reader, ethUsdMarket, wnt, usdc;
  let chainId;
  const referralCode = hashString("referralCode");

  let defaultParams;
  let createOrderParams;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2 } = fixture.accounts);
    ({ dataStore, roleStore, router, relayRouter, reader, ethUsdMarket, wnt, usdc } = fixture.contracts);

    // the relayer is our own service, gated on RELAY_KEEPER rather than Gelato's address
    relayKeeper = user2;
    await grantRole(roleStore, relayKeeper.address, "RELAY_KEEPER");

    defaultParams = {
      addresses: {
        receiver: user0.address,
        cancellationReceiver: user0.address,
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

    // the relayer funds the WNT execution fee out of its own float
    await wnt.mint(relayKeeper.address, expandDecimals(100, 18));
    await wnt.connect(relayKeeper).approve(router.address, expandDecimals(100, 18));

    chainId = await hre.ethers.provider.getNetwork().then((network) => network.chainId);

    createOrderParams = {
      sender: relayKeeper,
      signer: user0,
      feeParams: {
        feeToken: usdc.address,
        feeAmount: expandDecimals(2, 6), // 2 USDC
      },
      tokenPermits: [],
      collateralDeltaAmount: expandDecimals(1, 17),
      executionFee: expandDecimals(1, 15), // chosen by the relayer, not the signer
      account: user0.address,
      params: defaultParams,
      deadline: 9999999999,
      relayRouter,
      chainId,
    };
  });

  describe("createOrder", () => {
    it("creates an order with the user paying only USDC and spending no native token", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(1000, 6));
      await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));

      const userEthBefore = await hre.ethers.provider.getBalance(user0.address);
      const userUsdcBefore = await usdc.balanceOf(user0.address);
      const keeperUsdcBefore = await usdc.balanceOf(relayKeeper.address);
      const keeperWntBefore = await wnt.balanceOf(relayKeeper.address);

      await sendCreateOrder(createOrderParams);

      expect(await getOrderCount(dataStore)).eq(1);

      // the user signs, the relayer sends: the user's native balance is untouched
      expect(await hre.ethers.provider.getBalance(user0.address)).eq(userEthBefore);

      // the user pays the relayer in USDC
      expect(userUsdcBefore.sub(await usdc.balanceOf(user0.address))).eq(expandDecimals(2, 6));
      expect((await usdc.balanceOf(relayKeeper.address)).sub(keeperUsdcBefore)).eq(expandDecimals(2, 6));

      // and the relayer, not the user, funds the WNT execution fee
      expect(keeperWntBefore.sub(await wnt.balanceOf(relayKeeper.address))).eq(expandDecimals(1, 15));
    });

    it("reverts when the sender does not hold RELAY_KEEPER", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(1000, 6));

      await expect(
        sendCreateOrder({
          ...createOrderParams,
          sender: user1,
        })
      ).to.be.revertedWithCustomError(errorsContract, "Unauthorized");
    });

    it("reverts on a bad signature", async () => {
      await expect(
        sendCreateOrder({
          ...createOrderParams,
          signature: BAD_SIGNATURE,
        })
      ).to.be.revertedWithCustomError(errorsContract, "InvalidSignature");
    });

    it("reverts when the relayer raises the fee the user signed", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(1000, 6));

      // sign for 2 USDC, submit asking for 500
      const relayParamsForSignature = {
        oracleParams: { tokens: [], providers: [], data: [] },
        tokenPermits: [],
        fee: createOrderParams.feeParams,
        userNonce: 0,
        deadline: createOrderParams.deadline,
      };
      const signature = await getCreateOrderSignature({
        signer: user0,
        relayParams: relayParamsForSignature,
        collateralDeltaAmount: createOrderParams.collateralDeltaAmount,
        verifyingContract: relayRouter.address,
        params: defaultParams,
        chainId,
      });

      await expect(
        sendCreateOrder({
          ...createOrderParams,
          feeParams: { feeToken: usdc.address, feeAmount: expandDecimals(500, 6) },
          userNonce: 0,
          signature,
        })
      ).to.be.revertedWithCustomError(errorsContract, "InvalidSignature");
    });

    it("reverts when the same nonce is replayed", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(1000, 6));
      await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));

      await sendCreateOrder({ ...createOrderParams, userNonce: 0 });

      await expect(sendCreateOrder({ ...createOrderParams, userNonce: 0 })).to.be.revertedWithCustomError(
        errorsContract,
        "InvalidUserNonce"
      );
    });

    it("reverts once the deadline has passed", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(1000, 6));

      await expect(sendCreateOrder({ ...createOrderParams, deadline: 5 })).to.be.revertedWithCustomError(
        errorsContract,
        "DeadlinePassed"
      );
    });

    it("reverts when the gasless feature is disabled", async () => {
      await dataStore.setBool(keys.gaslessFeatureDisabledKey(relayRouter.address), true);
      await expect(sendCreateOrder(createOrderParams)).to.be.revertedWithCustomError(errorsContract, "DisabledFeature");
    });

    it("lets a permit stand in for a separate approve transaction", async () => {
      await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));

      // no usdc.approve here — the permit is the only authorisation
      const tokenPermit = await getTokenPermit(
        usdc,
        user0,
        router.address,
        expandDecimals(1000, 6),
        0,
        9999999999,
        chainId
      );

      await sendCreateOrder({ ...createOrderParams, tokenPermits: [tokenPermit] });

      expect(await getOrderCount(dataStore)).eq(1);
    });

    it("rejects a permit whose spender is not the router", async () => {
      const tokenPermit = await getTokenPermit(
        usdc,
        user0,
        user1.address,
        expandDecimals(1000, 6),
        0,
        9999999999,
        chainId
      );

      await expect(
        sendCreateOrder({ ...createOrderParams, tokenPermits: [tokenPermit] })
      ).to.be.revertedWithCustomError(errorsContract, "InvalidPermitSpender");
    });
  });

  describe("relayer float", () => {
    // ZEROMARK-44 / 186: a malicious subaccount inflated the execution fee and harvested the refund
    // through its callback. Here the relayer funds the execution fee instead of the account, so the
    // same shape drains the relayer rather than the user. Check where the WNT actually lands.
    it("ignores an inflated execution fee in the signed order", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(1000, 6));
      await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));

      const inflated = expandDecimals(5, 18); // what a malicious signer asks the relayer to fund
      const relayerFunds = expandDecimals(1, 15); // what the relayer is actually willing to pay
      const keeperWntBefore = await wnt.balanceOf(relayKeeper.address);

      await sendCreateOrder({
        ...createOrderParams,
        executionFee: relayerFunds,
        params: {
          ...defaultParams,
          numbers: { ...defaultParams.numbers, executionFee: inflated },
        },
      });

      // the relayer's exposure is set by the relayer, not by whatever the user signed
      const pulled = keeperWntBefore.sub(await wnt.balanceOf(relayKeeper.address));
      expect(pulled).eq(relayerFunds);

      const orderKey = (await getOrderKeys(dataStore, 0, 1))[0];
      const order = await reader.getOrder(dataStore.address, orderKey);
      expect(order.numbers.executionFee).eq(relayerFunds);
    });

    it("keeps the execution fee increase out of the signer's control on update", async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(10_000, 6));
      await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));

      await sendCreateOrder(createOrderParams);
      const orderKey = (await getOrderKeys(dataStore, 0, 1))[0];

      const relayerIncrease = expandDecimals(1, 15);
      const keeperWntBefore = await wnt.balanceOf(relayKeeper.address);

      await sendUpdateOrder({
        sender: relayKeeper,
        signer: user0,
        feeParams: { feeToken: usdc.address, feeAmount: expandDecimals(1, 6) },
        tokenPermits: [],
        account: user0.address,
        key: orderKey,
        params: {
          sizeDeltaUsd: decimalToFloat(2000),
          acceptablePrice: decimalToFloat(4950),
          triggerPrice: decimalToFloat(4850),
          minOutputAmount: 800,
          validFromTime: 0,
          autoCancel: false,
        },
        executionFeeIncrease: relayerIncrease,
        deadline: 9999999999,
        relayRouter,
        chainId,
      });

      // the signature does not cover the increase, so only the relayer's number moves WNT
      expect(keeperWntBefore.sub(await wnt.balanceOf(relayKeeper.address))).eq(relayerIncrease);
    });
  });

  describe("updateOrder and cancelOrder", () => {
    let orderKey;

    beforeEach(async () => {
      await usdc.connect(user0).approve(router.address, expandDecimals(10_000, 6));
      await wnt.connect(user0).approve(router.address, expandDecimals(1000, 18));
      await sendCreateOrder(createOrderParams);
      orderKey = (await getOrderKeys(dataStore, 0, 1))[0];
    });

    it("updates an order signed by the account", async () => {
      await sendUpdateOrder({
        sender: relayKeeper,
        signer: user0,
        feeParams: { feeToken: usdc.address, feeAmount: expandDecimals(1, 6) },
        tokenPermits: [],
        account: user0.address,
        key: orderKey,
        params: {
          sizeDeltaUsd: decimalToFloat(2000),
          acceptablePrice: decimalToFloat(4950),
          triggerPrice: decimalToFloat(4850),
          minOutputAmount: 800,
          validFromTime: 0,
          autoCancel: false,
        },
        executionFeeIncrease: 0,
        deadline: 9999999999,
        relayRouter,
        chainId,
      });

      expect(await getOrderCount(dataStore)).eq(1);
    });

    it("reverts when a different account tries to cancel the order", async () => {
      await usdc.mint(user1.address, expandDecimals(1000, 6));
      await usdc.connect(user1).approve(router.address, expandDecimals(1000, 6));

      await expect(
        sendCancelOrder({
          sender: relayKeeper,
          signer: user1,
          feeParams: { feeToken: usdc.address, feeAmount: expandDecimals(1, 6) },
          tokenPermits: [],
          account: user1.address,
          key: orderKey,
          deadline: 9999999999,
          relayRouter,
          chainId,
        })
      ).to.be.revertedWithCustomError(errorsContract, "Unauthorized");
    });

    it("cancels an order signed by the account", async () => {
      await sendCancelOrder({
        sender: relayKeeper,
        signer: user0,
        feeParams: { feeToken: usdc.address, feeAmount: expandDecimals(1, 6) },
        tokenPermits: [],
        account: user0.address,
        key: orderKey,
        deadline: 9999999999,
        relayRouter,
        chainId,
      });

      expect(await getOrderCount(dataStore)).eq(0);
    });
  });
});
