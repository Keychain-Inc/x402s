const fs = require("fs");
const path = require("path");

const LEDGER_MAX = 10000;
const QUOTE_TTL_SEC = 300;

function emptyState() {
  return {
    quotes: {},
    payments: {},
    channels: {},
    payeeLedger: {},
    nextSeq: 1
  };
}

// --- Memory backend (default for tests / perf mode) ---

class MemoryBackend {
  constructor() {
    this.state = emptyState();
  }
  async get(collection, key) {
    return (this.state[collection] || {})[key] || null;
  }
  async set(collection, key, value) {
    if (!this.state[collection]) this.state[collection] = {};
    this.state[collection][key] = value;
  }
  async incr(key) {
    const v = (this.state[key] || 0) + 1;
    this.state[key] = v;
    return v;
  }
  async getSeq() {
    return this.state.nextSeq || 1;
  }
  async getLedger(payee) {
    return (this.state.payeeLedger || {})[payee] || [];
  }
  async appendLedger(payee, entry) {
    if (!this.state.payeeLedger) this.state.payeeLedger = {};
    if (!this.state.payeeLedger[payee]) this.state.payeeLedger[payee] = [];
    this.state.payeeLedger[payee].push(entry);
    if (this.state.payeeLedger[payee].length > LEDGER_MAX) {
      this.state.payeeLedger[payee] = this.state.payeeLedger[payee].slice(-LEDGER_MAX);
    }
  }
  async close() {}
}

// --- JSON file backend (dev / single-instance) ---

class JsonFileBackend {
  constructor(filePath) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this._saveChain = Promise.resolve();
    this.state = emptyState();
    this._load();
  }

  _load() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this._flush();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        quotes: parsed.quotes || {},
        payments: parsed.payments || {},
        channels: parsed.channels || {},
        payeeLedger: parsed.payeeLedger || {},
        nextSeq: parsed.nextSeq || 1
      };
    } catch (_err) {
      this.state = emptyState();
      this._flush();
    }
  }

  _flush() {
    const payload = JSON.stringify(this.state);
    this._saveChain = this._saveChain.then(async () => {
      await fs.promises.writeFile(this.tmpPath, payload, "utf8");
      await fs.promises.rename(this.tmpPath, this.filePath);
    });
    return this._saveChain;
  }

  async get(collection, key) {
    return (this.state[collection] || {})[key] || null;
  }
  async set(collection, key, value) {
    if (!this.state[collection]) this.state[collection] = {};
    this.state[collection][key] = value;
    return this._flush();
  }
  async incr(key) {
    const v = (this.state[key] || 0) + 1;
    this.state[key] = v;
    this._flush();
    return v;
  }
  async getSeq() {
    return this.state.nextSeq || 1;
  }
  async getLedger(payee) {
    return (this.state.payeeLedger || {})[payee] || [];
  }
  async appendLedger(payee, entry) {
    if (!this.state.payeeLedger) this.state.payeeLedger = {};
    if (!this.state.payeeLedger[payee]) this.state.payeeLedger[payee] = [];
    this.state.payeeLedger[payee].push(entry);
    if (this.state.payeeLedger[payee].length > LEDGER_MAX) {
      this.state.payeeLedger[payee] = this.state.payeeLedger[payee].slice(-LEDGER_MAX);
    }
    return this._flush();
  }
  async close() {}
}

// --- Redis backend (production / multi-instance) ---

class RedisBackend {
  constructor(redisClient) {
    this.r = redisClient;
  }
  async get(collection, key) {
    const raw = await this.r.hget(`scp:${collection}`, key);
    return raw ? JSON.parse(raw) : null;
  }
  async set(collection, key, value) {
    await this.r.hset(`scp:${collection}`, key, JSON.stringify(value));
  }
  async incr(_key) {
    return this.r.hincrby("scp:meta", "nextSeq", 1);
  }
  async getSeq() {
    const v = await this.r.hget("scp:meta", "nextSeq");
    return v ? Number(v) : 1;
  }
  async getLedger(payee) {
    const raw = await this.r.lrange(`scp:ledger:${payee}`, 0, -1);
    return raw.map((x) => JSON.parse(x));
  }
  async appendLedger(payee, entry) {
    const key = `scp:ledger:${payee}`;
    await this.r.rpush(key, JSON.stringify(entry));
    await this.r.ltrim(key, -LEDGER_MAX, -1);
  }
  async close() {
    await this.r.quit();
  }
}

// --- Storage (unified API, wraps any backend) ---

class Storage {
  constructor(backend) {
    if (typeof backend === "string") {
      if (backend === ":memory:") {
        this._backend = new MemoryBackend();
      } else {
        this._backend = new JsonFileBackend(backend);
      }
    } else if (backend && typeof backend.get === "function") {
      this._backend = backend;
    } else {
      this._backend = new MemoryBackend();
    }

    // Expose state for backward compat (json/memory backends)
    this.state = this._backend.state || {};
  }

  getQuote(key) {
    return this._backend.get("quotes", key);
  }
  setQuote(key, value) {
    return this._backend.set("quotes", key, value);
  }
  getPayment(paymentId) {
    return this._backend.get("payments", paymentId);
  }
  setPayment(paymentId, value) {
    return this._backend.set("payments", paymentId, value);
  }
  getChannel(channelId) {
    return this._backend.get("channels", channelId);
  }
  setChannel(channelId, value) {
    return this._backend.set("channels", channelId, value);
  }

  async tx(mutator) {
    // For json/memory: direct state mutation + flush
    if (this._backend.state) {
      mutator(this._backend.state);
      if (this._backend._flush) return this._backend._flush();
      return;
    }
    // For redis: not supported via raw mutation, use individual calls
    throw new Error("tx() not supported on this backend, use individual set/get calls");
  }

  async nextSeq() {
    return this._backend.incr("nextSeq");
  }
  getHubChannel(payee) {
    return this._backend.get("hubChannels", payee.toLowerCase());
  }
  setHubChannel(payee, value) {
    return this._backend.set("hubChannels", payee.toLowerCase(), value);
  }
  getLedger(payee) {
    return this._backend.getLedger(payee);
  }
  appendLedger(payee, entry) {
    return this._backend.appendLedger(payee, entry);
  }
  close() {
    return this._backend.close();
  }
}

function createStorage(config) {
  if (!config || config === ":memory:") return new Storage(":memory:");
  if (typeof config === "string") return new Storage(config);
  if (config.redis) return new Storage(new RedisBackend(config.redis));
  return new Storage(config.path || ":memory:");
}

module.exports = { Storage, MemoryBackend, JsonFileBackend, RedisBackend, createStorage };
