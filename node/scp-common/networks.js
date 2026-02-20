const { ethers } = require("ethers");

const NETWORKS = {
  mainnet:      { chainId: 1,        rpc: "https://eth.llamarpc.com",   name: "Ethereum" },
  ethereum:     { chainId: 1,        rpc: "https://eth.llamarpc.com",   name: "Ethereum" },
  eth:          { chainId: 1,        rpc: "https://eth.llamarpc.com",   name: "Ethereum" },
  base:         { chainId: 8453,     rpc: "https://mainnet.base.org",   name: "Base" },
  sepolia:      { chainId: 11155111, rpc: "https://rpc.sepolia.org",    name: "Sepolia" },
  "base-sepolia": { chainId: 84532, rpc: "https://sepolia.base.org",   name: "Base Sepolia" }
};

const ASSETS = {
  // Ethereum mainnet
  "1:usdc":  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
  "1:usdt":  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" },
  "1:eth":   { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" },
  // Base
  "8453:usdc":  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  "8453:usdt":  { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, symbol: "USDT" },
  "8453:eth":   { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" },
  // Sepolia
  "11155111:usdc": { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, symbol: "USDC" },
  "11155111:eth":  { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" },
  // Base Sepolia
  "84532:usdc": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, symbol: "USDC" },
  "84532:eth":  { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" }
};

const CONTRACTS = {
  11155111: "0x6F858C7120290431B606bBa343E3A8737B3dfCB4"
};

function resolveNetwork(name) {
  const key = (name || "").toLowerCase().replace(/\s+/g, "-");
  const net = NETWORKS[key];
  if (!net) {
    const names = [...new Set(Object.values(NETWORKS).map(n => n.name.toLowerCase()))];
    throw new Error(`Unknown network: ${name}. Known: ${names.join(", ")}`);
  }
  return net;
}

function resolveAsset(chainId, symbol) {
  const key = `${chainId}:${(symbol || "eth").toLowerCase()}`;
  const asset = ASSETS[key];
  if (!asset) {
    const available = Object.keys(ASSETS)
      .filter(k => k.startsWith(`${chainId}:`))
      .map(k => k.split(":")[1]);
    throw new Error(`Unknown asset: ${symbol} on chain ${chainId}. Available: ${available.join(", ")}`);
  }
  return asset;
}

function resolveContract(chainId) {
  return CONTRACTS[chainId] || process.env.CONTRACT_ADDRESS || null;
}

function parseAmount(humanAmount, decimals) {
  return ethers.utils.parseUnits(String(humanAmount), decimals).toString();
}

function formatAmount(rawAmount, decimals) {
  return ethers.utils.formatUnits(String(rawAmount), decimals);
}

module.exports = {
  NETWORKS, ASSETS, CONTRACTS,
  resolveNetwork, resolveAsset, resolveContract,
  parseAmount, formatAmount
};
