import { grantRoleIfNotGranted } from "../utils/role";
import { createDeployFunction } from "../utils/deploy";

const constructorContracts = ["RoleStore", "DataStore", "EventEmitter", "Oracle"];

const func = createDeployFunction({
  contractName: "InsuranceFundHandler",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  libraryNames: ["InsuranceFundEventUtils"],
  afterDeploy: async ({ deployedContract }) => {
    // CONTROLLER lets the handler credit the reserve bucket, call the vault's
    // recordTransferIn, and emit through the InsuranceFundUtils library.
    await grantRoleIfNotGranted(deployedContract.address, "CONTROLLER");
  },
});

export default func;
