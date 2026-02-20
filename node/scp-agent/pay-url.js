/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--asset" && args[i + 1]) {
    flags.asset = args[++i];
  } else if (args[i] === "--network" && args[i + 1]) {
    flags.network = args[++i];
  } else {
    positional.push(args[i]);
  }
}

const target = positional[0];
const arg2 = positional[1];

if (!target) {
  console.error(`Usage:
  agent:pay <url> [hub|direct] [--asset <addr>] [--network <chain>]
  agent:pay <channelId> <amount>

Examples:
  agent:pay https://api.example/pay                  # pay via hub (default)
  agent:pay https://api.example/pay direct            # pay directly
  agent:pay https://api.example/pay --asset 0xUSDC    # pay with specific asset
  agent:pay 0xChannelId... 5000000                    # pay through channel`);
  process.exit(1);
}

const isChannelId = /^0x[a-fA-F0-9]{64}$/.test(target);

async function main() {
  const opts = {
    networkAllowlist: (process.env.NETWORKS || "eip155:8453").split(","),
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) opts.privateKey = process.env.AGENT_PRIVATE_KEY;
  if (process.env.ASSET_ALLOWLIST) opts.assetAllowlist = process.env.ASSET_ALLOWLIST.split(",");
  const agent = new ScpAgentClient(opts);

  try {
    if (isChannelId) {
      if (!arg2) {
        console.error("Usage: agent:pay <channelId> <amount>");
        process.exit(1);
      }
      console.log(`Paying ${arg2} through channel ${target.slice(0, 10)}...`);
      const result = await agent.payChannel(target, arg2);
      console.log(`Paid! ticket=${result.ticket.ticketId} fee=${result.fee}`);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const route = arg2 || "hub";
      const payOpts = { route };
      if (flags.asset) payOpts.asset = flags.asset;
      if (flags.network) payOpts.network = flags.network;
      console.log(`Paying ${target} via ${route}${flags.asset ? ` (asset: ${flags.asset})` : ""}...`);
      const result = await agent.payResource(target, payOpts);
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
