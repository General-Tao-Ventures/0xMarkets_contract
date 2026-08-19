import { ethers } from "hardhat";
import { percentageToFloat } from "../utils/math";
import * as keys from "../utils/keys";

// Must sum to ≤ 100%. Residual automatically goes to the market pool (LPs).
const VE_ALPHA = percentageToFloat("40%");
const TREASURY = percentageToFloat("10%");
const BUYBACK = percentageToFloat("0%");

function toPct(v: { toString(): string }) {
  return `${(Number(v.toString()) / 1e28).toFixed(4)}%`;
}

async function main() {
  const write = process.env.WRITE === "true";
  const [signer] = await ethers.getSigners();
  const config = await ethers.getContract("Config");
  const dataStore = await ethers.getContract("DataStore");

  console.log(`network:  ${(await ethers.provider.getNetwork()).name}`);
  console.log(`signer:   ${signer.address}`);
  console.log(`Config:   ${config.address}`);
  console.log(`mode:     ${write ? "WRITE (will broadcast)" : "DRY RUN"}`);
  console.log("");

  const before = {
    veAlpha: await dataStore.getUint(keys.POSITION_FEE_VEALPHA_FACTOR),
    treasury: await dataStore.getUint(keys.POSITION_FEE_TREASURY_FACTOR),
    buyback: await dataStore.getUint(keys.POSITION_FEE_BUYBACK_FACTOR),
  };

  console.log("current on-chain:");
  console.log(`  veAlpha  ${before.veAlpha.toString()} (${toPct(before.veAlpha)})`);
  console.log(`  treasury ${before.treasury.toString()} (${toPct(before.treasury)})`);
  console.log(`  buyback  ${before.buyback.toString()} (${toPct(before.buyback)})`);
  console.log("");
  console.log("target:");
  console.log(`  veAlpha  ${VE_ALPHA.toString()} (${toPct(VE_ALPHA)})`);
  console.log(`  treasury ${TREASURY.toString()} (${toPct(TREASURY)})`);
  console.log(`  buyback  ${BUYBACK.toString()} (${toPct(BUYBACK)})`);
  console.log(
    `  pool residual ≈ ${
      100 -
      Number(toPct(VE_ALPHA).slice(0, -1)) -
      Number(toPct(TREASURY).slice(0, -1)) -
      Number(toPct(BUYBACK).slice(0, -1))
    }%`
  );
  console.log("");

  if (!write) {
    console.log("Dry run only. Re-run with WRITE=true to broadcast.");
    return;
  }

  // Order: set buyback/treasury first then veAlpha if increasing from 0 — any order is fine
  // as long as each intermediate sum ≤ 100% (validator checks proposed value + others).
  const tx1 = await config.setUint(keys.POSITION_FEE_BUYBACK_FACTOR, "0x", BUYBACK);
  console.log(`set buyback  tx ${tx1.hash}`);
  await tx1.wait();

  const tx2 = await config.setUint(keys.POSITION_FEE_TREASURY_FACTOR, "0x", TREASURY);
  console.log(`set treasury tx ${tx2.hash}`);
  await tx2.wait();

  const tx3 = await config.setUint(keys.POSITION_FEE_VEALPHA_FACTOR, "0x", VE_ALPHA);
  console.log(`set veAlpha  tx ${tx3.hash}`);
  await tx3.wait();

  const after = {
    veAlpha: await dataStore.getUint(keys.POSITION_FEE_VEALPHA_FACTOR),
    treasury: await dataStore.getUint(keys.POSITION_FEE_TREASURY_FACTOR),
    buyback: await dataStore.getUint(keys.POSITION_FEE_BUYBACK_FACTOR),
  };

  console.log("");
  console.log("after:");
  console.log(`  veAlpha  ${after.veAlpha.toString()} (${toPct(after.veAlpha)})`);
  console.log(`  treasury ${after.treasury.toString()} (${toPct(after.treasury)})`);
  console.log(`  buyback  ${after.buyback.toString()} (${toPct(after.buyback)})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
