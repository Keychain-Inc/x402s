/* eslint-disable no-console */
const http = require("http");
const url = require("url");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const cluster = require("cluster");
const { ethers } = require("ethers");
const { Storage } = require("./storage");
const { buildValidators, validationMessage } = require("./validator");
const { signTicketDraft } = require("./ticket");
const { signChannelState, hashChannelState } = require("./state-signing");

const PORT = Number(process.env.PORT || 4021);
const HOST = process.env.HOST || "127.0.0.1";
const HUB_NAME = process.env.HUB_NAME || "pay.eth";
const CHAIN_ID = Number(process.env.CHAIN_ID || 8453);
const SIG_FORMAT = "eth_sign";
const PRIVATE_KEY =
  process.env.HUB_PRIVATE_KEY ||
  "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
const wallet = new ethers.Wallet(PRIVATE_KEY);
const HUB_ADDRESS = wallet.address;
const DEFAULT_ASSET =
  process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";
const FEE_BASE = BigInt(process.env.FEE_BASE || "10");
const FEE_BPS = BigInt(process.env.FEE_BPS || "30");
const GAS_SURCHARGE = BigInt(process.env.GAS_SURCHARGE || "0");
const RPC_URL = process.env.RPC_URL || "";
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || "";
const CHANNEL_ABI = [
  "function openChannel(address hub, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)"
];
const STORE_PATH = process.env.STORE_PATH || path.resolve(__dirname, "./data/store.json");
const WORKERS = Number(process.env.HUB_WORKERS || 0);

// Provider + funded wallet for on-chain settlement (lazy init)
let hubSigner = null;
function getHubSigner() {
  if (hubSigner) return hubSigner;
  if (!RPC_URL) return null;
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  hubSigner = wallet.connect(provider);
  return hubSigner;
}

const store = new Storage(STORE_PATH);
const validate = buildValidators();

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1024 * 1024) {
        reject(new Error("payload too large"));
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isHex32(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{64}$/.test(v);
}

function isHexAddress(v) {
  return typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function calcFee(amountStr) {
  const amount = BigInt(amountStr);
  const variable = (amount * FEE_BPS) / 10000n;
  const fee = FEE_BASE + variable + GAS_SURCHARGE;
  return {
    fee,
    breakdown: {
      base: FEE_BASE.toString(),
      bps: Number(FEE_BPS),
      variable: variable.toString(),
      gasSurcharge: GAS_SURCHARGE.toString()
    }
  };
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function policyHash(obj) {
  const enc = JSON.stringify(obj);
  return ethers.utils.keccak256(Buffer.from(enc, "utf8"));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

const ZERO32 = "0x" + "0".repeat(64);

function makeError(code, message, retryable = false) {
  return { errorCode: code, message, retryable };
}

async function handleRequest(req, res) {
  const { pathname } = url.parse(req.url, true);

  try {
    if (req.method === "GET" && pathname === "/.well-known/x402") {
      return sendJson(res, 200, {
        hubName: HUB_NAME,
        address: HUB_ADDRESS,
        chainId: CHAIN_ID,
        schemes: ["statechannel-hub-v1"],
        supportedAssets: [DEFAULT_ASSET, ethers.constants.AddressZero],
        modes: ["proxy_hold", "peer_simple"],
        signature: {
          format: SIG_FORMAT,
          keyId: "hub-main-1",
          publicKey: HUB_ADDRESS
        },
        feePolicy: {
          base: FEE_BASE.toString(),
          bps: Number(FEE_BPS),
          gasSurcharge: GAS_SURCHARGE.toString()
        }
      });
    }

    if (req.method === "POST" && pathname === "/v1/tickets/quote") {
      const body = await parseBody(req);
      if (!validate.quoteRequest(body)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.quoteRequest))
        );
      }
      if (typeof body.quoteExpiry !== "number" || body.quoteExpiry <= now()) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", "quoteExpiry must be future unix ts")
        );
      }

      const { fee, breakdown } = calcFee(body.amount);
      const maxFee = BigInt(body.maxFee);
      if (fee > maxFee) {
        return sendJson(res, 400, makeError("SCP_003_FEE_EXCEEDS_MAX", "fee > maxFee"));
      }

      const amount = BigInt(body.amount);
      const totalDebit = amount + fee;
      const expiry = Math.min(body.quoteExpiry, now() + 120);
      const ticketDraft = {
        ticketId: randomId("tkt"),
        hub: HUB_ADDRESS,
        payee: body.payee,
        invoiceId: body.invoiceId,
        paymentId: body.paymentId,
        asset: body.asset,
        amount: body.amount,
        feeCharged: fee.toString(),
        totalDebit: totalDebit.toString(),
        expiry,
        policyHash: policyHash({
          channelId: body.channelId,
          chainId: CHAIN_ID,
          paymentMemo: body.paymentMemo || ""
        })
      };

      const quote = {
        invoiceId: body.invoiceId,
        paymentId: body.paymentId,
        ticketDraft,
        fee: fee.toString(),
        totalDebit: totalDebit.toString(),
        expiry,
        feeBreakdown: breakdown
      };
      if (!validate.quoteResponse(quote)) {
        return sendJson(
          res,
          500,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.quoteResponse), true)
        );
      }

      await store.tx((s) => {
        s.quotes[`${body.invoiceId}:${body.paymentId}`] = {
          quote,
          channelId: body.channelId,
          createdAt: now()
        };
        s.payments[body.paymentId] = {
          paymentId: body.paymentId,
          status: "quoted"
        };
      });

      return sendJson(res, 200, quote);
    }

    if (req.method === "POST" && pathname === "/v1/tickets/issue") {
      const body = await parseBody(req);
      if (!validate.issueRequest(body)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.issueRequest))
        );
      }

      const quote = body.quote;
      const key = `${quote.invoiceId}:${quote.paymentId}`;
      const stored = await store.getQuote(key);
      if (!stored) return sendJson(res, 409, makeError("SCP_002_QUOTE_EXPIRED", "quote not found"));

      if (quote.expiry < now()) {
        return sendJson(res, 409, makeError("SCP_002_QUOTE_EXPIRED", "quote expired"));
      }
      if (body.channelState.channelId !== stored.channelId) {
        return sendJson(res, 409, makeError("SCP_009_POLICY_VIOLATION", "channel mismatch"));
      }

      const ticket = { ...quote.ticketDraft, sig: await signTicketDraft(quote.ticketDraft, wallet) };
      if (!validate.ticket(ticket)) {
        return sendJson(
          res,
          500,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.ticket), true)
        );
      }

      const sigB = await signChannelState(body.channelState, wallet);
      const channelAck = {
        stateNonce: body.channelState.stateNonce,
        stateHash: hashChannelState(body.channelState),
        sigB
      };

      await store.tx((s) => {
        s.payments[quote.paymentId] = {
          paymentId: quote.paymentId,
          status: "issued",
          ticketId: ticket.ticketId,
          stateNonce: body.channelState.stateNonce
        };
        s.channels[body.channelState.channelId] = {
          channelId: body.channelState.channelId,
          latestNonce: body.channelState.stateNonce,
          status: "open",
          latestState: body.channelState,
          sigA: body.sigA,
          sigB
        };
        const payee = String(ticket.payee || "").toLowerCase();
        if (!s.payeeLedger[payee]) s.payeeLedger[payee] = [];
        const seq = Number(s.nextSeq || 1);
        s.payeeLedger[payee].push({
          seq,
          createdAt: now(),
          paymentId: quote.paymentId,
          invoiceId: quote.invoiceId,
          ticketId: ticket.ticketId,
          amount: ticket.amount,
          asset: ticket.asset,
          status: "issued"
        });
        s.nextSeq = seq + 1;
      });

      // Update Hub↔Payee channel state (if open)
      let hubChannelAck = null;
      const payeeKey = String(ticket.payee || "").toLowerCase();
      const hc = await store.getHubChannel(payeeKey);
      if (hc && hc.channelId) {
        const paymentAmount = BigInt(ticket.amount);
        const newBalA = (BigInt(hc.balA) - paymentAmount).toString();
        const newBalH = (BigInt(hc.balB) + paymentAmount).toString();
        const newNonce = hc.nonce + 1;
        const hcState = {
          channelId: hc.channelId,
          stateNonce: newNonce,
          balA: newBalA,
          balB: newBalH,
          locksRoot: ZERO32,
          stateExpiry: now() + 3600,
          contextHash: body.channelState.contextHash || ZERO32
        };
        const hcSigA = await signChannelState(hcState, wallet);
        hc.balA = newBalA;
        hc.balB = newBalH;
        hc.nonce = newNonce;
        hc.latestState = hcState;
        hc.sigA = hcSigA;
        await store.setHubChannel(payeeKey, hc);
        hubChannelAck = { channelId: hc.channelId, stateNonce: newNonce, balB: newBalH, sigA: hcSigA };
      }

      return sendJson(res, 200, {
        ...ticket,
        channelAck,
        ...(hubChannelAck ? { hubChannelAck } : {})
      });
    }

    if (req.method === "POST" && pathname === "/v1/refunds") {
      const body = await parseBody(req);
      if (!validate.refundRequest(body)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", validationMessage(validate.refundRequest))
        );
      }

      const stateNonce = Math.floor(Math.random() * 1000000) + 1;
      return sendJson(res, 200, {
        ticketId: body.ticketId,
        stateNonce,
        receiptId: randomId("rfd")
      });
    }

    if (req.method === "GET" && pathname.startsWith("/v1/payments/")) {
      const paymentId = pathname.split("/").pop();
      const payment = await store.getPayment(paymentId);
      if (!payment) return sendJson(res, 404, makeError("SCP_007_CHANNEL_NOT_FOUND", "payment not found"));
      return sendJson(res, 200, payment);
    }

    if (req.method === "GET" && pathname.startsWith("/v1/channels/")) {
      const channelId = pathname.split("/").pop();
      if (!isHex32(channelId)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "invalid channel id"));
      }
      const ch = (await store.getChannel(channelId)) || {
        channelId,
        latestNonce: 0,
        status: "open"
      };
      return sendJson(res, 200, ch);
    }

    if (req.method === "GET" && pathname === "/v1/payee/inbox") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      const since = Number((parsed.query && parsed.query.since) || 0);
      const limitRaw = Number((parsed.query && parsed.query.limit) || 50);
      const limit = Math.min(Math.max(limitRaw, 1), 500);
      if (!isHexAddress(payee)) {
        return sendJson(
          res,
          400,
          makeError("SCP_009_POLICY_VIOLATION", "payee query must be 0x address")
        );
      }
      const ledger = await store.getLedger(payee);
      const items = ledger.filter((x) => Number(x.seq) > since).slice(0, limit);
      const nextCursor = items.length ? Number(items[items.length - 1].seq) : since;
      return sendJson(res, 200, {
        payee,
        since,
        count: items.length,
        nextCursor,
        items
      });
    }

    if (req.method === "GET" && pathname === "/v1/agent/summary") {
      const parsed = url.parse(req.url, true);
      const channelId = parsed.query && parsed.query.channelId;
      if (!channelId || !isHex32(channelId)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "channelId required"));
      }
      const ch = await store.getChannel(channelId);
      if (!ch) {
        return sendJson(res, 200, { channelId, payments: 0, totalSpent: "0", totalFees: "0", latestNonce: 0 });
      }
      // Scan payments for this channel
      const allPayments = [];
      let totalSpent = 0n;
      let totalFees = 0n;
      const state = store.state || {};
      const payments = state.payments || {};
      for (const [pid, p] of Object.entries(payments)) {
        if (p.stateNonce && p.status === "issued") {
          // Find matching quote
          const quotes = state.quotes || {};
          for (const [, q] of Object.entries(quotes)) {
            if (q.channelId === channelId && q.quote && q.quote.paymentId === pid) {
              const amount = BigInt(q.quote.ticketDraft.amount);
              const fee = BigInt(q.quote.ticketDraft.feeCharged);
              totalSpent += amount;
              totalFees += fee;
              allPayments.push({
                paymentId: pid,
                amount: amount.toString(),
                fee: fee.toString(),
                payee: q.quote.ticketDraft.payee,
                ticketId: p.ticketId
              });
              break;
            }
          }
        }
      }
      return sendJson(res, 200, {
        channelId,
        latestNonce: ch.latestNonce,
        payments: allPayments.length,
        totalSpent: totalSpent.toString(),
        totalFees: totalFees.toString(),
        totalDebit: (totalSpent + totalFees).toString(),
        items: allPayments
      });
    }

    if (req.method === "GET" && pathname === "/v1/payee/balance") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      const ledger = await store.getLedger(payee);
      let earned = 0n;
      let settled = 0n;
      for (const entry of ledger) {
        earned += BigInt(entry.amount);
        if (entry.status === "settled") settled += BigInt(entry.amount);
      }
      return sendJson(res, 200, {
        payee,
        earned: earned.toString(),
        settled: settled.toString(),
        unsettled: (earned - settled).toString(),
        payments: ledger.length
      });
    }

    // --- Hub↔Payee channel management ---

    if (req.method === "POST" && pathname === "/v1/hub/open-payee-channel") {
      const body = await parseBody(req);
      const payee = String(body.payee || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      const signer = getHubSigner();
      if (!signer || !CONTRACT_ADDRESS) {
        return sendJson(res, 503, makeError("SCP_010_SETTLEMENT_UNAVAILABLE", "hub has no on-chain provider or contract (set RPC_URL, CONTRACT_ADDRESS)", true));
      }
      const existing = await store.getHubChannel(payee);
      if (existing && existing.channelId) {
        return sendJson(res, 200, { channelId: existing.channelId, message: "already open", ...existing });
      }
      const asset = body.asset || ethers.constants.AddressZero;
      const deposit = BigInt(body.deposit || "0");
      const challengePeriod = Number(body.challengePeriodSec || 300);
      const expiry = Number(body.channelExpiry || now() + 86400);
      const salt = ethers.utils.formatBytes32String(`hb-${now()}-${payee.slice(2, 8)}`);

      try {
        const contract = new ethers.Contract(CONTRACT_ADDRESS, CHANNEL_ABI, signer);
        const txOpts = asset === ethers.constants.AddressZero
          ? { value: deposit, gasLimit: 200000 }
          : { gasLimit: 200000 };
        const tx = await contract.openChannel(
          ethers.utils.getAddress(payee), asset, deposit,
          challengePeriod, expiry, salt, txOpts
        );
        const rc = await tx.wait(1);
        const ev = rc.events.find(e => e.event === "ChannelOpened");
        const channelId = ev.args.channelId;
        const hubChannel = {
          channelId,
          payee: ethers.utils.getAddress(payee),
          asset,
          totalDeposit: deposit.toString(),
          balA: deposit.toString(),
          balB: "0",
          nonce: 0,
          latestState: null,
          sigA: null,
          txHash: tx.hash
        };
        await store.setHubChannel(payee, hubChannel);
        return sendJson(res, 200, hubChannel);
      } catch (err) {
        return sendJson(res, 500, makeError("SCP_011_SETTLEMENT_FAILED", err.message || "open channel failed", true));
      }
    }

    if (req.method === "POST" && pathname === "/v1/hub/register-payee-channel") {
      const body = await parseBody(req);
      const payee = String(body.payee || "").toLowerCase();
      if (!isHexAddress(payee) || !body.channelId) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee and channelId required"));
      }
      const existing = await store.getHubChannel(payee);
      if (existing && existing.channelId) {
        return sendJson(res, 200, { message: "already registered", ...existing });
      }
      const hubChannel = {
        channelId: body.channelId,
        payee: ethers.utils.getAddress(payee),
        asset: body.asset || ethers.constants.AddressZero,
        totalDeposit: body.totalDeposit || "0",
        balA: body.totalDeposit || "0",
        balB: "0",
        nonce: 0,
        latestState: null,
        sigA: null
      };
      await store.setHubChannel(payee, hubChannel);
      return sendJson(res, 200, hubChannel);
    }

    if (req.method === "GET" && pathname === "/v1/payee/channel-state") {
      const parsed = url.parse(req.url, true);
      const payee = String((parsed.query && parsed.query.payee) || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      const hc = await store.getHubChannel(payee);
      if (!hc || !hc.channelId) {
        return sendJson(res, 404, makeError("SCP_007_CHANNEL_NOT_FOUND", "no hub channel for this payee"));
      }
      return sendJson(res, 200, {
        channelId: hc.channelId,
        payee: hc.payee,
        asset: hc.asset,
        totalDeposit: hc.totalDeposit,
        balA: hc.balA,
        balB: hc.balB,
        nonce: hc.nonce,
        latestState: hc.latestState,
        sigA: hc.sigA
      });
    }

    if (req.method === "POST" && pathname === "/v1/payee/settle") {
      const body = await parseBody(req);
      const payee = String(body.payee || "").toLowerCase();
      if (!isHexAddress(payee)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payee must be 0x address"));
      }
      const signer = getHubSigner();
      if (!signer) {
        return sendJson(res, 503, makeError("SCP_010_SETTLEMENT_UNAVAILABLE", "hub has no on-chain provider (set RPC_URL)", true));
      }
      const asset = String(body.asset || ethers.constants.AddressZero);

      // Sum unsettled amounts
      const ledger = await store.getLedger(payee);
      let unsettled = 0n;
      const unsettledEntries = [];
      for (const entry of ledger) {
        if (entry.status === "issued") {
          unsettled += BigInt(entry.amount);
          unsettledEntries.push(entry);
        }
      }
      if (unsettled === 0n) {
        return sendJson(res, 200, { payee, amount: "0", message: "nothing to settle" });
      }

      // Send on-chain
      let txHash;
      try {
        if (asset === ethers.constants.AddressZero) {
          const tx = await signer.sendTransaction({
            to: ethers.utils.getAddress(payee),
            value: unsettled,
            gasLimit: 21000
          });
          await tx.wait(1);
          txHash = tx.hash;
        } else {
          const erc20 = new ethers.Contract(
            asset,
            ["function transfer(address to, uint256 amount) returns (bool)"],
            signer
          );
          const tx = await erc20.transfer(ethers.utils.getAddress(payee), unsettled, { gasLimit: 60000 });
          await tx.wait(1);
          txHash = tx.hash;
        }
      } catch (err) {
        return sendJson(res, 500, makeError("SCP_011_SETTLEMENT_FAILED", err.message || "tx failed", true));
      }

      // Mark entries as settled
      await store.tx((s) => {
        const entries = s.payeeLedger[payee] || [];
        for (const entry of entries) {
          if (entry.status === "issued") {
            entry.status = "settled";
            entry.settleTx = txHash;
            entry.settledAt = now();
          }
        }
      });

      return sendJson(res, 200, {
        payee,
        amount: unsettled.toString(),
        asset,
        txHash,
        settledCount: unsettledEntries.length
      });
    }

    return sendJson(res, 404, makeError("SCP_009_POLICY_VIOLATION", "route not found"));
  } catch (err) {
    return sendJson(res, 500, makeError("SCP_009_POLICY_VIOLATION", err.message || "internal error", true));
  }
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res);
  });
}

// --- Cluster mode ---

function startCluster(numWorkers) {
  const cpus = os.cpus().length;
  const n = numWorkers > 0 ? numWorkers : cpus;

  if (cluster.isMaster) {
    console.log(`SCP hub master pid=${process.pid}, spawning ${n} workers`);
    for (let i = 0; i < n; i++) cluster.fork();
    cluster.on("exit", (w, code) => {
      console.log(`worker ${w.process.pid} exited (${code}), restarting`);
      cluster.fork();
    });
  } else {
    const server = createServer();
    server.listen(PORT, HOST, () => {
      console.log(`SCP hub worker pid=${process.pid} on ${HOST}:${PORT} as ${HUB_NAME} (${HUB_ADDRESS})`);
    });
  }
}

if (require.main === module) {
  if (WORKERS > 1 || process.env.HUB_CLUSTER === "1") {
    startCluster(WORKERS);
  } else {
    const server = createServer();
    server.listen(PORT, HOST, () => {
      console.log(`SCP hub listening on ${HOST}:${PORT} as ${HUB_NAME} (${HUB_ADDRESS})`);
    });
  }
}

module.exports = {
  createServer,
  handleRequest
};
