/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");
const { resolveAsset, parseAmount } = require("../scp-common/networks");

const target = process.argv[2];
const args = process.argv.slice(3);

if (!target) {
  console.error(`Usage:
  agent:pay <url> [hub|direct]                          Pay a 402-protected URL
  agent:pay <0xAddr> <asset> <amount> [hubUrl]          Pay an address (friendly)
  agent:pay <0xAddr> <rawAmount> [hubUrl]               Pay an address (raw)

Examples:
  agent:pay https://api.example/v1/data                 # pay URL via hub
  agent:pay https://api.example/v1/data direct          # pay URL directly
  agent:pay 0xPayee usdc 5                              # pay 5 USDC via hub
  agent:pay 0xPayee usdc 5 http://hub:4021              # pay via specific hub
  agent:pay 0xPayee 5000000                             # pay raw amount via hub`);
  process.exit(1);
}

const isAddress = /^0x[a-fA-F0-9]{40}$/.test(target);

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
      const arg1 = args[0];
      const arg2 = args[1];
      const arg3 = args[2];

      if (!arg1) {
        console.error("Usage: agent:pay <0xAddr> <asset> <amount> [hubUrl]");
        console.error("   or: agent:pay <0xAddr> <rawAmount> [hubUrl]");
        process.exit(1);
      }

      let amount, hubEndpoint, label;
      if (/^\d+$/.test(arg1)) {
        // Raw: agent:pay 0xAddr 5000000 [hubUrl]
        amount = arg1;
        hubEndpoint = arg2 || process.env.HUB_URL || "http://127.0.0.1:4021";
        label = amount;
      } else {
        // Friendly: agent:pay 0xAddr usdc 5 [hubUrl]
        if (!arg2) {
          console.error("Usage: agent:pay <0xAddr> <asset> <amount> [hubUrl]");
          process.exit(1);
        }
        const asset = resolveAsset(8453, arg1);
        amount = parseAmount(arg2, asset.decimals);
        hubEndpoint = arg3 || process.env.HUB_URL || "http://127.0.0.1:4021";
        label = `${arg2} ${asset.symbol} (${amount} raw)`;
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
