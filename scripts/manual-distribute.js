const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
  const rpc = process.env.MEMECORE_RPC;
  const chainId = Number(process.env.MEMECORE_CHAIN_ID || 43521);
  const stakingAddr = process.env.STAKING_CONTRACT_ADDR;
  const privKey =
    process.env.VALIDATOR_PRIVATE_KEY || process.env.MEMECORE_PRIVATE_KEY;

  if (!rpc) throw new Error("MEMECORE_RPC is not set in .env");
  if (!stakingAddr) throw new Error("STAKING_CONTRACT_ADDR is not set in .env");
  if (!privKey || privKey === "0x...") {
    throw new Error("VALIDATOR_PRIVATE_KEY is not set correctly in .env");
  }

  // amount in M (native) – from CLI arg or env or default 10
  // usage:
  //   node scripts/manual-distribute.js 5.5
  // or via npm:
  //   npm run distribute -- 5.5
  const cliArg = process.argv[2];
  const amountM =
    cliArg || process.env.REWARD_AMOUNT_M || process.env.DEFAULT_REWARD_M || "10";

  const provider = new ethers.JsonRpcProvider(rpc, chainId);
  const wallet = new ethers.Wallet(privKey, provider);

  const stakingAbi = [
    "function distributeDailyRewards() external payable",
  ];

  const staking = new ethers.Contract(stakingAddr, stakingAbi, wallet);

  const valueWei = ethers.parseEther(amountM.toString());

  console.log(
    `Sending ${amountM} M from ${wallet.address} to staking contract ${stakingAddr}...`
  );

  const tx = await staking.distributeDailyRewards({ value: valueWei });
  console.log("Tx sent:", tx.hash);
  await tx.wait();
  console.log("Rewards distributed successfully.");
}

main().catch((err) => {
  console.error("manual-distribute error:", err);
  process.exit(1);
});


