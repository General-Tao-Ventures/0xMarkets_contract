// Fork networks run the config of the chain they fork, so every config module maps the
// fork's network name back to its source. Keep the mapping here rather than repeating the
// ternary in each module, so adding a fork only touches one place.
const forkSources: Record<string, string> = {
  baseSepoliaFork: "baseSepolia",
  baseFork: "base",
};

export function configNetworkName(networkName: string): string {
  return forkSources[networkName] ?? networkName;
}
