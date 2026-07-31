import { configNetworkName } from "../utils/network";
import { HardhatRuntimeEnvironment } from "hardhat/types";

export type RolesConfig = {
  roles: {
    [role: string]: {
      [account: string]: boolean;
    };
  };
  requiredRolesForContracts: {
    [role: string]: string[];
  };
};

const requiredRolesForContracts = {
  CONTROLLER: [
    "Config",
    "MarketFactory",
    "Timelock",
    "OracleStore",
    "Oracle",
    "ConfigSyncer",

    "ExchangeRouter",

    "OrderHandler",
    "DepositHandler",
    "WithdrawalHandler",
    "AdlHandler",
    "LiquidationHandler",
    "ShiftHandler",
    "FeeHandler",
    "SwapHandler",
  ],
  ROUTER_PLUGIN: ["ExchangeRouter"],
  ROLE_ADMIN: ["Timelock"],
  CONFIG_KEEPER: ["ConfigSyncer"],
};

// roles are granted in deploy/configureRoles.ts
// to add / remove roles after deployment, scripts/updateRoles.ts can be used
export default async function (hre: HardhatRuntimeEnvironment): Promise<RolesConfig> {
  const { deployer } = await hre.getNamedAccounts();

  const roles: {
    [network: string]: {
      [role: string]: {
        [account: string]: boolean;
      };
    };
  } = {
    base: {
      // Deployer EOA signs hardhat deploy (must hold CONFIG_KEEPER).
      // Ops Safe holds admin/timelock/fee roles. Keeper is hot wallet.
      // CONTROLLER / ROUTER_PLUGIN granted to contracts by deploy scripts.
      ADL_KEEPER: { "0x9972ebFB450D1b8CD6F1628b56d1d9aD968b29Fc": true },
      CONFIG_KEEPER: { "0xaE05a451B750659F60CE72dcA1bD398675Ff8ECc": true },
      CONTROLLER: {},
      FEE_KEEPER: { "0xA4FA22FC0238901B95d3bD80D84Bf0D18246aa9C": true },
      FROZEN_ORDER_KEEPER: { "0x9972ebFB450D1b8CD6F1628b56d1d9aD968b29Fc": true },
      GOV_TOKEN_CONTROLLER: { "0xA4FA22FC0238901B95d3bD80D84Bf0D18246aa9C": true },
      LIQUIDATION_KEEPER: { "0x9972ebFB450D1b8CD6F1628b56d1d9aD968b29Fc": true },
      MARKET_KEEPER: { "0xaE05a451B750659F60CE72dcA1bD398675Ff8ECc": true },
      ORDER_KEEPER: { "0x9972ebFB450D1b8CD6F1628b56d1d9aD968b29Fc": true },
      // Both: deployer for launch agility; Safe for long-term control. Revoke deployer later if desired.
      ROLE_ADMIN: {
        "0xaE05a451B750659F60CE72dcA1bD398675Ff8ECc": true,
        "0xA4FA22FC0238901B95d3bD80D84Bf0D18246aa9C": true,
      },
      ROUTER_PLUGIN: {},
      TIMELOCK_ADMIN: { "0xA4FA22FC0238901B95d3bD80D84Bf0D18246aa9C": true },
      TIMELOCK_MULTISIG: { "0xA4FA22FC0238901B95d3bD80D84Bf0D18246aa9C": true },
    },
    // Rehearsal of the mainnet deploy against a base fork. The real `base` entry names the
    // mainnet role holders; here every role sits on the fork deployer so the run can proceed
    // unattended.
    baseFork: {
      ADL_KEEPER: { [deployer]: true },
      CONFIG_KEEPER: { [deployer]: true },
      LIMITED_CONFIG_KEEPER: { [deployer]: true },
      CONTROLLER: { [deployer]: true },
      FEE_KEEPER: { [deployer]: true },
      FROZEN_ORDER_KEEPER: { [deployer]: true },
      GOV_TOKEN_CONTROLLER: { [deployer]: true },
      LIQUIDATION_KEEPER: { [deployer]: true },
      MARKET_KEEPER: { [deployer]: true },
      ORDER_KEEPER: { [deployer]: true },
      ROLE_ADMIN: { [deployer]: true },
      ROUTER_PLUGIN: {},
      TIMELOCK_ADMIN: { [deployer]: true },
      TIMELOCK_MULTISIG: { [deployer]: true },
    },
    baseSepolia: {
      ADL_KEEPER: { [deployer]: true },
      CONFIG_KEEPER: { [deployer]: true },
      CONTROLLER: { [deployer]: true },
      FEE_KEEPER: { [deployer]: true },
      FROZEN_ORDER_KEEPER: { [deployer]: true },
      GOV_TOKEN_CONTROLLER: { [deployer]: true },
      LIQUIDATION_KEEPER: { [deployer]: true },
      MARKET_KEEPER: { [deployer]: true },
      ORDER_KEEPER: { [deployer]: true },
      ROLE_ADMIN: { [deployer]: true },
      ROUTER_PLUGIN: {},
      TIMELOCK_ADMIN: { [deployer]: true },
      TIMELOCK_MULTISIG: { [deployer]: true },
    },
    hardhat: {
      ADL_KEEPER: { [deployer]: true },
      CONFIG_KEEPER: { [deployer]: true },
      CONTROLLER: { [deployer]: true },
      FROZEN_ORDER_KEEPER: { [deployer]: true },
      LIMITED_CONFIG_KEEPER: { [deployer]: true },
      LIQUIDATION_KEEPER: { [deployer]: true },
      MARKET_KEEPER: { [deployer]: true },
      ORDER_KEEPER: { [deployer]: true },
    },
    localhost: {
      ADL_KEEPER: { [deployer]: true },
      CONFIG_KEEPER: { [deployer]: true },
      CONTROLLER: { [deployer]: true },
      FROZEN_ORDER_KEEPER: { [deployer]: true },
      LIMITED_CONFIG_KEEPER: { [deployer]: true },
      LIQUIDATION_KEEPER: { [deployer]: true },
      MARKET_KEEPER: { [deployer]: true },
      ORDER_KEEPER: { [deployer]: true },
    },
  };

  // normalize addresses
  for (const rolesForNetwork of Object.values(roles)) {
    for (const accounts of Object.values(rolesForNetwork)) {
      for (const account of Object.keys(accounts)) {
        const checksumAccount = ethers.utils.getAddress(account);
        if (account !== checksumAccount) {
          accounts[checksumAccount] = accounts[account];
          delete accounts[account];
        }
      }
    }
  }

  // A fork with a role list of its own wins, so a rehearsal can hold the roles itself
  // instead of the source chain's holders. Otherwise a fork reads its source chain.
  const networkRoles = roles[hre.network.name] ?? roles[configNetworkName(hre.network.name)];
  return {
    roles: networkRoles,
    requiredRolesForContracts,
  };
}
