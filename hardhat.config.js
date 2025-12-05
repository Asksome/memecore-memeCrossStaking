require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.20",
  networks: {
    memecore_testnet: {
      url: "https://rpc.formicarium.memecore.net",
      chainId: 43521,
      accounts: process.env.MEMECORE_PRIVATE_KEY
        ? [process.env.MEMECORE_PRIVATE_KEY]
        : [],
    },
  },
};