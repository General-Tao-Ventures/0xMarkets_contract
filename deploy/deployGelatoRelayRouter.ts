import { grantRoleIfNotGranted } from "../utils/role";
import { createDeployFunction } from "../utils/deploy";

const constructorContracts = [
  "Router",
  "DataStore",
  "EventEmitter",
  "Oracle",
  "OrderHandler",
  "OrderVault",
  "ExternalHandler",
];

const func = createDeployFunction({
  contractName: "GelatoRelayRouter",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  libraryNames: ["MarketStoreUtils", "MarketUtils", "OrderStoreUtils", "SwapUtils"],
  afterDeploy: async ({ deployedContract }) => {
    await grantRoleIfNotGranted(deployedContract.address, "CONTROLLER");
    await grantRoleIfNotGranted(deployedContract.address, "ROUTER_PLUGIN");
  },
});

// gasless relay is unused; deploy only on the in-memory test network, never on a persistent chain
func.skip = async ({ network }: any) => network.name !== "hardhat";

export default func;
