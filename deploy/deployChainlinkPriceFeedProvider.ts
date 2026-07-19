import { createDeployFunction } from "../utils/deploy";
import { setBoolIfDifferent } from "../utils/dataStore";
import * as keys from "../utils/keys";

const constructorContracts = ["DataStore"];

const func = createDeployFunction({
  contractName: "ChainlinkPriceFeedProvider",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  afterDeploy: async ({ deployedContract, network }) => {
    // The Chainlink price feed provider is unused on real chains (all tokens price via Pyth Lazer)
    // and marking it atomic-enabled is live attack surface: the atomic-withdrawal path accepts any
    // globally-atomic provider without the per-token binding or the reference-price deviation guard,
    // and this provider stamps block time rather than the Chainlink round time. Leave it unarmed off
    // the in-memory test network; enable it only on hardhat where the oracle tests exercise it.
    if (network.name !== "hardhat") {
      return;
    }

    await setBoolIfDifferent(
      keys.isOracleProviderEnabledKey(deployedContract.address),
      true,
      "isOracleProviderEnabledKey"
    );

    await setBoolIfDifferent(
      keys.isAtomicOracleProviderKey(deployedContract.address),
      true,
      "isAtomicOracleProviderKey"
    );
  },
  id: "ChainlinkPriceFeedProvider_2",
});

export default func;
