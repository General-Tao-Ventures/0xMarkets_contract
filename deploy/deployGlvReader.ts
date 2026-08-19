import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "GlvReader",
  libraryNames: [
    "GlvStoreUtils",
    "GlvDepositStoreUtils",
    "GlvShiftStoreUtils",
    "GlvWithdrawalStoreUtils",
    "GlvUtils",
    "MarketStoreUtils",
    "MarketUtils",
  ],
});

func.skip = async ({ network }: any) => network.name !== "hardhat";

export default func;
