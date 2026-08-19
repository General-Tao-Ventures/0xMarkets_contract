import { BigNumberish, ethers } from "ethers";
import { signTypedData, hashSubaccountApproval } from "./helpers";
import { getDomain, hashRelayParams, getRelayParams } from "./relay";
import * as keys from "../keys";

// Signing helpers for SubaccountRelayRouter. The main account signs the approval once; the session
// key signs each order.

function getEmptySubaccountApproval() {
  return {
    subaccount: ethers.constants.AddressZero,
    shouldAdd: false,
    expiresAt: 0,
    maxAllowedCount: 0,
    actionType: keys.SUBACCOUNT_ORDER_ACTION,
    nonce: 0,
    signature: "0x",
    deadline: 9999999999,
  };
}

const SUBACCOUNT_APPROVAL_TYPES = {
  SubaccountApproval: [
    { name: "subaccount", type: "address" },
    { name: "shouldAdd", type: "bool" },
    { name: "expiresAt", type: "uint256" },
    { name: "maxAllowedCount", type: "uint256" },
    { name: "actionType", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function getSubaccountApprovalSignature(p: {
  signer: ethers.Signer;
  chainId: BigNumberish;
  verifyingContract: string;
  subaccount: string;
  shouldAdd: boolean;
  expiresAt: BigNumberish;
  maxAllowedCount: BigNumberish;
  actionType: string;
  nonce: BigNumberish;
  deadline: BigNumberish;
}) {
  return signTypedData(p.signer, getDomain(p.chainId, p.verifyingContract), SUBACCOUNT_APPROVAL_TYPES, {
    subaccount: p.subaccount,
    shouldAdd: p.shouldAdd,
    expiresAt: p.expiresAt,
    maxAllowedCount: p.maxAllowedCount,
    actionType: p.actionType,
    nonce: p.nonce,
    deadline: p.deadline,
  });
}

async function getSubaccountApproval(p: {
  subaccountApproval?: any;
  account: string;
  relayRouter: ethers.Contract;
  chainId: BigNumberish;
  signer: ethers.Signer;
}) {
  if (!p.subaccountApproval) {
    return getEmptySubaccountApproval();
  }

  let nonce = p.subaccountApproval.nonce;
  if (nonce === undefined) {
    nonce = await p.relayRouter.subaccountApprovalNonces(p.account);
  }

  let signature = p.subaccountApproval.signature;
  if (!signature) {
    signature = await getSubaccountApprovalSignature({
      ...p.subaccountApproval,
      nonce,
      signer: p.signer,
      chainId: p.chainId,
      verifyingContract: p.relayRouter.address,
    });
  }

  return { ...p.subaccountApproval, nonce, signature };
}

const CREATE_ORDER_TYPES = {
  CreateOrder: [
    { name: "collateralDeltaAmount", type: "uint256" },
    { name: "account", type: "address" },
    { name: "addresses", type: "CreateOrderAddresses" },
    { name: "numbers", type: "CreateOrderNumbers" },
    { name: "orderType", type: "uint256" },
    { name: "decreasePositionSwapType", type: "uint256" },
    { name: "isLong", type: "bool" },
    { name: "shouldUnwrapNativeToken", type: "bool" },
    { name: "autoCancel", type: "bool" },
    { name: "referralCode", type: "bytes32" },
    { name: "relayParams", type: "bytes32" },
    { name: "subaccountApproval", type: "bytes32" },
  ],
  CreateOrderAddresses: [
    { name: "receiver", type: "address" },
    { name: "cancellationReceiver", type: "address" },
    { name: "callbackContract", type: "address" },
    { name: "uiFeeReceiver", type: "address" },
    { name: "market", type: "address" },
    { name: "initialCollateralToken", type: "address" },
    { name: "swapPath", type: "address[]" },
  ],
  CreateOrderNumbers: [
    { name: "sizeDeltaUsd", type: "uint256" },
    { name: "initialCollateralDeltaAmount", type: "uint256" },
    { name: "triggerPrice", type: "uint256" },
    { name: "acceptablePrice", type: "uint256" },
    { name: "executionFee", type: "uint256" },
    { name: "callbackGasLimit", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "validFromTime", type: "uint256" },
  ],
};

export async function sendCreateOrder(p: {
  signer: ethers.Signer; // the subaccount / session key
  subaccountApprovalSigner: ethers.Signer; // the main account
  sender: ethers.Signer; // the relayer
  oracleParams?: any;
  tokenPermits?: any;
  feeParams: { feeToken: string; feeAmount: BigNumberish };
  collateralDeltaAmount: BigNumberish;
  executionFee: BigNumberish;
  account: string;
  subaccount: string;
  params: any;
  subaccountApproval?: any;
  signature?: string;
  userNonce?: BigNumberish;
  deadline: BigNumberish;
  relayRouter: ethers.Contract;
  chainId: BigNumberish;
}) {
  const relayParams = await getRelayParams(p);
  const subaccountApproval = await getSubaccountApproval({ ...p, signer: p.subaccountApprovalSigner });

  let signature = p.signature;
  if (!signature) {
    signature = await signTypedData(p.signer, getDomain(p.chainId, p.relayRouter.address), CREATE_ORDER_TYPES, {
      collateralDeltaAmount: p.collateralDeltaAmount,
      account: p.account,
      addresses: p.params.addresses,
      numbers: p.params.numbers,
      orderType: p.params.orderType,
      decreasePositionSwapType: p.params.decreasePositionSwapType,
      isLong: p.params.isLong,
      shouldUnwrapNativeToken: p.params.shouldUnwrapNativeToken,
      autoCancel: p.params.autoCancel,
      referralCode: p.params.referralCode,
      relayParams: hashRelayParams(relayParams),
      subaccountApproval: hashSubaccountApproval(subaccountApproval),
    });
  }

  return p.relayRouter
    .connect(p.sender)
    .createOrder(
      { ...relayParams, signature },
      subaccountApproval,
      p.account,
      p.subaccount,
      p.collateralDeltaAmount,
      p.executionFee,
      p.params
    );
}
