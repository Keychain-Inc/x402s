/* eslint-disable no-console */
/**
 * SCP Chat API — pay 0.01 USDC or 0.00001 ETH per message
 * Usage: PAYEE_PRIVATE_KEY=0x... [CHAT_NETWORK=base|sepolia] node chat-server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { createVerifier } = require("../scp-hub/ticket");
const { resolveHubEndpointForNetwork, toCaip2, resolveAsset } = require("../scp-common/networks");

const CHAT_NETWORK = process.env.CHAT_NETWORK || "base";
const NETWORK = toCaip2(CHAT_NETWORK) || "eip155:8453";
const CHAIN_ID = Number(NETWORK.split(":")[1]);
const PORT = Number(process.env.CHAT_PORT || 4044);
const HUB_URL = process.env.HUB_URL || resolveHubEndpointForNetwork(NETWORK);
const PAYEE_KEY = process.env.PAYEE_PRIVATE_KEY;
if (!PAYEE_KEY) { console.error("FATAL: PAYEE_PRIVATE_KEY required"); process.exit(1); }
const payeeWallet = new ethers.Wallet(PAYEE_KEY);
const PAYEE_ADDR = payeeWallet.address;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PUBLIC_HUB = process.env.PUBLIC_HUB || HUB_URL;

// --- Offer config: OFFERS_FILE > env > defaults ---
function loadOfferConfig() {
  const offersFile = process.env.OFFERS_FILE;
  if (offersFile) {
    const fp = path.isAbsolute(offersFile) ? offersFile : path.resolve(__dirname, "../../", offersFile);
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    const block = (parsed.offers || []).find(o => {
      const nets = [].concat(o.network || []);
      return nets.some(n => n === CHAT_NETWORK || toCaip2(n) === NETWORK);
    });
    const pp = (parsed.pathPrices || {})["/chat"] || {};
    const assets = [].concat(block?.asset || []);
    const amounts = [].concat(block?.maxAmountRequired || []);
    const stream = block?.stream || { t: 1 };
    const hub = block?.hubEndpoint || PUBLIC_HUB;
    const hubName = block?.hubName || "pay.eth";

    // Resolve asset symbols to addresses + raw amounts
    const offers = [];
    for (let i = 0; i < assets.length; i++) {
      const sym = assets[i].toLowerCase();
      const human = pp[sym] || amounts[i] || "0";
      let addr, rawAmount, label;
      if (sym === "eth" || sym === "ether") {
        addr = ZERO_ADDR;
        rawAmount = ethers.utils.parseEther(human).toString();
        label = "ETH";
      } else {
        try {
          const resolved = resolveAsset(CHAIN_ID, sym);
          addr = resolved.address;
          rawAmount = ethers.utils.parseUnits(human, resolved.decimals).toString();
          label = sym.toUpperCase();
        } catch (_e) {
          console.warn("[chat] skipping unknown asset:", sym);
          continue;
        }
      }
      offers.push({ addr, rawAmount, label, stream, hub, hubName });
    }
    if (offers.length) return offers;
  }
  // Fallback: hardcoded defaults
  let usdcAddr;
  try { usdcAddr = resolveAsset(CHAIN_ID, "usdc").address; }
  catch (_e) { usdcAddr = "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913"; }
  return [
    { addr: ZERO_ADDR, rawAmount: "10000000000000", label: "ETH", stream: { t: 1 }, hub: PUBLIC_HUB, hubName: "pay.eth" },
    { addr: usdcAddr, rawAmount: "10000", label: "USDC", stream: { t: 1 }, hub: PUBLIC_HUB, hubName: "pay.eth" }
  ];
}

const OFFER_ASSETS = loadOfferConfig();
const PRICE_LABEL = OFFER_ASSETS.map(o => {
  const dec = o.addr === ZERO_ADDR ? 18 : 6;
  return ethers.utils.formatUnits(o.rawAmount, dec) + " " + o.label;
}).join(" or ");

// Chat state
const messages = [];
const MAX_MESSAGES = 200;

// Invoice store
const invoices = new Map();
const INVOICE_TTL = 300_000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of invoices) if (now - v.ts > INVOICE_TTL) invoices.delete(k);
}, 60_000);

function randomId(pfx = "inv") {
  return pfx + "_" + crypto.randomBytes(12).toString("base64url");
}

function makeOffers(path, req) {
  const invId = randomId("inv");
  invoices.set(invId, { ts: Date.now(), path, assets: OFFER_ASSETS });

  // Use public URL from env or reconstruct from request headers
  let base = PUBLIC_URL;
  if (!base && req) {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers["x-forwarded-host"] || req.headers["host"] || `127.0.0.1:${PORT}`;
    const prefix = req.headers["x-forwarded-prefix"] || "";
    base = `${proto}://${host}${prefix}`;
  }
  if (!base) base = `http://127.0.0.1:${PORT}`;
  const resource = `${base}${path}`;

  return {
    error: "payment required",
    message: `Send a chat message (${PRICE_LABEL} on ${CHAT_NETWORK})`,
    accepts: OFFER_ASSETS.map(o => ({
      scheme: "statechannel-hub-v1",
      network: NETWORK,
      asset: o.addr,
      maxAmountRequired: o.rawAmount,
      label: o.label,
      resource,
      extensions: {
        "statechannel-hub-v1": {
          hubName: o.hubName,
          hubEndpoint: o.hub,
          payeeAddress: PAYEE_ADDR,
          invoiceId: invId,
          stream: { amount: o.rawAmount, ...o.stream }
        }
      }
    }))
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Payment-Signature, X-SCP-Access-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function getPaymentHeader(req) {
  return req.headers["payment-signature"] || req.headers["x-scp-signature"] || null;
}

// Setup verifier
const consumed = new Map();
const verify = createVerifier({
  payee: PAYEE_ADDR,
  hubUrl: HUB_URL,
  hubs: [HUB_URL],
  confirmHub: true,
  seenPayments: consumed
});

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // GET /chat — read messages (free)
  if (u.pathname === "/chat" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, messages: messages.slice(-50) });
  }

  // POST /chat — send message (paid)
  if (u.pathname === "/chat" && req.method === "POST") {
    const rawHeader = getPaymentHeader(req);

    if (!rawHeader) {
      return sendJson(res, 402, makeOffers("/chat", req));
    }

    // Parse body
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: "invalid JSON body" }); }
    const msg = String(parsed.message || "").trim();
    if (!msg) return sendJson(res, 400, { error: "message is required" });
    if (msg.length > 500) return sendJson(res, 400, { error: "message too long (max 500 chars)" });

    // Verify payment
    const invoiceLookup = (invoiceId) => {
      const inv = invoices.get(invoiceId);
      return !!inv;
    };

    let result;
    try {
      result = await verify(rawHeader, invoiceLookup);
    } catch (e) {
      return sendJson(res, 402, { error: "verification failed: " + e.message });
    }

    if (result.replayed) return sendJson(res, 200, result.response);
    if (!result.ok) return sendJson(res, 402, { error: result.error, retryable: false });

    // Payment verified — store message
    const entry = {
      id: randomId("msg"),
      from: result.payer || "anon",
      message: msg,
      ts: Date.now(),
      paymentId: result.paymentId
    };
    messages.push(entry);
    if (messages.length > MAX_MESSAGES) messages.shift();

    const response = { ok: true, data: entry, receipt: { paymentId: result.paymentId } };
    consumed.set(result.paymentId, { response, ts: Date.now() });

    console.log(`[chat] ${entry.from.slice(0, 10)}...: "${msg}" (${result.paymentId})`);
    return sendJson(res, 200, response);
  }

  // GET /pay — offer discovery for agent clients
  if (u.pathname === "/pay" && req.method === "GET") {
    return sendJson(res, 402, makeOffers("/chat", req));
  }

  // GET / — info
  if (u.pathname === "/") {
    return sendJson(res, 200, {
      service: "SCP Chat",
      network: CHAT_NETWORK,
      pricing: PRICE_LABEL,
      endpoints: { read: "GET /chat (free)", send: "POST /chat (paid)" },
      hub: HUB_URL,
      payee: PAYEE_ADDR
    });
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[SCP Chat] listening on http://127.0.0.1:${PORT}`);
  console.log(`[SCP Chat] network: ${CHAT_NETWORK} (${NETWORK})`);
  console.log(`[SCP Chat] payee: ${PAYEE_ADDR}`);
  console.log(`[SCP Chat] hub: ${HUB_URL}`);
  console.log(`[SCP Chat] pricing: ${PRICE_LABEL} per message`);
  console.log(`[SCP Chat] GET /chat (free) | POST /chat (paid)`);
});
