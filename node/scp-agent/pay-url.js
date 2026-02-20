/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");
const { resolveNetwork, resolveAsset, parseAmount } = require("../scp-common/networks");

const target = process.argv[2];
const args = process.argv.slice(3);

if (!target) {
  console.error(`Usage:
  agent:pay <url> [hub|direct]                                Pay a 402-protected URL
  agent:pay <0xAddr> <network> <asset> <amount> [hubUrl]      Pay an address (full)
  agent:pay <0xAddr> <asset> <amount> [hubUrl]                Pay an address (default: base)
  agent:pay <0xAddr> <rawAmount> [hubUrl]                     Pay an address (raw)

Examples:
  agent:pay https://api.example/v1/data                       # pay URL via hub
  agent:pay https://api.example/v1/data direct                # pay URL directly
  agent:pay 0xPayee base usdc 5                               # 5 USDC on Base
  agent:pay 0xPayee mainnet usdc 10                           # 10 USDC on Ethereum
  agent:pay 0xPayee usdc 5                                    # 5 USDC (default: base)
  agent:pay 0xPayee 5000000                                   # raw amount
  agent:pay 0xPayee base usdc 5 http://hub:4021               # specify hub`);
  process.exit(1);
}

const isAddress = /^0x[a-fA-F0-9]{40}$/.test(target);

// Check if a string is a known network name
function isNetworkName(s) {
  try { resolveNetwork(s); return true; } catch (_) { return false; }
}

async function main() {
  const opts = {
    networkAllowlist: ["eip155:8453"],
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) opts.privateKey = process.env.AGENT_PRIVATE_KEY;
  const agent = new ScpAgentClient(opts);

  try {
    if (isAddress) {
      if (!args[0]) {
        console.error("Usage: agent:pay <0xAddr> [network] <asset> <amount> [hubUrl]");
        console.error("   or: agent:pay <0xAddr> <rawAmount> [hubUrl]");
        process.exit(1);
      }

      let amount, hubEndpoint, label, chainId;

      if (/^\d+$/.test(args[0])) {
        // Raw: agent:pay 0xAddr 5000000 [hubUrl]
        amount = args[0];
        hubEndpoint = args[1] || process.env.HUB_URL || "http://127.0.0.1:4021";
        label = amount;
      } else if (isNetworkName(args[0])) {
        // Full: agent:pay 0xAddr base usdc 5 [hubUrl]
        const network = resolveNetwork(args[0]);
        if (!args[1] || !args[2]) {
          console.error("Usage: agent:pay <0xAddr> <network> <asset> <amount> [hubUrl]");
          process.exit(1);
        }
        const asset = resolveAsset(network.chainId, args[1]);
        amount = parseAmount(args[2], asset.decimals);
        hubEndpoint = args[3] || process.env.HUB_URL || "http://127.0.0.1:4021";
        label = `${args[2]} ${asset.symbol} on ${network.name} (${amount} raw)`;
      } else {
        // Short: agent:pay 0xAddr usdc 5 [hubUrl] — default base
        if (!args[1]) {
          console.error("Usage: agent:pay <0xAddr> <asset> <amount> [hubUrl]");
          process.exit(1);
        }
        const asset = resolveAsset(8453, args[0]);
        amount = parseAmount(args[1], asset.decimals);
        hubEndpoint = args[2] || process.env.HUB_URL || "http://127.0.0.1:4021";
        label = `${args[1]} ${asset.symbol} (${amount} raw)`;
      }

      console.log(`Paying ${target} ${label} via ${hubEndpoint}...`);
      const result = await agent.payAddress(target, amount, { hubEndpoint });
      console.log(`Paid! ticket=${result.ticket.ticketId} fee=${result.fee}`);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const route = args[0] || "hub";
      console.log(`Paying ${target} via ${route}...`);
      const result = await agent.payResource(target, { route });
      console.log(`Paid! route=${result.route} ticket=${(result.ticket || {}).ticketId || "direct"}`);
      console.log(JSON.stringify(result.response, null, 2));
    }
  } finally {
    agent.close();
  }
}

main().catch((err) => {
  console.error("Payment failed:", err.message);
  process.exit(1);
});
