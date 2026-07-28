import { createDeployFunction } from "../utils/deploy";
import { setBoolIfDifferent } from "../utils/dataStore";
import * as keys from "../utils/keys";

const constructorContracts = ["DataStore"];

const func = createDeployFunction({
  contractName: "PythHermesFeedProvider",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  afterDeploy: async ({ deployedContract }) => {
    // left disabled: this provider accepts the keeper's price bytes without verifying a Pyth
    // signature, so an enabled provider is one config write away from arbitrary pricing.
    // Oracle._validatePrices rejects a disabled provider, so this closes the path until the
    // signature check is implemented. Re-enabling requires that fix first.
    await setBoolIfDifferent(
      keys.isOracleProviderEnabledKey(deployedContract.address),
      false,
      "isOracleProviderEnabledKey"
    );
  },
  id: "PythHermesFeedProvider",
});

func.dependencies = func.dependencies.concat(["DataStore"]);

export default func;
