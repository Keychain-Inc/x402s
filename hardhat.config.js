require("@nomiclabs/hardhat-waffle");

const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {},
    sepolia: {
      url: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : []
    },
    base: {
      url: BASE_RPC,
      chainId: 8453,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : []
    }
  },
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200
          }
        }
      }
    ]
  }
};
