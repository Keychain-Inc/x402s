require("@nomiclabs/hardhat-waffle");

const DEPLOYER_KEY = process.env.DEPLOYER_KEY || "0xe55248855119d2e3213dc3622fc28fe4c58f3c85f4908c3b704169392230b261";

module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {},
    sepolia: {
      url: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: [DEPLOYER_KEY]
    }
  },
  solidity: {
    compilers: [
      {
        version: "0.7.6",
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
