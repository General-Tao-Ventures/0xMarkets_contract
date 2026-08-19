import { grantRoleIfNotGranted } from "../utils/role";
import { createDeployFunction } from "../utils/deploy";

const constructorContracts = [
  "Router",
  "RoleStore",
  "DataStore",
  "EventEmitter",
  "Oracle",
  "OrderHandler",
  "OrderVault",
];

const func = createDeployFunction({
  contractName: "SubaccountRelayRouter",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  libraryNames: ["MarketStoreUtils", "MarketUtils", "OrderStoreUtils", "SubaccountUtils", "SwapUtils"],
  afterDeploy: async ({ deployedContract }) => {
    await grantRoleIfNotGranted(deployedContract.address, "CONTROLLER");
    await grantRoleIfNotGranted(deployedContract.address, "ROUTER_PLUGIN");
  },
});

export default func;
