/* eslint-disable no-console */
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { verifyTicket } = require("../scp-hub/ticket");
const { HttpJsonClient } = require("../scp-common/http-client");
const { recoverChannelStateSigner } = require("../scp-hub/state-signing");

const DEFAULTS = {
  host: process.env.PAYEE_HOST || "127.0.0.1",
  port: Number(process.env.PAYEE_PORT || 4042),
  hubUrl: process.env.HUB_URL || "http://127.0.0.1:4021",
  network: process.env.NETWORK || "eip155:8453",
  asset: process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
  price: process.env.PRICE || "1000000",
  hubName: process.env.HUB_NAME || "pay.eth",
  resourcePath: "/v1/data",
  perfMode: process.env.PERF_MODE === "1",
  payeePrivateKey:
    process.env.PAYEE_PRIVATE_KEY ||
    "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555"
};
const defaultPayeeWallet = new ethers.Wallet(DEFAULTS.payeePrivateKey);
const PAYEE_ADDRESS = defaultPayeeWallet.address;
const RESOURCE_PATH = DEFAULTS.resourcePath;

function now() {
  return Math.floor(Date.now() / 1000);
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function make402(invoiceId, cfg, payeeAddress) {
  return {
    accepts: [
      {
        scheme: "statechannel-hub-v1",
        network: cfg.network,
        asset: cfg.asset,
        maxAmountRequired: cfg.price,
        payTo: cfg.hubName,
        resource: `http://${cfg.host}:${cfg.port}${cfg.resourcePath}`,
        extensions: {
          "statechannel-hub-v1": {
            hubName: cfg.hubName,
            hubEndpoint: cfg.hubUrl,
            mode: "proxy_hold",
            feeModel: { base: "10", bps: 30 },
            quoteExpiry: now() + 120,
            invoiceId,
            payeeAddress
          }
        }
      },
      {
        scheme: "statechannel-direct-v1",
        network: cfg.network,
        asset: cfg.asset,
        maxAmountRequired: cfg.price,
        payTo: payeeAddress,
        resource: `http://${cfg.host}:${cfg.port}${cfg.resourcePath}`,
        extensions: {
          "statechannel-direct-v1": {
            mode: "direct",
            quoteExpiry: now() + 120,
            invoiceId,
            payeeAddress
          }
        }
      }
    ]
  };
}

function parsePaymentHeader(req) {
  const raw = req.headers["payment-signature"] || req.headers["PAYMENT-SIGNATURE"];
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

async function validatePayment(paymentPayload, ctx) {
  const { cfg, payeeAddress, invoiceStore } = ctx;
  if (!paymentPayload) return { ok: false, error: "missing payment header" };
  if (paymentPayload.scheme !== "statechannel-hub-v1") {
    return { ok: false, error: "wrong scheme" };
  }
  if (!paymentPayload.paymentId || !paymentPayload.invoiceId || !paymentPayload.ticket) {
    return { ok: false, error: "missing payment fields" };
  }

  const ticket = paymentPayload.ticket;
  const recovered = verifyTicket(ticket);
  if (!recovered) return { ok: false, error: "invalid ticket signature" };

  let hubAddress = ctx.hubAddressCache;
  if (!hubAddress) {
    const hubInfo = await ctx.http.request("GET", `${cfg.hubUrl}/.well-known/x402`);
    if (hubInfo.statusCode !== 200 || !hubInfo.body.address) {
      return { ok: false, error: "hub metadata unavailable" };
    }
    hubAddress = hubInfo.body.address;
    ctx.hubAddressCache = hubAddress;
  }
  if (recovered.toLowerCase() !== hubAddress.toLowerCase()) {
    return { ok: false, error: "ticket signer mismatch" };
  }

  if (ticket.payee.toLowerCase() !== payeeAddress.toLowerCase()) {
    return { ok: false, error: "ticket payee mismatch" };
  }
  if (ticket.expiry < now()) return { ok: false, error: "ticket expired" };
  if (ticket.invoiceId !== paymentPayload.invoiceId) {
    return { ok: false, error: "invoice mismatch" };
  }
  if (ticket.paymentId !== paymentPayload.paymentId) {
    return { ok: false, error: "payment id mismatch" };
  }

  const inv = invoiceStore.get(paymentPayload.invoiceId);
  if (!inv) return { ok: false, error: "unknown invoice" };
  if (inv.amount !== ticket.amount) return { ok: false, error: "amount mismatch" };

  if (!cfg.perfMode) {
    const paymentStatus = await ctx.http.request(
      "GET",
      `${cfg.hubUrl}/v1/payments/${encodeURIComponent(paymentPayload.paymentId)}`
    );
    if (paymentStatus.statusCode !== 200) return { ok: false, error: "hub payment unknown" };
    if (paymentStatus.body.status !== "issued") {
      return { ok: false, error: "hub payment not issued" };
    }
    if (paymentStatus.body.ticketId !== ticket.ticketId) {
      return { ok: false, error: "ticket id mismatch at hub" };
    }
  }

  return { ok: true };
}

function validateDirectPayment(paymentPayload, ctx) {
  const { payeeAddress, invoiceStore, directChannels } = ctx;
  if (!paymentPayload || paymentPayload.scheme !== "statechannel-direct-v1") {
    return { ok: false, error: "wrong scheme" };
  }
  const dp = paymentPayload.direct;
  if (!dp || !dp.channelState || !dp.sigA || !dp.payer || !dp.amount || !dp.asset || !dp.payee) {
    return { ok: false, error: "missing direct payment fields" };
  }
  if (dp.payee.toLowerCase() !== payeeAddress.toLowerCase()) {
    return { ok: false, error: "direct payee mismatch" };
  }
  if (dp.invoiceId !== paymentPayload.invoiceId || dp.paymentId !== paymentPayload.paymentId) {
    return { ok: false, error: "direct id mismatch" };
  }
  if (dp.expiry < now()) return { ok: false, error: "direct payment expired" };

  const inv = invoiceStore.get(paymentPayload.invoiceId);
  if (!inv) return { ok: false, error: "unknown invoice" };
  if (inv.amount !== dp.amount) return { ok: false, error: "amount mismatch" };

  const signer = recoverChannelStateSigner(dp.channelState, dp.sigA);
  if (signer.toLowerCase() !== dp.payer.toLowerCase()) {
    return { ok: false, error: "payer signature mismatch" };
  }

  const channelId = dp.channelState.channelId;
  const prev = directChannels.get(channelId) || { nonce: 0, balB: "0" };
  const nextNonce = Number(dp.channelState.stateNonce);
  if (nextNonce <= Number(prev.nonce)) return { ok: false, error: "stale direct nonce" };
  const prevBalH = BigInt(prev.balB);
  const nextBalH = BigInt(dp.channelState.balB);
  const amount = BigInt(dp.amount);
  if (nextBalH - prevBalH < amount) {
    return { ok: false, error: "insufficient direct delta" };
  }
  if (dp.channelState.stateExpiry && Number(dp.channelState.stateExpiry) < now()) {
    return { ok: false, error: "state expired" };
  }

  directChannels.set(channelId, { nonce: nextNonce, balB: dp.channelState.balB });
  return { ok: true };
}

async function handle(req, res, ctx) {
  const { cfg, payeeAddress, invoiceStore, consumed } = ctx;
  const u = new URL(req.url, `http://${req.headers.host || `${cfg.host}:${cfg.port}`}`);
  if (req.method !== "GET" || u.pathname !== cfg.resourcePath) {
    return sendJson(res, 404, { error: "not found" });
  }

  const paymentPayload = parsePaymentHeader(req);
  if (!paymentPayload) {
    const invoiceId = randomId("inv");
    invoiceStore.set(invoiceId, {
      createdAt: now(),
      amount: cfg.price
    });
    return sendJson(res, 402, make402(invoiceId, cfg, payeeAddress));
  }

  if (consumed.has(paymentPayload.paymentId)) {
    return sendJson(res, 200, consumed.get(paymentPayload.paymentId));
  }

  let result;
  if (paymentPayload.scheme === "statechannel-direct-v1") {
    result = validateDirectPayment(paymentPayload, ctx);
  } else {
    result = await validatePayment(paymentPayload, ctx);
  }
  if (!result.ok) {
    return sendJson(res, 402, {
      error: result.error,
      retryable: false
    });
  }

  const receipt = {
    paymentId: paymentPayload.paymentId,
    receiptId: randomId("rcpt"),
    acceptedAt: now()
  };
  if (paymentPayload.scheme === "statechannel-direct-v1") {
    receipt.directChannelId = paymentPayload.direct.channelState.channelId;
  } else {
    receipt.ticketId = paymentPayload.ticket.ticketId;
  }
  const payload = {
    ok: true,
    data: {
      value: "premium-resource",
      payee: payeeAddress
    },
    receipt
  };
  consumed.set(paymentPayload.paymentId, payload);
  return sendJson(res, 200, payload);
}

function createPayeeServer(options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options
  };
  const payeeWallet = new ethers.Wallet(cfg.payeePrivateKey);
  const payeeAddress = payeeWallet.address;
  const invoiceStore = new Map();
  const consumed = new Map();
  const ctx = {
    cfg,
    payeeAddress,
    invoiceStore,
    consumed,
    directChannels: new Map(),
    hubAddressCache: null,
    http: new HttpJsonClient({ timeoutMs: 8000, maxSockets: 128 })
  };

  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });
  server.on("close", () => {
    ctx.http.close();
  });
  return server;
}

if (require.main === module) {
  const server = createPayeeServer();
  server.listen(DEFAULTS.port, DEFAULTS.host, () => {
    console.log(
      `Payee server listening on ${DEFAULTS.host}:${DEFAULTS.port} (${PAYEE_ADDRESS})`
    );
  });
}

module.exports = {
  createPayeeServer,
  PAYEE_ADDRESS,
  RESOURCE_PATH
};
