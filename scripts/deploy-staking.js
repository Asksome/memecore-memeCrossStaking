const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying MemeCoreStaking with:", deployer.address);

  const bridgeFactoryAddr = process.env.BRIDGE_FACTORY_ADDR;
  const solMint = process.env.SOLANA_TOKEN_MINT;

  if (!bridgeFactoryAddr) {
    throw new Error("BRIDGE_FACTORY_ADDR is not set in .env");
  }
  if (!solMint) {
    throw new Error("SOLANA_TOKEN_MINT is not set in .env");
  }

  const factoryAbi = [
    "function solMintToWrapped(bytes32) view returns (address)",
  ];

  const factory = new hre.ethers.Contract(
    bridgeFactoryAddr,
    factoryAbi,
    deployer
  );

  const solMintHash = hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes(solMint)
  );

  const wrappedAddr = await factory.solMintToWrapped(solMintHash);
  console.log("Wrapped token for this mint:", wrappedAddr);

  if (wrappedAddr === hre.ethers.ZeroAddress) {
    throw new Error(
      "Wrapped token does not exist yet. Bridge at least once from Solana to create it, then rerun this script."
    );
  }

  const Staking = await hre.ethers.getContractFactory("MemeCoreStaking");
  const staking = await Staking.deploy(wrappedAddr);
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();

  console.log("\n==== SUMMARY ====");
  console.log("Wrapped token      :", wrappedAddr);
  console.log("MemeCoreStaking    :", stakingAddr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
