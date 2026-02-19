/* eslint-disable no-console */
const { createServer: createHubServer } = require("../scp-hub/server");
const { createPayeeServer } = require("../scp-demo/payee-server");
const { ScpAgentClient } = require("./agent-client");

const HUB_HOST = "127.0.0.1";
const HUB_PORT = 4021;
const PAYEE_HOST = "127.0.0.1";
const PAYEE_PORT = 4042;

async function run() {
  const hub = createHubServer();
  const payee = createPayeeServer();
  await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));
  await new Promise((r) => payee.listen(PAYEE_PORT, PAYEE_HOST, r));

  try {
    const agent = new ScpAgentClient({
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });

    const resourceUrl = `http://${PAYEE_HOST}:${PAYEE_PORT}/v1/data`;
    const result = await agent.payResource(resourceUrl);
    console.log("agent pay ok");
    console.log(JSON.stringify(result.response, null, 2));
  } finally {
    await new Promise((r) => payee.close(r));
    await new Promise((r) => hub.close(r));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
