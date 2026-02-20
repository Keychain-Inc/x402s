/* eslint-disable no-console */
const { ScpAgentClient } = require("./agent-client");

const cmd = process.argv[2];
const args = process.argv.slice(3);

const USAGE = `Usage:
  node channel-cli.js open  <0xPartnerAddr> [amount]   Open channel with deposit
  node channel-cli.js fund  <channelId> <amount>        Deposit into existing channel
  node channel-cli.js close <channelId>                  Close channel (cooperative or unilateral)
  node channel-cli.js list                               List all channels

Env: RPC_URL, CONTRACT_ADDRESS (required for on-chain ops)`;

if (!cmd || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
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
    if (cmd === "open") {
      const participantB = args[0];
      const amount = args[1] || "0";
      if (!participantB || !/^0x[a-fA-F0-9]{40}$/.test(participantB)) {
        console.error("Address required: node channel-cli.js open <0xAddress> [amount]");
        process.exit(1);
      }
      console.log(`Opening channel with ${participantB}, deposit=${amount}...`);
      const result = await agent.openChannel(participantB, { amount });
      console.log("Channel opened!");
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "fund") {
      const channelId = args[0];
      const amount = args[1];
      if (!channelId || !amount) {
        console.error("Usage: node channel-cli.js fund <channelId> <amount>");
        process.exit(1);
      }
      console.log(`Funding ${channelId} with ${amount}...`);
      const result = await agent.fundChannel(channelId, amount);
      console.log("Funded!");
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "close") {
      const channelId = args[0];
      if (!channelId) {
        console.error("Usage: node channel-cli.js close <channelId>");
        process.exit(1);
      }
      console.log(`Closing ${channelId}...`);
      const result = await agent.closeChannel(channelId);
      console.log(`Closed via ${result.method}!`);
      console.log(JSON.stringify(result, null, 2));

    } else if (cmd === "list") {
      const channels = agent.listChannels();
      if (channels.length === 0) {
        console.log("No channels.");
      } else {
        console.log(`Channels: ${channels.length}`);
        for (const ch of channels) {
          console.log("-----");
          console.log(`  key:       ${ch.key}`);
          console.log(`  channelId: ${ch.channelId}`);
          console.log(`  balA:      ${ch.balA}`);
          console.log(`  balB:      ${ch.balB}`);
          console.log(`  nonce:     ${ch.nonce}`);
          if (ch.participantB) console.log(`  partner:   ${ch.participantB}`);
          if (ch.status) console.log(`  status:    ${ch.status}`);
          if (ch.txHash) console.log(`  txHash:    ${ch.txHash}`);
        }
      }

    } else {
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      process.exit(1);
    }
  } finally {
    agent.close();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
