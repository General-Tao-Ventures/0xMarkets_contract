import { HardhatRuntimeEnvironment } from "hardhat/types";
import { setBoolIfDifferent } from "../utils/dataStore";
import * as keys from "../utils/keys";

// Providers that must never be selectable, keyed by deployment name.
//
// PythHermesFeedProvider accepts the keeper's price bytes without verifying a
// Pyth signature, so an enabled provider is one config write away from
// arbitrary pricing. Oracle._validatePrices rejects a disabled provider.
//
// This runs on every deploy rather than in the provider's own afterDeploy: that
// script carries an `id`, so hardhat-deploy records it and skips it on networks
// where the provider is already deployed, which would leave an
// already-enabled provider switched on.
const disabledProviders = ["PythHermesFeedProvider"];

const func = async ({ deployments }: HardhatRuntimeEnvironment) => {
  for (const name of disabledProviders) {
    const provider = await deployments.getOrNull(name);
    if (!provider) {
      continue;
    }

    await setBoolIfDifferent(keys.isOracleProviderEnabledKey(provider.address), false, `${name} disabled`);
  }
};

func.tags = ["OracleProviders"];
func.dependencies = ["PythHermesFeedProvider"];

export default func;
