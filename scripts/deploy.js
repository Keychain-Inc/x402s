const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await deployer.getBalance();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.utils.formatEther(bal), "ETH");

  if (bal.isZero()) {
    console.error("No ETH — fund this wallet first");
    process.exit(1);
  }

  console.log("Deploying X402StateChannel...");
  const Hub = await ethers.getContractFactory("X402StateChannel");
  const hub = await Hub.deploy();
  await hub.deployed();

  console.log("X402StateChannel deployed to:", hub.address);
  console.log("tx:", hub.deployTransaction.hash);

  const remaining = await deployer.getBalance();
  console.log("Remaining balance:", ethers.utils.formatEther(remaining), "ETH");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
