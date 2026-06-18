import { grantRoleIfNotGranted } from "../utils/role";
import { createDeployFunction } from "../utils/deploy";

const constructorContracts = ["RoleStore", "DataStore", "EventEmitter"];

const func = createDeployFunction({
  contractName: "ClaimHandler",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  libraryNames: ["FeeUtils"],
  afterDeploy: async ({ deployedContract }) => {
    // CONTROLLER is required so FeeUtils.claimFees -> MarketToken.transferOut is permitted.
    await grantRoleIfNotGranted(deployedContract.address, "CONTROLLER");
  },
  id: "ClaimHandler_1",
});

export default func;
