import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "GlvDepositStoreUtils",
});

func.skip = async ({ network }: any) => network.name !== "hardhat";

export default func;
