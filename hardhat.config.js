require("@nomiclabs/hardhat-waffle");

const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const MAINNET_RPC = process.env.MAINNET_RPC || process.env.ENS_RPC_URL || "https://ethereum.publicnode.com";

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {},
    mainnet: {
      url: MAINNET_RPC,
      chainId: 1,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : []
    },
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
