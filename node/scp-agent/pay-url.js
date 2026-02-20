/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");

const target = process.argv[2];
const arg2 = process.argv[3];

if (!target) {
  console.error(`Usage:
  agent:pay <url> [hub|direct]       Pay a 402-protected URL
  agent:pay <channelId> <amount>     Pay through an open channel

Examples:
  agent:pay https://api.example/v1/data            # pay via hub (default)
  agent:pay https://api.example/v1/data direct      # pay directly
  agent:pay 0xChannelId... 5000000                  # pay through channel`);
  process.exit(1);
}

const isChannelId = /^0x[a-fA-F0-9]{64}$/.test(target);

async function main() {
  const opts = {
    networkAllowlist: ["eip155:8453"],
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  };
  if (process.env.AGENT_PRIVATE_KEY) opts.privateKey = process.env.AGENT_PRIVATE_KEY;
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
