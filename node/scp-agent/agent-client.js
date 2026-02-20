const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { hashChannelState, signChannelState } = require("../scp-hub/state-signing");
const { HttpJsonClient } = require("../scp-common/http-client");

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const CHANNEL_ABI = [
  "function openChannel(address participantB, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "function deposit(bytes32 channelId, uint256 amount) external payable",
  "function cooperativeClose(tuple(bytes32 channelId, uint256 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint256 stateExpiry, bytes32 contextHash) st, bytes sigA, bytes sigB) external",
  "function startClose(tuple(bytes32 channelId, uint256 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint256 stateExpiry, bytes32 contextHash) st, bytes sigFromCounterparty) external",
  "function getChannel(bytes32 channelId) external view returns (tuple(address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalDeposit, uint256 closeNonce, uint256 closeDeadline, bytes32 closeStateHash, uint256 closeBalA, uint256 closeBalB))",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)",
  "event Deposited(bytes32 indexed channelId, address indexed sender, uint256 amount, uint256 newTotalBalance)",
  "event ChannelClosed(bytes32 indexed channelId, uint256 stateNonce, uint256 payoutA, uint256 payoutB)"
];

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function safeMkdir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_e) {
    return fallback;
  }
}

function saveJson(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

class ScpAgentClient {
  constructor(options = {}) {
    this.wallet = options.wallet
      ? options.wallet
      : new ethers.Wallet(
          options.privateKey ||
            "0x6c875bfb4f247fcbcd37fd56f564fca0cfaf6458cd5e8878e9ef32ed5004f999"
        );
    this.networkAllowlist = options.networkAllowlist || ["eip155:8453"];
    this.assetAllowlist = (options.assetAllowlist || []).map((x) => x.toLowerCase());
    this.maxFeeDefault = options.maxFeeDefault || "5000";
    this.maxAmountDefault = options.maxAmountDefault || "5000000";
    this.devMode = options.devMode !== undefined ? options.devMode : !options.privateKey;
    this.persistEnabled = options.persistEnabled !== false;
    this.http = new HttpJsonClient({
      timeoutMs: options.timeoutMs || 8000,
      maxSockets: options.maxSockets || 128
    });
    this.stateDir = options.stateDir || path.resolve(__dirname, "./state");
    safeMkdir(this.stateDir);
    this.stateFile = path.join(this.stateDir, "agent-state.json");
    this.state = loadJson(this.stateFile, {
      sessions: {},
      channels: {},
      payments: {},
      watch: {
        byChannelId: {}
      }
    });
    if (!this.state.sessions) this.state.sessions = {};
    if (!this.state.channels) this.state.channels = {};
    if (!this.state.payments) this.state.payments = {};
    if (!this.state.watch) this.state.watch = {};
    if (!this.state.watch.byChannelId) this.state.watch.byChannelId = {};
  }

  persist() {
    if (!this.persistEnabled) return;
    saveJson(this.stateFile, this.state);
  }

  channelForKey(channelKey) {
    if (!this.state.channels[channelKey]) {
      if (this.devMode) {
        this.state.channels[channelKey] = {
          channelId:
            "0x" + crypto.createHash("sha256").update(`${channelKey}:${this.wallet.address}`).digest("hex"),
          nonce: 0,
          balA: "100000000000",
          balB: "0",
          virtual: true
        };
        this.persist();
      } else {
        return null;
      }
    }
    return this.state.channels[channelKey];
  }

  channelForHub(hubEndpoint) {
    const ch = this.channelForKey(`hub:${hubEndpoint}`);
    if (ch && !ch.endpoint) { ch.endpoint = hubEndpoint; this.persist(); }
    return ch;
  }

  channelForDirect(payeeAddress, endpoint) {
    const ch = this.channelForKey(`direct:${payeeAddress.toLowerCase()}`);
    if (ch && endpoint && !ch.endpoint) { ch.endpoint = endpoint; this.persist(); }
    return ch;
  }

  async queryHubInfo(hubEndpoint) {
    const res = await this.http.request("GET", `${hubEndpoint}/.well-known/x402`);
    if (res.statusCode !== 200) return null;
    return res.body;
  }

  computeFee(amount, feePolicy) {
    const base = BigInt(feePolicy.base || "0");
    const bps = BigInt(feePolicy.bps || 0);
    const gas = BigInt(feePolicy.gasSurcharge || "0");
    return base + (BigInt(amount) * bps / 10000n) + gas;
  }

  formatSetupHint(hubInfo, amount) {
    const fee = this.computeFee(amount, hubInfo.feePolicy);
    const perPayment = BigInt(amount) + fee;
    const for100 = perPayment * 100n;
    const for1000 = perPayment * 1000n;
    const lines = [
      `No channel open with hub ${hubInfo.hubName || hubInfo.address}.`,
      ``,
      `Hub:     ${hubInfo.address}`,
      `Fee:     base=${hubInfo.feePolicy.base} + ${hubInfo.feePolicy.bps}bps + gas=${hubInfo.feePolicy.gasSurcharge}`,
      `Assets:  ${(hubInfo.supportedAssets || []).join(", ")}`,
      ``,
      `Per payment: ${amount} + ${fee} fee = ${perPayment}`,
      `  100 payments ≈ ${for100}`,
      `  1000 payments ≈ ${for1000}`,
      ``,
      `Open a channel:`,
      `  npm run scp:channel:open -- ${hubInfo.address} base usdc <amount>`
    ];
    return lines.join("\n");
  }

  nextChannelState(channelKey, totalDebit, contextHash) {
    const ch = this.channelForKey(channelKey);
    const debit = BigInt(totalDebit);
    const balA = BigInt(ch.balA);
    const balB = BigInt(ch.balB);
    if (debit > balA) {
      throw new Error(
        `Insufficient channel balance: need ${debit} but have ${balA}. ` +
        `Top up with: npm run scp:channel:fund -- ${ch.channelId} <amount>`
      );
    }

    ch.nonce += 1;
    ch.balA = (balA - debit).toString();
    ch.balB = (balB + debit).toString();
    this.persist();
    return {
      channelId: ch.channelId,
      stateNonce: ch.nonce,
      balA: ch.balA,
      balB: ch.balB,
      locksRoot: ZERO32,
      stateExpiry: now() + 120,
      contextHash
    };
  }

  async discoverOffers(resourceUrl) {
    const base = resourceUrl.replace(/\/[^/]*$/, "");
    const payUrl = `${base}/pay`;
    let res = await this.http.request("GET", payUrl);
    if (res.statusCode !== 200 || !res.body.accepts) {
      res = await this.http.request("GET", resourceUrl);
      if (res.statusCode !== 402) throw new Error(`expected 402, got ${res.statusCode}`);
    }
    return (res.body.accepts || []).filter((offer) => {
      if (!this.networkAllowlist.includes(offer.network)) return false;
      if (this.assetAllowlist.length > 0 && !this.assetAllowlist.includes(offer.asset.toLowerCase())) {
        return false;
      }
      return offer.scheme === "statechannel-hub-v1" || offer.scheme === "statechannel-direct-v1";
    });
  }

  buildContextHash(data) {
    const canonical = JSON.stringify(data, Object.keys(data).sort());
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonical));
  }

  chooseOffer(offers, route, options = {}) {
    let filtered = offers;
    if (options.network) {
      filtered = filtered.filter((o) => o.network === options.network);
    }
    if (options.asset) {
      filtered = filtered.filter((o) => o.asset.toLowerCase() === options.asset.toLowerCase());
    }
    const hub = filtered.find((o) => o.scheme === "statechannel-hub-v1");
    const direct = filtered.find((o) => o.scheme === "statechannel-direct-v1");
    if (route === "hub") return hub;
    if (route === "direct") return direct;
    return hub || direct;
  }

  async payViaHub(resourceUrl, offer, options = {}) {
    const ext = offer.extensions["statechannel-hub-v1"];
    const hubEndpoint = ext.hubEndpoint;
    const invoiceId = ext.invoiceId || randomId("inv");
    const paymentId = options.paymentId || randomId("pay");

    const amount = offer.maxAmountRequired;
    const maxFee = options.maxFee || this.maxFeeDefault;
    const maxAmount = options.maxAmount || this.maxAmountDefault;
    if (BigInt(amount) > BigInt(maxAmount)) {
      throw new Error(`amount exceeds maxAmount policy (${amount} > ${maxAmount})`);
    }

    const ch = this.channelForHub(hubEndpoint);
    if (!ch) {
      const hubInfo = await this.queryHubInfo(hubEndpoint).catch(() => null);
      if (hubInfo) {
        throw new Error(this.formatSetupHint(hubInfo, amount));
      }
      throw new Error(`No channel open with hub at ${hubEndpoint}. Open one with: npm run scp:channel:open -- <hubAddress> <deposit>`);
    }

    const contextHash = this.buildContextHash({
      payee: ext.payeeAddress || offer.payTo,
      resource: offer.resource || resourceUrl,
      method: "GET",
      invoiceId,
      paymentId,
      amount,
      asset: offer.asset
    });

    const quoteReq = {
      invoiceId,
      paymentId,
      channelId: this.channelForHub(hubEndpoint).channelId,
      payee: ext.payeeAddress,
      asset: offer.asset,
      amount,
      maxFee,
      quoteExpiry: now() + 120,
      contextHash
    };
    const quote = await this.http.request("POST", `${hubEndpoint}/v1/tickets/quote`, quoteReq);
    if (quote.statusCode !== 200) {
      throw new Error(`quote failed: ${quote.statusCode} ${JSON.stringify(quote.body)}`);
    }

    const state = this.nextChannelState(`hub:${hubEndpoint}`, quote.body.totalDebit, contextHash);
    const digest = hashChannelState(state);
    const sigA = await signChannelState(state, this.wallet);

    const issueReq = {
      quote: quote.body,
      channelState: state,
      sigA
    };
    const issued = await this.http.request("POST", `${hubEndpoint}/v1/tickets/issue`, issueReq);
    if (issued.statusCode !== 200) {
      throw new Error(`issue failed: ${issued.statusCode} ${JSON.stringify(issued.body)}`);
    }
    const issuedTicket = { ...issued.body };
    const channelAck = issuedTicket.channelAck || {};
    delete issuedTicket.channelAck;

    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId,
      ticket: issuedTicket,
      channelProof: {
        channelId: state.channelId,
        stateNonce: state.stateNonce,
        stateHash: digest,
        sigA
      }
    };

    const targetUrl = offer.resource || resourceUrl;
    const paid = await this.http.request("GET", targetUrl, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
    });
    if (paid.statusCode !== 200) {
      throw new Error(`payee rejected payment: ${paid.statusCode} ${JSON.stringify(paid.body)}`);
    }

    this.state.payments[paymentId] = {
      paidAt: now(),
      resourceUrl: targetUrl,
      invoiceId,
      ticketId: issuedTicket.ticketId,
      route: "hub",
      receipt: paid.body.receipt
    };
    this.state.watch.byChannelId[state.channelId] = {
      role: "agent",
      state,
      sigA,
      sigB: channelAck.sigB || null,
      updatedAt: now()
    };
    this.persist();

    return {
      offer,
      route: "hub",
      quote: quote.body,
      ticket: issuedTicket,
      response: paid.body
    };
  }

  async payViaDirect(resourceUrl, offer, options = {}) {
    const ext = offer.extensions["statechannel-direct-v1"];
    const invoiceId = ext.invoiceId || randomId("inv");
    const paymentId = options.paymentId || randomId("pay");
    const amount = offer.maxAmountRequired;
    const maxAmount = options.maxAmount || this.maxAmountDefault;
    if (BigInt(amount) > BigInt(maxAmount)) {
      throw new Error(`amount exceeds maxAmount policy (${amount} > ${maxAmount})`);
    }

    const ch = this.channelForDirect(ext.payeeAddress, resourceUrl);
    if (!ch) {
      throw new Error(
        `No direct channel open with ${ext.payeeAddress}.\n` +
        `Open one with: npm run scp:channel:open -- ${ext.payeeAddress} <deposit>`
      );
    }

    const contextHash = this.buildContextHash({
      payee: ext.payeeAddress,
      resource: offer.resource || resourceUrl,
      method: "GET",
      invoiceId,
      paymentId,
      amount,
      asset: offer.asset
    });

    const state = this.nextChannelState(
      `direct:${ext.payeeAddress.toLowerCase()}`,
      amount,
      contextHash
    );
    const sigA = await signChannelState(state, this.wallet);
    const paymentPayload = {
      scheme: "statechannel-direct-v1",
      paymentId,
      invoiceId,
      direct: {
        payer: this.wallet.address,
        payee: ext.payeeAddress,
        asset: offer.asset,
        amount,
        expiry: now() + 120,
        invoiceId,
        paymentId,
        channelState: state,
        sigA
      }
    };

    const targetUrl = offer.resource || resourceUrl;
    const paid = await this.http.request("GET", targetUrl, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
    });
    if (paid.statusCode !== 200) {
      throw new Error(`payee rejected direct payment: ${paid.statusCode} ${JSON.stringify(paid.body)}`);
    }

    this.state.payments[paymentId] = {
      paidAt: now(),
      resourceUrl: targetUrl,
      invoiceId,
      route: "direct",
      receipt: paid.body.receipt
    };
    this.persist();
    return {
      offer,
      route: "direct",
      response: paid.body
    };
  }

  async payAddress(payeeAddress, amount, options = {}) {
    const hubEndpoint = options.hubEndpoint || "http://127.0.0.1:4021";
    const asset = options.asset || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";
    const invoiceId = options.invoiceId || randomId("inv");
    const paymentId = options.paymentId || randomId("pay");
    const maxFee = options.maxFee || this.maxFeeDefault;

    const ch = this.channelForHub(hubEndpoint);
    if (!ch) {
      const hubInfo = await this.queryHubInfo(hubEndpoint).catch(() => null);
      if (hubInfo) {
        throw new Error(this.formatSetupHint(hubInfo, amount));
      }
      throw new Error(`No channel open with hub at ${hubEndpoint}. Open one with: npm run scp:channel:open -- <hubAddress> <deposit>`);
    }

    const contextHash = this.buildContextHash({
      payee: payeeAddress,
      method: "transfer",
      invoiceId,
      paymentId,
      amount,
      asset
    });

    const quoteReq = {
      invoiceId,
      paymentId,
      channelId: this.channelForHub(hubEndpoint).channelId,
      payee: payeeAddress,
      asset,
      amount,
      maxFee,
      quoteExpiry: now() + 120,
      contextHash
    };
    const quote = await this.http.request("POST", `${hubEndpoint}/v1/tickets/quote`, quoteReq);
    if (quote.statusCode !== 200) {
      throw new Error(`quote failed: ${quote.statusCode} ${JSON.stringify(quote.body)}`);
    }

    const state = this.nextChannelState(`hub:${hubEndpoint}`, quote.body.totalDebit, contextHash);
    const sigA = await signChannelState(state, this.wallet);

    const issueReq = { quote: quote.body, channelState: state, sigA };
    const issued = await this.http.request("POST", `${hubEndpoint}/v1/tickets/issue`, issueReq);
    if (issued.statusCode !== 200) {
      throw new Error(`issue failed: ${issued.statusCode} ${JSON.stringify(issued.body)}`);
    }
    const issuedTicket = { ...issued.body };
    const channelAck = issuedTicket.channelAck || {};
    delete issuedTicket.channelAck;

    this.state.payments[paymentId] = {
      paidAt: now(),
      payee: payeeAddress,
      invoiceId,
      ticketId: issuedTicket.ticketId,
      amount,
      route: "hub"
    };
    this.state.watch.byChannelId[state.channelId] = {
      role: "agent",
      state,
      sigA,
      sigB: channelAck.sigB || null,
      updatedAt: now()
    };
    this.persist();

    return {
      route: "hub",
      payee: payeeAddress,
      amount,
      fee: quote.body.fee,
      ticket: issuedTicket,
      quote: quote.body
    };
  }

  async payResource(resourceUrl, options = {}) {
    const offers = await this.discoverOffers(resourceUrl);
    if (offers.length === 0) {
      throw new Error("No compatible payment offers from payee.");
    }
    const routes = offers.map((o) => o.scheme.replace("statechannel-", "").replace("-v1", ""));
    const route = options.route || "hub";
    const offer = this.chooseOffer(offers, route, options);
    if (!offer) {
      throw new Error(
        `Payee does not offer "${route}" route.\n` +
        `Available: ${routes.join(", ")}\n` +
        `Try: agent:pay ${resourceUrl} ${routes[0]}`
      );
    }
    if (offer.scheme === "statechannel-direct-v1") {
      return this.payViaDirect(resourceUrl, offer, options);
    }
    return this.payViaHub(resourceUrl, offer, options);
  }

  // --- On-chain channel operations ---

  getContract(rpcUrl, contractAddress) {
    if (!rpcUrl) throw new Error("RPC_URL required for on-chain operations");
    if (!contractAddress) throw new Error("CONTRACT_ADDRESS required");
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const signer = this.wallet.connect(provider);
    return new ethers.Contract(contractAddress, CHANNEL_ABI, signer);
  }

  async openChannel(participantB, options = {}) {
    const rpcUrl = options.rpcUrl || process.env.RPC_URL;
    const contractAddress = options.contractAddress || process.env.CONTRACT_ADDRESS;
    const contract = this.getContract(rpcUrl, contractAddress);
    const asset = options.asset || ethers.constants.AddressZero;
    const amount = BigInt(options.amount || "0");
    const challengePeriod = Number(options.challengePeriodSec || 86400);
    const channelExpiry = Number(options.channelExpiry || now() + 86400 * 30);
    const salt = options.salt || ethers.utils.formatBytes32String(`ag-${now()}-${participantB.slice(2, 8)}`);

    const txOpts = asset === ethers.constants.AddressZero
      ? { value: amount, gasLimit: 250000 }
      : { gasLimit: 250000 };
    const tx = await contract.openChannel(
      ethers.utils.getAddress(participantB), asset, amount,
      challengePeriod, channelExpiry, salt, txOpts
    );
    const rc = await tx.wait(1);
    const ev = rc.events.find(e => e.event === "ChannelOpened");
    const channelId = ev.args.channelId;

    // Store in agent state
    const channelKey = `onchain:${channelId}`;
    this.state.channels[channelKey] = {
      channelId,
      participantB: ethers.utils.getAddress(participantB),
      asset,
      nonce: 0,
      balA: amount.toString(),
      balB: "0",
      totalDeposit: amount.toString(),
      challengePeriodSec: challengePeriod,
      channelExpiry,
      contractAddress,
      txHash: tx.hash
    };
    this.persist();

    return {
      channelId,
      participantA: this.wallet.address,
      participantB: ethers.utils.getAddress(participantB),
      asset,
      amount: amount.toString(),
      challengePeriodSec: challengePeriod,
      txHash: tx.hash
    };
  }

  async fundChannel(channelId, amount, options = {}) {
    const rpcUrl = options.rpcUrl || process.env.RPC_URL;
    const contractAddress = options.contractAddress || process.env.CONTRACT_ADDRESS;
    const contract = this.getContract(rpcUrl, contractAddress);
    const value = BigInt(amount);

    // Check if ETH or ERC20 by reading on-chain
    const params = await contract.getChannel(channelId);
    const isEth = params.asset === ethers.constants.AddressZero;

    const txOpts = isEth ? { value, gasLimit: 100000 } : { gasLimit: 100000 };
    const tx = await contract.deposit(channelId, value, txOpts);
    const rc = await tx.wait(1);
    const ev = rc.events.find(e => e.event === "Deposited");

    // Update local state
    const channelKey = `onchain:${channelId}`;
    if (this.state.channels[channelKey]) {
      const ch = this.state.channels[channelKey];
      ch.balA = (BigInt(ch.balA) + value).toString();
      ch.totalDeposit = (BigInt(ch.totalDeposit) + value).toString();
      this.persist();
    }

    return {
      channelId,
      deposited: value.toString(),
      newTotalBalance: ev ? ev.args.newTotalBalance.toString() : null,
      txHash: tx.hash
    };
  }

  async closeChannel(channelId, options = {}) {
    const rpcUrl = options.rpcUrl || process.env.RPC_URL;
    const contractAddress = options.contractAddress || process.env.CONTRACT_ADDRESS;
    const contract = this.getContract(rpcUrl, contractAddress);

    // Find the latest state for this channel
    const channelKey = `onchain:${channelId}`;
    const ch = this.state.channels[channelKey];
    const watchData = this.state.watch.byChannelId[channelId];

    // Try cooperative close if we have both signatures
    if (watchData && watchData.sigA && watchData.sigB) {
      const tx = await contract.cooperativeClose(watchData.state, watchData.sigA, watchData.sigB, { gasLimit: 200000 });
      await tx.wait(1);
      if (ch) ch.status = "closed";
      this.persist();
      return { channelId, method: "cooperative", txHash: tx.hash };
    }

    // Otherwise start unilateral close
    if (watchData && watchData.state && watchData.sigB) {
      const tx = await contract.startClose(watchData.state, watchData.sigB, { gasLimit: 200000 });
      await tx.wait(1);
      if (ch) ch.status = "closing";
      this.persist();
      return { channelId, method: "unilateral", txHash: tx.hash };
    }

    throw new Error("no counterparty signature available; request cooperative close from hub or use challenge watcher");
  }

  channelById(channelId) {
    for (const [key, ch] of Object.entries(this.state.channels)) {
      if (ch.channelId === channelId) return { key, ...ch };
    }
    return null;
  }

  async payChannel(channelId, amount, options = {}) {
    const ch = this.channelById(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found in agent state.`);

    const hubMatch = ch.key.match(/^hub:(.+)$/);
    const directMatch = ch.key.match(/^direct:(.+)$/);

    if (hubMatch) {
      return this.payAddress(options.payee || this.wallet.address, amount, {
        hubEndpoint: hubMatch[1],
        ...options
      });
    }

    if (directMatch) {
      const payeeAddress = directMatch[1];
      const endpoint = ch.endpoint;
      if (!endpoint) {
        throw new Error(
          `No endpoint stored for direct channel ${channelId.slice(0, 10)}...\n` +
          `Pay a URL first to establish the endpoint, or use: agent:pay <url> direct`
        );
      }
      const paymentId = randomId("pay");
      const contextHash = this.buildContextHash({
        payee: payeeAddress,
        method: "transfer",
        paymentId,
        amount
      });
      const state = this.nextChannelState(ch.key, amount, contextHash);
      const sigA = await signChannelState(state, this.wallet);
      const paymentPayload = {
        scheme: "statechannel-direct-v1",
        paymentId,
        direct: { payer: this.wallet.address, payee: payeeAddress, amount, channelState: state, sigA }
      };
      const res = await this.http.request("GET", endpoint, null, {
        "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
      });
      if (res.statusCode !== 200) {
        throw new Error(`direct payment failed: ${res.statusCode} ${JSON.stringify(res.body)}`);
      }
      this.state.payments[paymentId] = {
        paidAt: now(), payee: payeeAddress, route: "direct", amount
      };
      this.persist();
      return { route: "direct", payee: payeeAddress, amount, response: res.body };
    }

    throw new Error(`Unknown channel type (key=${ch.key}).`);
  }

  listChannels() {
    const result = [];
    for (const [key, ch] of Object.entries(this.state.channels)) {
      result.push({ key, ...ch });
    }
    return result;
  }

  close() {
    this.http.close();
  }
}

module.exports = { ScpAgentClient };
