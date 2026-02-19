/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");

const target = process.argv[2];
const arg2 = process.argv[3];
const arg3 = process.argv[4];

if (!target) {
  console.error("Usage:");
  console.error("  node pay-url.js <url> [hub|direct]              Pay a 402-protected URL (hub discovered from 402)");
  console.error("  node pay-url.js <0xAddress> <amount> [hubUrl]   Pay an address via hub");
  process.exit(1);
}

const isAddress = /^0x[a-fA-F0-9]{40}$/.test(target);

async function main() {
  const agent = new ScpAgentClient({
    networkAllowlist: ["eip155:8453"],
    maxFeeDefault: process.env.MAX_FEE || "5000",
    maxAmountDefault: process.env.MAX_AMOUNT || "5000000"
  });

  try {
    if (isAddress) {
      const amount = arg2;
      if (!amount || !/^[0-9]+$/.test(amount)) {
        console.error("Amount required: node pay-url.js <0xAddress> <amount>");
        process.exit(1);
      }
      const hubEndpoint = arg3 || process.env.HUB_URL || "http://127.0.0.1:4021";
      console.log(`Paying ${target} ${amount} via ${hubEndpoint}...`);
      const result = await agent.payAddress(target, amount, { hubEndpoint });
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
