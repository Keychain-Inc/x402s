/* eslint-disable no-console */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { verifyTicket } = require("../scp-hub/ticket");
const { HttpJsonClient } = require("../scp-common/http-client");
const { recoverChannelStateSigner } = require("../scp-hub/state-signing");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4080);
const HUB_URL = process.env.HUB_URL || "http://127.0.0.1:4021";
const HUB_NAME = process.env.HUB_NAME || "pay.eth";
const NETWORK = process.env.NETWORK || "eip155:8453";
const ASSET = process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";
const PRICE = process.env.WEATHER_PRICE || "500000"; // 0.50 USDC or 500000 wei
const PAYEE_KEY = process.env.PAYEE_PRIVATE_KEY ||
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const payeeWallet = new ethers.Wallet(PAYEE_KEY);
const PAYEE_ADDRESS = payeeWallet.address;

// WMO weather codes → descriptions
const WMO_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"
};

function now() { return Math.floor(Date.now() / 1000); }
function randomId(p) { return `${p}_${crypto.randomBytes(10).toString("hex")}`; }

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

// --- Open-Meteo fetch (free, no API key) ---

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("parse: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`;
  const data = await httpsGet(url);
  if (!data.results || !data.results.length) return null;
  const r = data.results[0];
  return { name: r.name, country: r.country, lat: r.latitude, lon: r.longitude, timezone: r.timezone };
}

async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure` +
    `&temperature_unit=celsius&wind_speed_unit=kmh`;
  return httpsGet(url);
}

// --- Payment validation ---

function parsePaymentHeader(req) {
  const raw = req.headers["payment-signature"];
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_e) { return null; }
}

async function validatePayment(pp, ctx) {
  if (!pp) return { ok: false, error: "no payment" };

  if (pp.scheme === "statechannel-hub-v1") {
    const ticket = pp.ticket;
    if (!ticket) return { ok: false, error: "missing ticket" };
    const signer = verifyTicket(ticket);
    if (!signer) return { ok: false, error: "bad ticket sig" };

    let hubAddr = ctx.hubAddressCache;
    if (!hubAddr) {
      const meta = await ctx.http.request("GET", `${HUB_URL}/.well-known/x402`);
      if (meta.statusCode !== 200) return { ok: false, error: "hub unreachable" };
      hubAddr = meta.body.address;
      ctx.hubAddressCache = hubAddr;
    }
    if (signer.toLowerCase() !== hubAddr.toLowerCase()) return { ok: false, error: "signer mismatch" };
    if (ticket.payee.toLowerCase() !== PAYEE_ADDRESS.toLowerCase()) return { ok: false, error: "wrong payee" };
    if (ticket.expiry < now()) return { ok: false, error: "expired" };

    const inv = ctx.invoices.get(pp.invoiceId);
    if (!inv) return { ok: false, error: "unknown invoice" };
    if (inv.amount !== ticket.amount) return { ok: false, error: "amount mismatch" };

    const status = await ctx.http.request("GET", `${HUB_URL}/v1/payments/${encodeURIComponent(pp.paymentId)}`);
    if (status.statusCode !== 200 || status.body.status !== "issued") return { ok: false, error: "hub not issued" };

    return { ok: true };
  }

  if (pp.scheme === "statechannel-direct-v1") {
    const dp = pp.direct;
    if (!dp || !dp.channelState || !dp.sigA) return { ok: false, error: "missing direct fields" };
    if (dp.payee.toLowerCase() !== PAYEE_ADDRESS.toLowerCase()) return { ok: false, error: "wrong payee" };
    if (dp.expiry < now()) return { ok: false, error: "expired" };

    const inv = ctx.invoices.get(pp.invoiceId);
    if (!inv) return { ok: false, error: "unknown invoice" };

    const signer = recoverChannelStateSigner(dp.channelState, dp.sigA);
    if (signer.toLowerCase() !== dp.payer.toLowerCase()) return { ok: false, error: "bad payer sig" };

    const chId = dp.channelState.channelId;
    const prev = ctx.directChannels.get(chId) || { nonce: 0, balB: "0" };
    if (Number(dp.channelState.stateNonce) <= prev.nonce) return { ok: false, error: "stale nonce" };
    if (BigInt(dp.channelState.balB) - BigInt(prev.balB) < BigInt(dp.amount)) return { ok: false, error: "insufficient delta" };

    ctx.directChannels.set(chId, { nonce: Number(dp.channelState.stateNonce), balB: dp.channelState.balB });
    return { ok: true };
  }

  return { ok: false, error: "unknown scheme" };
}

// --- Request handler ---

async function handle(req, res, ctx) {
  const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  // Health check
  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, { ok: true, payee: PAYEE_ADDRESS });
  }

  // Weather endpoint
  if (req.method === "GET" && u.pathname === "/weather") {
    const city = u.searchParams.get("city");
    if (!city) return sendJson(res, 400, { error: "city parameter required" });

    // No payment header → 402
    const pp = parsePaymentHeader(req);
    if (!pp) {
      const invoiceId = randomId("inv");
      ctx.invoices.set(invoiceId, { createdAt: now(), amount: PRICE, city });
      return sendJson(res, 402, {
        message: "Payment required for weather data",
        city,
        price: PRICE,
        accepts: [
          {
            scheme: "statechannel-hub-v1",
            network: NETWORK,
            asset: ASSET,
            maxAmountRequired: PRICE,
            payTo: HUB_NAME,
            resource: `http://${HOST}:${PORT}/weather?city=${encodeURIComponent(city)}`,
            extensions: {
              "statechannel-hub-v1": {
                hubName: HUB_NAME,
                hubEndpoint: HUB_URL,
                mode: "proxy_hold",
                feeModel: { base: "10", bps: 30 },
                quoteExpiry: now() + 120,
                invoiceId,
                payeeAddress: PAYEE_ADDRESS
              }
            }
          },
          {
            scheme: "statechannel-direct-v1",
            network: NETWORK,
            asset: ASSET,
            maxAmountRequired: PRICE,
            payTo: PAYEE_ADDRESS,
            resource: `http://${HOST}:${PORT}/weather?city=${encodeURIComponent(city)}`,
            extensions: {
              "statechannel-direct-v1": {
                mode: "direct",
                quoteExpiry: now() + 120,
                invoiceId,
                payeeAddress: PAYEE_ADDRESS
              }
            }
          }
        ]
      });
    }

    // Validate payment
    const result = await validatePayment(pp, ctx);
    if (!result.ok) return sendJson(res, 402, { error: result.error, retryable: false });

    // Payment valid → fetch and return weather
    const geo = await geocode(city);
    if (!geo) return sendJson(res, 404, { error: "city not found", city });

    const weather = await fetchWeather(geo.lat, geo.lon);
    const cur = weather.current;

    return sendJson(res, 200, {
      ok: true,
      location: {
        city: geo.name,
        country: geo.country,
        lat: geo.lat,
        lon: geo.lon,
        timezone: geo.timezone
      },
      current: {
        temperature: cur.temperature_2m,
        feelsLike: cur.apparent_temperature,
        humidity: cur.relative_humidity_2m,
        precipitation: cur.precipitation,
        condition: WMO_CODES[cur.weather_code] || `code ${cur.weather_code}`,
        weatherCode: cur.weather_code,
        wind: {
          speed: cur.wind_speed_10m,
          gusts: cur.wind_gusts_10m,
          direction: cur.wind_direction_10m
        },
        pressure: cur.surface_pressure
      },
      units: weather.current_units,
      receipt: {
        paymentId: pp.paymentId,
        receiptId: randomId("rcpt"),
        acceptedAt: now()
      }
    });
  }

  return sendJson(res, 404, { error: "not found. use GET /weather?city=London" });
}

function createWeatherServer(options = {}) {
  const ctx = {
    invoices: new Map(),
    directChannels: new Map(),
    hubAddressCache: null,
    http: new HttpJsonClient({ timeoutMs: 8000, maxSockets: 64 })
  };
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });
  server.on("close", () => ctx.http.close());
  return server;
}

if (require.main === module) {
  const server = createWeatherServer();
  server.listen(PORT, HOST, () => {
    console.log(`Weather API on ${HOST}:${PORT} (payee: ${PAYEE_ADDRESS})`);
    console.log(`  GET /weather?city=London → 402 (pay via x402)`);
    console.log(`  Hub: ${HUB_URL}`);
  });
}

module.exports = { createWeatherServer, PAYEE_ADDRESS };
