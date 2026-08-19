import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "ExecuteDepositUtils",
  libraryNames: [
    "GasUtils",
    "FeeUtils",
    "MarketUtils",
    "MarketStoreUtils",
    "MarketEventUtils",
    "DepositStoreUtils",
    "DepositEventUtils",
    "SwapUtils",
    "SwapPricingUtils",
    "PositionUtils",
    // Deposits now settle a pending insurance injection before pricing GM,
    // calling the external InsuranceFundUtils.attemptInjectPool.
    "InsuranceFundUtils",
  ],
});

export default func;
