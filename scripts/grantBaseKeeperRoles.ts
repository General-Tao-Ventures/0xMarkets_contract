/**
 * Idempotent grant of mainnet Base keeper roles (ROLE_ADMIN signer via ACCOUNT_KEY).
 *
 * Usage:
 *   ACCOUNT_KEY=0x... npx hardhat run scripts/grantBaseKeeperRoles.ts --network base
 */
import hre from "hardhat";
import { hashString } from "../utils/hash";

const ORDER_KEEPER = "0x9972ebFB450D1b8CD6F1628b56d1d9aD968b29Fc";
const LIQUIDATION_KEEPER = "0x9D981C98F434A43916cee87a649ff15CB252d700";

const GRANTS: { account: string; label: string; roles: string[] }[] = [
  {
    account: LIQUIDATION_KEEPER,
    label: "liquidation-keeper (keeper-service)",
    roles: ["LIQUIDATION_KEEPER"],
  },
  {
    account: ORDER_KEEPER,
    label: "order-keeper (order-execution-keeper)",
    roles: ["ORDER_KEEPER", "FROZEN_ORDER_KEEPER", "ADL_KEEPER", "LIQUIDATION_KEEPER"],
  },
];

async function main() {
  if (hre.network.name !== "base") {
    throw new Error(`Refusing to run on network=${hre.network.name}; expected base`);
  }

  const roleStore = await hre.ethers.getContract("RoleStore");
  const [signer] = await hre.ethers.getSigners();
  console.log("signer=%s RoleStore=%s", signer.address, roleStore.address);

  for (const { account, label, roles } of GRANTS) {
    console.log("\n%s %s", label, account);
    for (const role of roles) {
      const roleHash = hashString(role);
      const has = await roleStore.hasRole(account, roleHash);
      if (has) {
        console.log("  %s: already granted", role);
        continue;
      }
      console.log("  %s: granting...", role);
      const tx = await roleStore.grantRole(account, roleHash);
      console.log("    tx %s", tx.hash);
      await tx.wait();
      console.log("    confirmed");
    }
  }

  console.log("\nDone");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
