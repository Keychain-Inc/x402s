# x402s — State Channel Protocol for HTTP 402 Payments

Pay-per-request for AI agents. State channels make it fast, cheap, and trustless.

```
Agent                Hub (pay.eth)              Payee
  |                      |                       |
  |--- GET /v1/data --------------------------->|
  |<-- 402 + offers ----------------------------|
  |                      |                       |
  |--- POST /quote ----->|                       |
  |<-- fee + draft ------|                       |
  |                      |                       |
  |--- signed state ---->| validate state        |
  |<-- ticket + ack -----|                       |
  |                      |                       |
  |--- GET + ticket ---------------------------->| verify ticket
  |<-- 200 + data + receipt ---------------------|
```

One channel. Thousands of payments. One on-chain settlement.

## What This Is

A complete implementation of the **x402 State Channel Protocol (SCP)** — hub-routed micropayments over EVM state channels, triggered by HTTP 402 responses.

- **Contract** (`X402StateChannel.sol`) — generic two-party state channel. Any address pair can open a channel. Multiple hubs share one deployment.
- **Hub** — off-chain payment router. Quotes fees, issues tickets, manages A-side and B-side channels.
- **Agent SDK** (`ScpAgentClient`) — discovers 402 offers, quotes, signs state, pays, retries. Fully automatic.
- **Payee server** — returns 402 challenges, validates tickets, serves paid resources.
- **Challenge watcher** — monitors on-chain close events, auto-submits higher nonce if counterparty cheats.

Deployed on Sepolia at `0x6F858C7120290431B606bBa343E3A8737B3dfCB4`.

## Quick Start

```bash
cd x402s
npm install
npm run scp:demo:e2e
```

This spins up a hub + payee in-process, runs a full `A -> H -> B` payment, and prints the result.

## Setting Up an Agent

```bash
# 1. Install
cd x402s && npm install

# 2. Set your private key (or omit for dev mode — virtual channels, no real funds)
export AGENT_PRIVATE_KEY=0xYourPrivateKey...

# 3. Open a channel and deposit
npm run scp:channel:open -- 0xHubAddress base usdc 20       # hub channel — 20 USDC on Base
npm run scp:channel:open -- 0xPayeeAddress base usdc 10     # direct channel — peer-to-peer

# 4. Pay things
npm run scp:agent:pay -- https://api.example/v1/data           # pay via hub (default)
npm run scp:agent:pay -- https://api.example/v1/data direct    # pay directly
npm run scp:agent:pay -- 0xChannelId... 5000000                # pay through channel
```

Networks: `mainnet`, `base`, `sepolia`, `base-sepolia`. Assets: `eth`, `usdc`, `usdt`. RPCs and token addresses resolve automatically. You can also pass raw values: `npm run scp:channel:open -- 0xAddr https://rpc.example 0xTokenAddr 20000000`.

If you try to pay without a channel, the agent queries the hub and tells you what to fund:

```
No channel open with hub pay.eth.

Hub:     0xCB0A92...
Fee:     base=10 + 30bps + gas=0
Per payment: 1000000 + 3010 fee = 1003010

Open a channel:
  npm run scp:channel:open -- 0xCB0A92... base usdc 20
```

For local testing, skip steps 2-3 — `npm run scp:demo:e2e` works out of the box.

## How Much to Fund

Two channels in a hub-routed payment:

```
Agent ──deposit──► [Agent↔Hub] ──fee──► Hub ──payment──► [Hub↔Payee] ──► Payee
```

Agent funds Agent↔Hub. Hub funds Hub↔Payee. Payees don't deposit.

| Per request | Hub fee | You pay | 100 reqs | 1000 reqs |
|-------------|---------|---------|----------|-----------|
| $0.01 | 13 | 10,013 | ~$1 | ~$10 |
| $0.10 | 310 | 100,310 | ~$10 | ~$100 |
| $0.50 | 1,510 | 501,510 | ~$50 | ~$502 |
| $1.00 | 3,010 | 1,003,010 | ~$100 | ~$1,003 |

`deposit = payments * (price + fee)` — top up anytime with `channel:fund`.

## Run the Stack

```bash
# Terminal 1 — hub
npm run scp:hub

# Terminal 2 — payee
npm run scp:payee

# Terminal 3 — agent pays
npm run scp:agent
```

## All Commands

**Pay**

| Command | |
|---------|---|
| `scp:agent:pay -- <url> [hub\|direct]` | Pay a URL (discovers offers via /pay or 402) |
| `scp:agent:pay -- <channelId> <amount>` | Pay through an open channel |
| `scp:agent:payments` | Show payment history |

**Channels**

| Command | |
|---------|---|
| `scp:channel:open -- <0xAddr> <network> <asset> <amount>` | Open + deposit |
| `scp:channel:fund -- <channelId> <amount>` | Deposit more |
| `scp:channel:close -- <channelId>` | Close channel |
| `scp:channel:list` | List channels + balances |

**Infrastructure**

| Command | |
|---------|---|
| `scp:hub` | Start hub on :4021 |
| `scp:payee` | Start payee on :4042 |
| `scp:watch:agent` | Watch channel — auto-challenge stale closes |
| `scp:watch:hub` | Watch as hub side |

**Test & Deploy**

| Command | |
|---------|---|
| `scp:test` | 17 on-chain contract tests |
| `scp:test:deep` | 8 deep-stack integration tests |
| `scp:test:all` | All tests |
| `scp:demo:e2e` | Full end-to-end payment |
| `scp:demo:direct` | Direct peer-to-peer payment |
| `scp:sim` | Multi-agent simulation |
| `scp:compile` | Compile Solidity |
| `scp:deploy:sepolia` | Deploy to Sepolia |

## Payment Routes

### Hub Route (`statechannel-hub-v1`)

```
A ←channel→ Hub ←channel→ B
```

Agent opens one channel with the hub. Hub routes payments to any payee. Payee gets a hub-signed ticket. Settlement is between A-Hub and Hub-B independently.

### Direct Route (`statechannel-direct-v1`)

```
A ←channel→ B
```

No hub. Agent signs state directly for payee. Lower fees, but requires a channel per payee.

### Agent-to-Agent Payments

Two agents can pay each other through hub or direct channels:

```bash
# Via hub — both agents have channels with the same hub
npm run scp:agent:pay -- http://agent-b.example/pay hub

# Via direct — agents open a channel between each other
npm run scp:channel:open -- 0xAgentB base usdc 50 direct
npm run scp:agent:pay -- 0xChannelId... 1000000
```

Both sides run the challenge watcher to stay safe. Either side can close the channel on-chain at any time.

---

## Protecting Your API with 402 Payments

Any HTTP server can accept SCP payments. The payee server returns a `402` challenge when a request has no payment header, and validates the ticket on retry.

Payees also expose `GET /pay` — returns the same offers as the 402 but with a `200` status, so agents and humans can discover what a payee accepts before paying:

```bash
curl http://127.0.0.1:4042/pay
# → { accepts: [{ scheme: "statechannel-hub-v1", price: "1000000", ... }, { scheme: "statechannel-direct-v1", ... }] }
```

### 1. The 402 Response

When a request arrives without a payment header, return `402` with your offers:

```javascript
// No payment header → return 402 challenge
if (!req.headers["payment-signature"]) {
  const invoiceId = randomId("inv");

  return res.status(402).json({
    accepts: [{
      scheme: "statechannel-hub-v1",
      network: "eip155:8453",                              // Base mainnet
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913", // USDC
      maxAmountRequired: "1000000",                         // 1.00 USDC
      payTo: "pay.eth",
      resource: "https://api.example/v1/data",
      extensions: {
        "statechannel-hub-v1": {
          hubName: "pay.eth",
          hubEndpoint: "https://pay.eth/.well-known/x402",
          mode: "proxy_hold",
          feeModel: { base: "10", bps: 30 },
          quoteExpiry: Math.floor(Date.now() / 1000) + 120,
          invoiceId,
          payeeAddress: "0xYourAddress..."
        }
      }
    }]
  });
}
```

Key fields:
- `maxAmountRequired` — your price in the token's smallest unit (USDC has 6 decimals, so `1000000` = $1.00)
- `hubEndpoint` — which hub the agent should use for quoting and ticket issuance
- `payeeAddress` — your wallet address (the hub signs tickets to this address)
- `invoiceId` — unique per-request, used for idempotency

### 2. Ticket Verification

When the agent retries with a `PAYMENT-SIGNATURE` header, one call does everything:

```javascript
const { verifyPayment } = require("x402s/node/scp-hub/ticket");

const { ok, error, ticket } = verifyPayment(req.headers["payment-signature"], {
  hub: "0xHubAddress...",
  payee: "0xMyAddress...",
  amount: "1000000"
});

if (!ok) return res.status(402).json({ error });

// Paid — serve the resource
```

### 3. Environment Variables (Payee)

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYEE_HOST` | `127.0.0.1` | Bind address |
| `PAYEE_PORT` | `4042` | Port |
| `PAYEE_PRIVATE_KEY` | dev key | Payee wallet private key |
| `HUB_URL` | `http://127.0.0.1:4021` | Hub to advertise in 402 |
| `HUB_NAME` | `pay.eth` | Hub identity name |
| `NETWORK` | `eip155:8453` | Chain (Base mainnet) |
| `DEFAULT_ASSET` | `0x833589f...` | USDC on Base |
| `PRICE` | `1000000` | Price per request (smallest unit) |
| `PERF_MODE` | `0` | Skip hub cross-check (faster) |

### Real Example: Weather API

The included weather API (`node/weather-api/server.js`) is a complete payee implementation:

```bash
# Start hub + weather API
npm run scp:hub &
HOST=127.0.0.1 PORT=4080 node node/weather-api/server.js
```

The agent pays 0.50 USDC per weather lookup:

```javascript
const agent = new ScpAgentClient({ networkAllowlist: ["eip155:8453"] });
const result = await agent.payResource("http://127.0.0.1:4080/weather?city=Tokyo");
// → { temperature: 12.5, condition: "Partly cloudy", ... }
```

---

## Agent SDK

### Basic Usage

```javascript
const { ScpAgentClient } = require("x402s/node/scp-agent/agent-client");

const agent = new ScpAgentClient({
  networkAllowlist: ["eip155:8453"],
  maxFeeDefault: "5000",        // max hub fee per payment (smallest unit)
  maxAmountDefault: "5000000"   // max payment amount
});

// One call does everything: discover → quote → sign → issue → pay
const result = await agent.payResource("https://api.example/v1/data");
console.log(result.response);   // the paid resource data
console.log(result.route);      // "hub" or "direct"
console.log(result.ticket);     // hub-signed ticket

agent.close();
```

### Constructor Options

| Option | Default | Description |
|--------|---------|-------------|
| `privateKey` | dev key | Agent wallet private key |
| `wallet` | — | ethers.Wallet instance (alternative to privateKey) |
| `networkAllowlist` | `["eip155:8453"]` | Accepted chain IDs |
| `assetAllowlist` | `[]` (any) | Accepted token addresses (empty = any) |
| `maxFeeDefault` | `"5000"` | Max hub fee per payment |
| `maxAmountDefault` | `"5000000"` | Max payment amount |
| `persistEnabled` | `true` | Save state to disk |
| `stateDir` | `./state` | State persistence directory |
| `timeoutMs` | `8000` | HTTP request timeout |

### Route Selection

```javascript
// Auto (prefers hub, falls back to direct)
await agent.payResource(url);

// Force hub route
await agent.payResource(url, { route: "hub" });

// Force direct route
await agent.payResource(url, { route: "direct" });
```

### Payment State

The agent persists channels, payments, and watcher proofs to `state/agent-state.json`:

```javascript
agent.state.channels    // { "hub:http://...": { channelId, nonce, balA, balB, endpoint } }
agent.state.payments    // { "pay_xxx": { paidAt, route, amount, payee, resourceUrl, ticketId, receipt } }
agent.state.watch       // { byChannelId: { "0x...": { state, sigA, sigB } } }
```

View payment history:
```bash
npm run scp:agent:payments
# Payments: 3
# -----
#   paymentId: pay_a1b2c3...
#   paidAt:    2025-01-15T10:30:00.000Z
#   route:     hub
#   amount:    1000000
#   resource:  https://api.example/v1/data
#   ticketId:  tkt_x9y8z7...
#   receiptId: rcpt_m4n5o6...
```

---

## Hub Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4021` | Hub port |
| `HOST` | `127.0.0.1` | Bind address |
| `HUB_NAME` | `pay.eth` | Hub identity |
| `HUB_PRIVATE_KEY` | dev key | Hub signing key |
| `CHAIN_ID` | `8453` | Chain ID |
| `DEFAULT_ASSET` | `0x833589f...` | Default payment asset |
| `FEE_BASE` | `10` | Fixed fee component (smallest unit) |
| `FEE_BPS` | `30` | Basis points fee (30 = 0.30%) |
| `GAS_SURCHARGE` | `0` | Additional gas cost pass-through |
| `RPC_URL` | — | JSON-RPC endpoint (for on-chain settlement) |
| `CONTRACT_ADDRESS` | — | X402StateChannel deployment address |
| `STORE_PATH` | `./data/store.json` | Hub state persistence |
| `WORKERS` | `0` | Cluster workers (0 = single process) |

### Fee Formula

```
fee = base + floor(amount * bps / 10000) + gasSurcharge
```

With defaults (base=10, bps=30): a 1,000,000 payment costs 10 + 3000 + 0 = **3,010** in fees.

### Hub API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/x402` | GET | Hub metadata, signing key, fee model |
| `/v1/tickets/quote` | POST | Get fee quote for a payment |
| `/v1/tickets/issue` | POST | Submit signed state, get ticket |
| `/v1/payments/:id` | GET | Check payment status |
| `/v1/payee/inbox` | GET | Payee's received payments |
| `/v1/payee/balance` | GET | Payee's accumulated balance |
| `/v1/payee/channel-state` | GET | Payee's hub channel state |
| `/v1/payee/settle` | POST | Request settlement |
| `/v1/hub/open-payee-channel` | POST | Open on-chain hub-payee channel |
| `/v1/hub/register-payee-channel` | POST | Register existing channel |
| `/v1/refunds` | POST | Issue refund |

---

## Contract

The contract is a generic two-party state channel — no hub logic baked in. `participantA` and `participantB` are just two addresses.

```
openChannel(participantB, asset, amount, challengePeriod, expiry, salt)
    → channelId

cooperativeClose(state, sigA, sigB)
    → immediate settlement

startClose(state, sigFromCounterparty)
    → begins challenge window

challenge(newerState, sigFromCounterparty)
    → replaces state if higher nonce

finalizeClose(channelId)
    → settles after challenge window
```

Challenge period is set per channel at open time (`challengePeriodSec`). Hub chooses the value — default 1 day for production, 60s in tests. Watcher service auto-submits challenges.

### Channel State

```
channelId     bytes32   unique channel identifier
stateNonce    uint64    monotonically increasing
balA          uint256   participantA balance
balB          uint256   participantB balance
locksRoot     bytes32   reserved for HTLC (zero for now)
stateExpiry   uint64    state validity deadline
contextHash   bytes32   binds to payee + resource + invoice
```

`balA + balB` must always equal the channel's total deposited balance. The contract enforces this invariant on every close and challenge.

### Deployed

| Network | Address |
|---------|---------|
| Sepolia | `0x6F858C7120290431B606bBa343E3A8737B3dfCB4` |

Deploy your own:
```bash
RPC_URL=https://rpc.sepolia.org \
DEPLOYER_KEY=0x... \
npm run scp:deploy:sepolia
```

---

## Challenge Watcher

Monitors on-chain close events and auto-submits the highest known state if the counterparty tries to settle with a stale nonce.

```bash
# Watch as agent
ROLE=agent \
RPC_URL=https://rpc.sepolia.org \
CONTRACT_ADDRESS=0x6F858C7120290431B606bBa343E3A8737B3dfCB4 \
CHANNEL_ID=0x... \
WATCHER_PRIVATE_KEY=0x... \
npm run scp:watch:agent

# Watch as hub
ROLE=hub \
RPC_URL=... CONTRACT_ADDRESS=... CHANNEL_ID=... WATCHER_PRIVATE_KEY=... \
npm run scp:watch:hub
```

The watcher reads local proof material (agent state or hub store) and submits `challenge()` if `localNonce > onchainNonce` and the deadline hasn't passed.

| Variable | Description |
|----------|-------------|
| `ROLE` | `agent` or `hub` |
| `RPC_URL` | JSON-RPC endpoint |
| `CONTRACT_ADDRESS` | Contract address |
| `CHANNEL_ID` | Channel to watch |
| `WATCHER_PRIVATE_KEY` | Key to submit challenge tx |
| `POLL_MS` | Poll interval (default 5000) |
| `SAFETY_BUFFER_SEC` | Don't challenge if deadline < buffer (default 2) |

---

## Agent Skill

An [agentskills.io](https://agentskills.io)-compatible skill is included at [`skill/SKILL.md`](skill/SKILL.md). Any compatible agent can discover and use it to operate the SCP stack — pay URLs, manage channels, run tests.

For Claude Code, a `/agent` slash command wraps the same skill:

```
/agent pay for the weather API
/agent open channel with 0xAbc... 1000000
/agent run all tests
/agent show balance
```

---

## Project Structure

```
x402s/
├── contracts/
│   ├── X402StateChannel.sol          # On-chain adjudicator
│   └── interfaces/IX402StateChannel.sol
├── node/
│   ├── scp-hub/                      # Hub server + state signing
│   │   ├── server.js                 # Hub HTTP server
│   │   ├── state-signing.js          # Channel state hashing + signing
│   │   ├── ticket.js                 # Ticket signing + verification
│   │   ├── storage.js                # State persistence (file or Redis)
│   │   ├── validator.js              # JSON schema validation
│   │   └── http-selftest.js          # Hub self-test
│   ├── scp-agent/                    # Agent SDK
│   │   ├── agent-client.js           # ScpAgentClient class
│   │   ├── demo-agent.js             # Demo: agent pays payee
│   │   └── show-payments.js          # CLI: show payment history
│   ├── scp-demo/                     # Payee server + demos
│   │   ├── payee-server.js           # Reference payee implementation
│   │   ├── demo-e2e.js               # Full end-to-end demo
│   │   └── demo-direct.js            # Direct payment demo
│   ├── scp-sim/                      # Simulations
│   │   ├── sim-multi-node.js         # Multi-agent, multi-payee
│   │   └── sim-mixed.js              # Mixed hub + direct
│   ├── scp-watch/                    # Challenge watcher
│   │   └── challenge-watcher.js
│   ├── scp-common/                   # Shared utilities
│   │   └── http-client.js            # HTTP client with connection pooling
│   └── weather-api/                  # Real-world payee example
│       ├── server.js                 # Weather API with 402 paywall
│       ├── demo.js                   # Local weather payment demo
│       └── demo-sepolia.js           # Sepolia on-chain demo
├── skill/
│   └── SKILL.md                      # agentskills.io-format agent skill
├── docs/
│   ├── X402_STATE_CHANNEL_V1.md      # Protocol spec (v1.2)
│   ├── IMPLEMENTATION_X402_SCP_V1.md # Implementation guide
│   ├── openapi/pay-eth-scp-v1.yaml   # OpenAPI spec
│   └── schemas/                      # JSON schemas (channel state, ticket, etc.)
├── test/
│   ├── test_x402_state_channel.js    # 17 contract tests
│   └── test_scp_stack_deep.js        # 8 integration tests
└── scripts/
    ├── deploy.js                     # Deploy to Sepolia
    └── test-sepolia.js               # Live testnet verification
```

## Spec

Full protocol specification: [docs/X402_STATE_CHANNEL_V1.md](docs/X402_STATE_CHANNEL_V1.md)

## License

MIT
