---
name: scp-agent
description: Operate the x402 State Channel Protocol (SCP) stack — pay 402-protected URLs, pay Ethereum addresses, open/fund/close on-chain channels, check balances, and run tests. Use when the user wants to make micropayments, manage state channels, or test the SCP system.
license: MIT
compatibility: Requires Node.js, npm, and access to an EVM RPC endpoint for on-chain operations.
metadata:
  author: x402s
  version: "1.0"
---

# SCP Agent

Operate the x402 State Channel Protocol stack. All commands run from the `x402s/` project root.

## Architecture

- **Hub** (`node/scp-hub/server.js`) — payment router, port 4021
- **Payee** (`node/scp-demo/payee-server.js`) — resource server with 402 challenge, port 4042
- **Agent** (`node/scp-agent/agent-client.js`) — `ScpAgentClient` class: discovers offers, quotes, signs state, issues tickets, retries with payment proof
- **Contract** — `X402StateChannel.sol` deployed at `0x6F858C7120290431B606bBa343E3A8737B3dfCB4` on Sepolia

Payment flow: `Agent → 402 → Hub quote → sign state → Hub issue ticket → paid retry to Payee`

## Commands

### Pay

| Command | What it does |
|---------|-------------|
| `npm run scp:agent:pay -- <url> [hub\|direct]` | Pay a 402-protected URL |
| `npm run scp:agent:pay -- <channelId> <amount>` | Pay through an open channel |
| `npm run scp:agent:payments` | Show payment history |
| `npm run scp:agent` | Run demo payment (auto-starts hub + payee) |

### Channels

| Command | What it does |
|---------|-------------|
| `npm run scp:channel:open -- <0xAddr> <network> <asset> <amount>` | Open channel with deposit |
| `npm run scp:channel:fund -- <channelId> <amount>` | Deposit into existing channel |
| `npm run scp:channel:close -- <channelId>` | Close channel (cooperative or unilateral) |
| `npm run scp:channel:list` | List all channels + balances |

Networks: `mainnet`, `base`, `sepolia`, `base-sepolia`. Assets: `eth`, `usdc`, `usdt`. RPCs and token addresses resolve automatically.

### Verify & Test

| Command | What it does |
|---------|-------------|
| `npm run scp:test:deep` | 8-test deep stack integration suite |
| `npm run scp:test:all` | Hardhat contract tests + deep stack |
| `npm run scp:demo:e2e` | Full end-to-end payment test |
| `npm run scp:demo:direct` | Direct peer-to-peer payment test |
| `npm run scp:hub:selftest` | Hub HTTP self-test |

### Watch

| Command | What it does |
|---------|-------------|
| `npm run scp:watch:agent` | Watch channel as agent — auto-challenge if counterparty closes with stale nonce |
| `npm run scp:watch:hub` | Watch channel as hub |

Requires: `RPC_URL`, `CONTRACT_ADDRESS`, `CHANNEL_ID`, `WATCHER_PRIVATE_KEY`. Optional: `POLL_MS` (default 5000), `SAFETY_BUFFER_SEC` (default 2).

### On-chain Queries

The contract supports enumeration:
- `getChannelCount()` → total channels ever opened
- `getChannelIds(offset, limit)` → paginated channel ID list
- `getChannelsByParticipant(address)` → all channel IDs for an address
- `getChannel(channelId)` → single channel details

### Infrastructure

| Command | What it does |
|---------|-------------|
| `npm run scp:hub` | Start hub server |
| `npm run scp:payee` | Start payee server |
| `npm run scp:sim` | Multi-node simulation |

## Routing rules

1. **pay \<url\>** → `npm run scp:agent:pay -- <url>` (add `direct` for direct route)
2. **pay** (no args) → start hub + payee in background, then `npm run scp:agent:pay -- http://127.0.0.1:4042/v1/data`
3. **open \<address\> \<network\> \<asset\> \<amount\>** → `npm run scp:channel:open -- <0xAddress> <network> <asset> <amount>` (e.g. `base usdc 20`)
4. **fund \<channelId\> \<amount\>** → `npm run scp:channel:fund -- <channelId> <amount>`
5. **close \<channelId\>** → `npm run scp:channel:close -- <channelId>`
6. **balance** / **list** → `npm run scp:channel:list` then `npm run scp:agent:payments`
7. **verify** / **test** → `npm run scp:test:deep` (fast) or `npm run scp:test:all` (full)
8. **sim** → `npm run scp:sim` with optional `SIM_AGENTS=10 SIM_PAYEES=5 SIM_ROUNDS=5`
9. **hub** / **start** → start hub and/or payee servers in background
10. **state** → read `node/scp-agent/state/agent-state.json`
11. **watch \<channelId\>** → `ROLE=agent RPC_URL=<rpc> CONTRACT_ADDRESS=<addr> CHANNEL_ID=<id> WATCHER_PRIVATE_KEY=<key> npm run scp:watch:agent` (use `ROLE=hub` + `npm run scp:watch:hub` for hub side)
12. **channels for \<address\>** → call `getChannelsByParticipant(address)` on-chain to discover all channels for an address, then `getChannel(id)` for each
13. If unclear → `npm run scp:demo:e2e`

Channel CLI resolves RPCs and token addresses automatically from network/asset names. You can also override with `RPC_URL` and `CONTRACT_ADDRESS` env vars. Default Sepolia contract: `0x6F858C7120290431B606bBa343E3A8737B3dfCB4`.

After running commands, summarize concisely: what happened, amounts, any errors.
