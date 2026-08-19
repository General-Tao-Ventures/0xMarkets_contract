import { grantRoleIfNotGranted, revokeRoleIfGranted } from "../utils/role";
import { configNetworkName } from "../utils/network";

// example rolesToRemove format:
// {
//   arbitrum: [
//     {
//       role: "CONTROLLER",
//       member: "0x9d44B89Eb6FB382b712C562DfaFD8825829b422e",
//     },
//   ],
// };

const rolesToRemove = {
  base: [],
  baseSepolia: [],
  hardhat: [],
  localhost: [],
};

const func = async ({ gmx, network }) => {
  const { roles } = await gmx.getRoles();
  for (const role in roles) {
    const accounts = roles[role];
    for (const account in accounts) {
      await grantRoleIfNotGranted(account, role);
    }
  }

  // Keyed by the chain being deployed to, so a fork reads its source chain's list rather
  // than throwing on a name that was never a key here.
  const _rolesToRemove = rolesToRemove[configNetworkName(network.name)] ?? [];
  for (const { account, role } of _rolesToRemove) {
    await revokeRoleIfGranted(account, role);
  }
};

func.tags = ["Roles"];
func.dependencies = ["RoleStore"];

export default func;
