import { BigNumberish, ethers } from "ethers";
import { signTypedData } from "./helpers";

// Signing helpers for RelayRouter. Distinct from gelatoRelay.ts because the relay params drop
// externalCalls and feeSwapPath, and the call is sent straight to the router rather than wrapped in
// Gelato's trailing calldata.

function getDefaultOracleParams() {
  return {
    tokens: [],
    providers: [],
    data: [],
  };
}

export function getDomain(chainId: BigNumberish, verifyingContract: string) {
  if (!chainId) {
    throw new Error("chainId is required");
  }
  if (!verifyingContract) {
    throw new Error("verifyingContract is required");
  }
  return {
    name: "GmxBaseRelayRouter",
    version: "1",
    chainId,
    verifyingContract,
  };
}

export function hashRelayParams(relayParams: any) {
  const encoded = ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(address[] tokens, address[] providers, bytes[] data)",
      "tuple(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s, address token)[]",
      "tuple(address feeToken, uint256 feeAmount)",
      "uint256",
      "uint256",
    ],
    [
      [relayParams.oracleParams.tokens, relayParams.oracleParams.providers, relayParams.oracleParams.data],
      relayParams.tokenPermits.map((permit) => [
        permit.owner,
        permit.spender,
        permit.value,
        permit.deadline,
        permit.v,
        permit.r,
        permit.s,
        permit.token,
      ]),
      [relayParams.fee.feeToken, relayParams.fee.feeAmount],
      relayParams.userNonce,
      relayParams.deadline,
    ]
  );

  return ethers.utils.keccak256(encoded);
}

export async function getUserNonce(account: string, relayRouter: ethers.Contract) {
  return relayRouter.userNonces(account);
}

export async function getRelayParams(p: {
  oracleParams?: any;
  tokenPermits?: any;
  feeParams: any;
  userNonce?: BigNumberish;
  deadline: BigNumberish;
  relayRouter: ethers.Contract;
  signer: ethers.Signer;
}) {
  let userNonce = p.userNonce;
  if (userNonce === undefined) {
    userNonce = await getUserNonce(await p.signer.getAddress(), p.relayRouter);
  }
  return {
    oracleParams: p.oracleParams || getDefaultOracleParams(),
    tokenPermits: p.tokenPermits || [],
    fee: p.feeParams,
    userNonce,
    deadline: p.deadline,
  };
}

const CREATE_ORDER_TYPES = {
  CreateOrder: [
    { name: "collateralDeltaAmount", type: "uint256" },
    { name: "addresses", type: "CreateOrderAddresses" },
    { name: "numbers", type: "CreateOrderNumbers" },
    { name: "orderType", type: "uint256" },
    { name: "decreasePositionSwapType", type: "uint256" },
    { name: "isLong", type: "bool" },
    { name: "shouldUnwrapNativeToken", type: "bool" },
    { name: "autoCancel", type: "bool" },
    { name: "referralCode", type: "bytes32" },
    { name: "relayParams", type: "bytes32" },
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

export async function getCreateOrderSignature({
  signer,
  relayParams,
  collateralDeltaAmount,
  verifyingContract,
  params,
  chainId,
}) {
  if (relayParams.userNonce === undefined) {
    throw new Error("userNonce is required");
  }
  const typedData = {
    collateralDeltaAmount,
    addresses: params.addresses,
    numbers: params.numbers,
    orderType: params.orderType,
    decreasePositionSwapType: params.decreasePositionSwapType,
    isLong: params.isLong,
    shouldUnwrapNativeToken: params.shouldUnwrapNativeToken,
    autoCancel: params.autoCancel,
    referralCode: params.referralCode,
    relayParams: hashRelayParams(relayParams),
  };

  return signTypedData(signer, getDomain(chainId, verifyingContract), CREATE_ORDER_TYPES, typedData);
}

export async function sendCreateOrder(p: {
  signer: ethers.Signer;
  sender: ethers.Signer;
  oracleParams?: any;
  tokenPermits?: any;
  feeParams: { feeToken: string; feeAmount: BigNumberish };
  collateralDeltaAmount: BigNumberish;
  account: string;
  params: any;
  signature?: string;
  userNonce?: BigNumberish;
  deadline: BigNumberish;
  relayRouter: ethers.Contract;
  chainId: BigNumberish;
}) {
  const relayParams = await getRelayParams(p);

  let signature = p.signature;
  if (!signature) {
    signature = await getCreateOrderSignature({ ...p, relayParams, verifyingContract: p.relayRouter.address });
  }

  return p.relayRouter
    .connect(p.sender)
    .createOrder({ ...relayParams, signature }, p.account, p.collateralDeltaAmount, p.params);
}

const UPDATE_ORDER_TYPES = {
  UpdateOrder: [
    { name: "key", type: "bytes32" },
    { name: "params", type: "UpdateOrderParams" },
    { name: "executionFeeIncrease", type: "uint256" },
    { name: "relayParams", type: "bytes32" },
  ],
  UpdateOrderParams: [
    { name: "sizeDeltaUsd", type: "uint256" },
    { name: "acceptablePrice", type: "uint256" },
    { name: "triggerPrice", type: "uint256" },
    { name: "minOutputAmount", type: "uint256" },
    { name: "validFromTime", type: "uint256" },
    { name: "autoCancel", type: "bool" },
  ],
};

export async function getUpdateOrderSignature({
  signer,
  relayParams,
  verifyingContract,
  params,
  key,
  executionFeeIncrease,
  chainId,
}) {
  const typedData = {
    key,
    params,
    executionFeeIncrease,
    relayParams: hashRelayParams(relayParams),
  };

  return signTypedData(signer, getDomain(chainId, verifyingContract), UPDATE_ORDER_TYPES, typedData);
}

export async function sendUpdateOrder(p: {
  signer: ethers.Signer;
  sender: ethers.Signer;
  oracleParams?: any;
  tokenPermits?: any;
  feeParams: { feeToken: string; feeAmount: BigNumberish };
  account: string;
  key: string;
  params: any;
  executionFeeIncrease: BigNumberish;
  signature?: string;
  userNonce?: BigNumberish;
  deadline: BigNumberish;
  relayRouter: ethers.Contract;
  chainId: BigNumberish;
}) {
  const relayParams = await getRelayParams(p);

  let signature = p.signature;
  if (!signature) {
    signature = await getUpdateOrderSignature({ ...p, relayParams, verifyingContract: p.relayRouter.address });
  }

  return p.relayRouter
    .connect(p.sender)
    .updateOrder({ ...relayParams, signature }, p.account, p.key, p.params, p.executionFeeIncrease);
}

const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: "key", type: "bytes32" },
    { name: "relayParams", type: "bytes32" },
  ],
};

export async function getCancelOrderSignature({ signer, relayParams, verifyingContract, key, chainId }) {
  const typedData = {
    key,
    relayParams: hashRelayParams(relayParams),
  };

  return signTypedData(signer, getDomain(chainId, verifyingContract), CANCEL_ORDER_TYPES, typedData);
}

export async function sendCancelOrder(p: {
  signer: ethers.Signer;
  sender: ethers.Signer;
  oracleParams?: any;
  tokenPermits?: any;
  feeParams: { feeToken: string; feeAmount: BigNumberish };
  account: string;
  key: string;
  signature?: string;
  userNonce?: BigNumberish;
  deadline: BigNumberish;
  relayRouter: ethers.Contract;
  chainId: BigNumberish;
}) {
  const relayParams = await getRelayParams(p);

  let signature = p.signature;
  if (!signature) {
    signature = await getCancelOrderSignature({ ...p, relayParams, verifyingContract: p.relayRouter.address });
  }

  return p.relayRouter.connect(p.sender).cancelOrder({ ...relayParams, signature }, p.account, p.key);
}
