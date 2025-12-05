const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying BridgeFactory with:", deployer.address);

  // 1. BridgeWrappedToken 구현 배포
  const Impl = await hre.ethers.getContractFactory("BridgeWrappedToken");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("BridgeWrappedToken implementation deployed to:", implAddr);

  // 2. BridgeFactory 배포 (구현 주소 전달)
  const Factory = await hre.ethers.getContractFactory("BridgeFactory");
  const factory = await Factory.deploy(implAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("BridgeFactory deployed to:", factoryAddr);

  console.log("\n==== SUMMARY ====");
  console.log("BridgeWrappedToken impl:", implAddr);
  console.log("BridgeFactory        :", factoryAddr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
