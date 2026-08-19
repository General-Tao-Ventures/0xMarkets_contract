import { configNetworkName } from "../utils/network";
export function getExistingContractAddresses(network) {
  const config: { [network: string]: any } = {
    base: {},
    baseSepolia: {},
    localhost: {},
    hardhat: {},
  };

  return config[configNetworkName(network.name)];
}
