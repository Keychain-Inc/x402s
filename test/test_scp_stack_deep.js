const fs = require("fs");
const path = require("path");
const http = require("http");
const { expect } = require("chai");
const { ethers } = require("ethers");

describe("SCP Deep Stack", function () {
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4121;
  const PAYEE_HOST = "127.0.0.1";
  const PAYEE_PORT = 4142;
  const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
  const PAYEE_URL = `http://${PAYEE_HOST}:${PAYEE_PORT}/v1/data`;
  const PAY_URL = `http://${PAYEE_HOST}:${PAYEE_PORT}/pay`;

  const storePath = path.resolve(__dirname, "../node/scp-hub/data/store.deep-test.json");
  const agentStateDir = path.resolve(__dirname, "../node/scp-agent/state/deep-test");
  const agentStatePath = path.join(agentStateDir, "agent-state.json");

  let createHubServer;
  let createPayeeServer;
  let ScpAgentClient;
  let verifyTicket;
  let recoverChannelStateSigner;
  let readLocalProofForChannel;
  let PAYEE_ADDRESS;
  let hub;
  let payee;

  function reqJson(method, endpoint, body, headers = {}) {
    const u = new URL(endpoint);
    const payload = body ? JSON.stringify(body) : "";
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          hostname: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          headers: {
            "content-type": "application/json",
            ...headers,
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
          }
        },
        (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c.toString("utf8");
          });
          res.on("end", () => {
            try {
              resolve({
                statusCode: res.statusCode,
                body: data ? JSON.parse(data) : {},
                headers: res.headers
              });
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function makeValidPaymentBundle(paymentId) {
    const first = await reqJson("GET", PAYEE_URL);
    expect(first.statusCode).to.eq(402);
    const offer = first.body.accepts[0];
    const ext = offer.extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;

    const quoteReq = {
      invoiceId,
      paymentId,
      channelId: "0x7a0de7b4f53d675f6fc0f21a32c6b957f8e477e2acbe92d2ab36ef0f7d5e57a0",
      payee: PAYEE_ADDRESS,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120
    };
    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, quoteReq);
    expect(quote.statusCode).to.eq(200);

    const state = {
      channelId: quoteReq.channelId,
      stateNonce: 1,
      balA: "999000000",
      balB: "1000",
      locksRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    const sigA = "0x1234";
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: quote.body,
      channelState: state,
      sigA
    });
    expect(issue.statusCode).to.eq(200);

    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId,
      ticket: (() => {
        const t = { ...issue.body };
        delete t.channelAck;
        return t;
      })(),
      channelProof: {
        channelId: state.channelId,
        stateNonce: state.stateNonce,
        stateHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("demo")),
        sigA
      }
    };
    return { offer, invoiceId, quoteReq, quote: quote.body, issue: issue.body, paymentPayload, state };
  }

  before(async function () {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.mkdirSync(agentStateDir, { recursive: true });
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });
    if (fs.existsSync(agentStatePath)) fs.rmSync(agentStatePath, { force: true });

    process.env.HOST = HUB_HOST;
    process.env.PORT = String(HUB_PORT);
    process.env.STORE_PATH = storePath;
    process.env.PAYEE_HOST = PAYEE_HOST;
    process.env.PAYEE_PORT = String(PAYEE_PORT);
    process.env.HUB_URL = HUB_URL;

    delete require.cache[require.resolve("../node/scp-hub/server")];
    delete require.cache[require.resolve("../node/scp-demo/payee-server")];
    delete require.cache[require.resolve("../node/scp-agent/agent-client")];
    delete require.cache[require.resolve("../node/scp-hub/ticket")];
    delete require.cache[require.resolve("../node/scp-hub/state-signing")];
    delete require.cache[require.resolve("../node/scp-watch/challenge-watcher")];

    ({ createServer: createHubServer } = require("../node/scp-hub/server"));
    ({ createPayeeServer, PAYEE_ADDRESS } = require("../node/scp-demo/payee-server"));
    ({ ScpAgentClient } = require("../node/scp-agent/agent-client"));
    ({ verifyTicket } = require("../node/scp-hub/ticket"));
    ({ recoverChannelStateSigner } = require("../node/scp-hub/state-signing"));
    ({ readLocalProofForChannel } = require("../node/scp-watch/challenge-watcher"));

    hub = createHubServer();
    payee = createPayeeServer();
    await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));
    await new Promise((r) => payee.listen(PAYEE_PORT, PAYEE_HOST, r));
  });

  after(async function () {
    await new Promise((r) => payee.close(r));
    await new Promise((r) => hub.close(r));
  });

  it("agent can complete full payment flow", async function () {
    const agent = new ScpAgentClient({
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    const result = await agent.payResource(PAYEE_URL);
    expect(result.response.ok).to.eq(true);
    expect(result.response.receipt).to.have.property("paymentId");
  });

  it("enforces maxFee policy at agent", async function () {
    const agent = new ScpAgentClient({
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "1",
      maxAmountDefault: "5000000"
    });
    let failed = false;
    try {
      await agent.payResource(PAYEE_URL);
    } catch (err) {
      failed = true;
      expect(String(err.message || err)).to.contain("quote failed");
    }
    expect(failed).to.eq(true);
  });

  it("payee rejects tampered ticket", async function () {
    const bundle = await makeValidPaymentBundle(`pay_tamper_${Date.now()}`);
    bundle.paymentPayload.ticket.amount = String(BigInt(bundle.paymentPayload.ticket.amount) + 1n);

    const paid = await reqJson("GET", PAYEE_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(402);
    expect(
      String(paid.body.error || "").includes("invalid ticket signature") ||
        String(paid.body.error || "").includes("ticket signer mismatch")
    ).to.eq(true);
  });

  it("payee rejects wrong scheme", async function () {
    const bundle = await makeValidPaymentBundle(`pay_scheme_${Date.now()}`);
    bundle.paymentPayload.scheme = "other-scheme";
    const paid = await reqJson("GET", PAYEE_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(402);
    expect(paid.body.error).to.contain("wrong scheme");
  });

  it("payee is idempotent on repeated paymentId", async function () {
    const bundle = await makeValidPaymentBundle(`pay_replay_${Date.now()}`);
    const headers = {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    };
    const first = await reqJson("GET", PAYEE_URL, null, headers);
    const second = await reqJson("GET", PAYEE_URL, null, headers);
    expect(first.statusCode).to.eq(200);
    expect(second.statusCode).to.eq(200);
    expect(second.body.receipt.receiptId).to.eq(first.body.receipt.receiptId);
  });

  it("hub rejects ticket issue when channel mismatches quote", async function () {
    const bundle = await makeValidPaymentBundle(`pay_mismatch_${Date.now()}`);
    const badState = {
      ...bundle.state,
      channelId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    };
    const badIssue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: bundle.quote,
      channelState: badState,
      sigA: "0x1234"
    });
    expect(badIssue.statusCode).to.eq(409);
    expect(badIssue.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
  });

  it("hub signs ticket and channel ack with hub address", async function () {
    const bundle = await makeValidPaymentBundle(`pay_sigs_${Date.now()}`);
    const hubInfo = await reqJson("GET", `${HUB_URL}/.well-known/x402`);
    expect(hubInfo.statusCode).to.eq(200);

    const recoveredTicketSigner = verifyTicket(bundle.paymentPayload.ticket);
    expect(recoveredTicketSigner.toLowerCase()).to.eq(hubInfo.body.address.toLowerCase());

    const recoveredStateSigner = recoverChannelStateSigner(bundle.state, bundle.issue.channelAck.sigB);
    expect(recoveredStateSigner.toLowerCase()).to.eq(hubInfo.body.address.toLowerCase());
  });

  it("/pay returns offers with 200", async function () {
    const res = await reqJson("GET", PAY_URL);
    expect(res.statusCode).to.eq(200);
    expect(res.body.accepts).to.be.an("array");
    expect(res.body.accepts.length).to.be.greaterThan(0);
    const hub = res.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
    const direct = res.body.accepts.find((o) => o.scheme === "statechannel-direct-v1");
    expect(hub).to.not.eq(undefined);
    expect(direct).to.not.eq(undefined);
    expect(hub.maxAmountRequired).to.be.a("string");
    expect(hub.resource).to.contain("/v1/data");
  });

  it("/pay accepts payment with PAYMENT-SIGNATURE header", async function () {
    const bundle = await makeValidPaymentBundle(`pay_via_pay_${Date.now()}`);
    const paid = await reqJson("GET", PAY_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(200);
    expect(paid.body.ok).to.eq(true);
    expect(paid.body.receipt).to.have.property("paymentId");
  });

  it("multi-route payee serves different prices per path", async function () {
    const MULTI_PORT = 4143;
    const multiPayee = createPayeeServer({
      host: PAYEE_HOST,
      port: MULTI_PORT,
      routes: {
        "/v1/basic": { price: "500000" },
        "/v1/premium": { price: "5000000" }
      }
    });
    await new Promise((r) => multiPayee.listen(MULTI_PORT, PAYEE_HOST, r));
    try {
      // /pay lists all routes
      const payRes = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/pay`);
      expect(payRes.statusCode).to.eq(200);
      const resources = payRes.body.accepts.map((o) => o.resource);
      expect(resources.some((r) => r.includes("/v1/basic"))).to.eq(true);
      expect(resources.some((r) => r.includes("/v1/premium"))).to.eq(true);

      // basic route returns 402 with its price
      const basic = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/v1/basic`);
      expect(basic.statusCode).to.eq(402);
      expect(basic.body.accepts[0].maxAmountRequired).to.eq("500000");

      // premium route returns 402 with its price
      const premium = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/v1/premium`);
      expect(premium.statusCode).to.eq(402);
      expect(premium.body.accepts[0].maxAmountRequired).to.eq("5000000");

      // unknown route returns 404
      const notFound = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/v1/other`);
      expect(notFound.statusCode).to.eq(404);
    } finally {
      await new Promise((r) => multiPayee.close(r));
    }
  });

  it("multi-network payee advertises all network/asset/hub combos", async function () {
    const MULTI2_PORT = 4144;
    const multiPayee = createPayeeServer({
      host: PAYEE_HOST,
      port: MULTI2_PORT,
      routes: {
        "/v1/data": {
          price: "1000000",
          accepts: [
            { network: "eip155:8453", asset: "0xUSDC_BASE", hub: "http://hub-base:4021", hubName: "base.hub" },
            { network: "eip155:11155111", asset: "0xUSDC_SEPOLIA", hub: "http://hub-sepolia:4021", hubName: "sep.hub" }
          ]
        }
      }
    });
    await new Promise((r) => multiPayee.listen(MULTI2_PORT, PAYEE_HOST, r));
    try {
      // 402 on resource lists all combos
      const res402 = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI2_PORT}/v1/data`);
      expect(res402.statusCode).to.eq(402);
      // 2 networks × 2 schemes (hub + direct) = 4 offers
      expect(res402.body.accepts.length).to.eq(4);

      const hubOffers = res402.body.accepts.filter((o) => o.scheme === "statechannel-hub-v1");
      const directOffers = res402.body.accepts.filter((o) => o.scheme === "statechannel-direct-v1");
      expect(hubOffers.length).to.eq(2);
      expect(directOffers.length).to.eq(2);

      const networks = hubOffers.map((o) => o.network).sort();
      expect(networks).to.deep.eq(["eip155:11155111", "eip155:8453"]);

      expect(hubOffers[0].extensions["statechannel-hub-v1"].hubEndpoint).to.contain("hub-base");
      expect(hubOffers[1].extensions["statechannel-hub-v1"].hubEndpoint).to.contain("hub-sepolia");

      // /pay lists same offers
      const payRes = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI2_PORT}/pay`);
      expect(payRes.statusCode).to.eq(200);
      expect(payRes.body.accepts.length).to.eq(4);
    } finally {
      await new Promise((r) => multiPayee.close(r));
    }
  });

  it("per-asset pricing returns different prices per asset", async function () {
    const MULTI3_PORT = 4145;
    const multiPayee = createPayeeServer({
      host: PAYEE_HOST,
      port: MULTI3_PORT,
      routes: {
        "/v1/data": {
          accepts: [
            { network: "eip155:8453", asset: "0xUSDC", price: "1000000" },
            { network: "eip155:8453", asset: "0xWETH", price: "500000000000000" }
          ]
        }
      }
    });
    await new Promise((r) => multiPayee.listen(MULTI3_PORT, PAYEE_HOST, r));
    try {
      const res = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI3_PORT}/v1/data`);
      expect(res.statusCode).to.eq(402);
      // 2 assets × 2 schemes = 4 offers
      expect(res.body.accepts.length).to.eq(4);

      const hubUsdc = res.body.accepts.find(
        (o) => o.scheme === "statechannel-hub-v1" && o.asset === "0xUSDC"
      );
      const hubWeth = res.body.accepts.find(
        (o) => o.scheme === "statechannel-hub-v1" && o.asset === "0xWETH"
      );
      expect(hubUsdc.maxAmountRequired).to.eq("1000000");
      expect(hubWeth.maxAmountRequired).to.eq("500000000000000");

      // each offer has its own invoiceId
      const usdcInv = hubUsdc.extensions["statechannel-hub-v1"].invoiceId;
      const wethInv = hubWeth.extensions["statechannel-hub-v1"].invoiceId;
      expect(usdcInv).to.not.eq(wethInv);
    } finally {
      await new Promise((r) => multiPayee.close(r));
    }
  });

  it("agent chooseOffer filters by asset option", function () {
    const agent = new ScpAgentClient({
      networkAllowlist: ["eip155:8453"],
      persistEnabled: false
    });
    const offers = [
      { scheme: "statechannel-hub-v1", network: "eip155:8453", asset: "0xUSDC", maxAmountRequired: "1000000" },
      { scheme: "statechannel-direct-v1", network: "eip155:8453", asset: "0xUSDC", maxAmountRequired: "1000000" },
      { scheme: "statechannel-hub-v1", network: "eip155:8453", asset: "0xWETH", maxAmountRequired: "500000000000000" },
      { scheme: "statechannel-direct-v1", network: "eip155:8453", asset: "0xWETH", maxAmountRequired: "500000000000000" }
    ];

    // no filter — picks first hub
    const defaultOffer = agent.chooseOffer(offers, "hub");
    expect(defaultOffer.asset).to.eq("0xUSDC");

    // filter by WETH
    const wethOffer = agent.chooseOffer(offers, "hub", { asset: "0xWETH" });
    expect(wethOffer.asset).to.eq("0xWETH");
    expect(wethOffer.maxAmountRequired).to.eq("500000000000000");

    // filter by WETH direct
    const wethDirect = agent.chooseOffer(offers, "direct", { asset: "0xWETH" });
    expect(wethDirect.asset).to.eq("0xWETH");
    expect(wethDirect.scheme).to.eq("statechannel-direct-v1");

    // filter by unknown asset — undefined
    const none = agent.chooseOffer(offers, "hub", { asset: "0xDAI" });
    expect(none).to.eq(undefined);

    agent.close();
  });

  it("agent discovers offers via /pay and completes payment", async function () {
    const agent = new ScpAgentClient({
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    const result = await agent.payResource(PAY_URL);
    expect(result.response.ok).to.eq(true);
    expect(result.response.receipt).to.have.property("paymentId");
  });

  it("persists watcher proof material for both agent and hub", async function () {
    const agent = new ScpAgentClient({
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    await agent.payResource(PAYEE_URL, { paymentId: `pay_watch_${Date.now()}` });

    const s = JSON.parse(fs.readFileSync(agentStatePath, "utf8"));
    const channelIds = Object.keys((s.watch || {}).byChannelId || {});
    expect(channelIds.length).to.be.greaterThan(0);

    const hubStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const hubChannels = hubStore.channels || {};
    const intersect = channelIds.filter((id) => !!hubChannels[id]);
    expect(intersect.length).to.be.greaterThan(0);
    const channelId = intersect[intersect.length - 1];

    process.env.ROLE = "agent";
    process.env.AGENT_STATE_PATH = agentStatePath;
    const agentProof = readLocalProofForChannel(channelId, "agent");
    expect(agentProof).to.not.eq(null);
    expect(agentProof.counterpartySig).to.be.a("string");

    process.env.ROLE = "hub";
    process.env.HUB_STORE_PATH = storePath;
    const hubProof = readLocalProofForChannel(channelId, "hub");
    expect(hubProof).to.not.eq(null);
    expect(hubProof.counterpartySig).to.be.a("string");
  });
});
