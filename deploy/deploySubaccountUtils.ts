import { createDeployFunction } from "../utils/deploy";

const func = createDeployFunction({
  contractName: "SubaccountUtils",
});

// subaccounts are unused; the only consumers (SubaccountRouter / SubaccountGelatoRelayRouter) are
// themselves hardhat-only, so this library is not needed on any persistent chain
func.skip = async ({ network }: any) => network.name !== "hardhat";

export default func;
