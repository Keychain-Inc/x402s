# Scheme: `stream`

## Summary

`stream` is a scheme for **ongoing, incremental payments** over a persistent relationship between a client and a resource server. Instead of a single atomic transfer per request (as in `exact`), `stream` uses **off-chain state channels** to enable sub-second micropayments with on-chain settlement only at open and close.

The core idea: a client opens a funded channel once, then pays per-tick (per second, per chunk, per token) by co-signing off-chain state updates that shift balance from client to server. The resource server delivers content continuously as long as payment ticks arrive. Either party can settle on-chain at any time using the latest co-signed state.

A **hub** acts as the facilitator, routing payments between client↔hub and hub↔server channels. This means:

- The client only needs one channel to pay any server registered with the hub.
- The server receives funds from the hub channel, not directly from the client.
- The hub never has unilateral custody — every balance change requires a co-signed state.

## Use Cases

- **Pay-per-second media streaming** — music, video, or audio feeds priced at wei-per-second.
- **Metered API access** — LLM token generation, compute jobs, or data feeds billed per unit consumed.
- **Agent-to-agent payments** — autonomous agents paying for tool calls, data, or services in real-time without on-chain latency.
- **IoT / sensor data** — continuous telemetry streams priced per reading.

## How It Differs from `exact`

| Property | `exact` | `stream` |
|----------|---------|----------|
| Payments per resource | 1 | N (ongoing) |
| On-chain transactions | 1 per request | 2 total (open + close) |
| Latency per payment | Block confirmation | Instant (off-chain) |
| Minimum viable amount | Gas-bound (~$0.01) | Arbitrary (1 wei+) |
| Relationship model | Stateless | Stateful channel |

## Protocol Flow

### Channel Lifecycle

1. **Open** — Client opens a funded state channel on-chain with the hub.
2. **Pay** — For each tick, the client signs a state update shifting `amount` from their balance to the hub. The hub co-signs and forwards funds to the server's channel.
3. **Deliver** — The resource server delivers the next content chunk and returns stream metadata (next cursor, cadence, `hasMore`).
4. **Close** — Either party submits the latest co-signed state to settle on-chain. Cooperative close is instant; unilateral close has a challenge period.

### 402 Response with Stream Offer

When a resource server supports streaming payment, it returns a `402 Payment Required` response with `scheme: "stream"` in the `accepts` array. The `extra` field carries stream-specific parameters:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "stream",
      "network": "eip155:8453",
      "amount": "100000000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
      "payTo": "0xServerAddress...",
      "maxTimeoutSeconds": 86400,
      "extra": {
        "stream": {
          "t": 5,
          "unit": "seconds"
        },
        "hub": "https://hub.example.com",
        "hubAddress": "0xHubAddress..."
      }
    }
  ]
}
```

| `extra` Field | Type | Required | Description |
|---------------|------|----------|-------------|
| `stream.t` | `number` | Yes | Payment cadence — client MUST pay every `t` units |
| `stream.unit` | `string` | No | Unit for `t`. Default `"seconds"`. May be `"chunks"`, `"tokens"` |
| `hub` | `string` | Yes | Hub facilitator URL |
| `hubAddress` | `string` | Yes | Hub's on-chain address (channel counterparty) |

### Payment Payload

The client sends a signed state channel update as the payment payload:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "stream",
    "network": "eip155:8453",
    "amount": "100000000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
    "payTo": "0xServerAddress...",
    "maxTimeoutSeconds": 86400,
    "extra": {
      "stream": { "t": 5 },
      "hub": "https://hub.example.com",
      "hubAddress": "0xHubAddress..."
    }
  },
  "payload": {
    "channelId": "0x...",
    "stateNonce": 42,
    "balA": "4900000000000",
    "balB": "100000000000",
    "signature": "0x..."
  }
}
```

### Stream Response

On successful payment, the resource server returns the content and stream metadata:

```json
{
  "stream": {
    "amount": "100000000000",
    "t": 5,
    "nextCursor": 10,
    "hasMore": true
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stream.amount` | `string` | Amount charged this tick (wei) |
| `stream.t` | `number` | Cadence — when the next tick is due |
| `stream.nextCursor` | `number` | Opaque cursor for the next request |
| `stream.hasMore` | `boolean` | `false` signals end of stream |

The client MUST wait `stream.t` units before sending the next payment tick. The client SHOULD stop when `hasMore` is `false`.

## Trust Model

- **Client**: Signs state updates that can only move funds *from* client *to* hub. Cannot be settled for more than the signed amount.
- **Hub (Facilitator)**: Routes payments. Cannot move funds without a co-signed state. Cannot settle a stale state if the counterparty submits a newer one during the challenge period.
- **Resource Server**: Receives funds from its channel with the hub. Has the latest co-signed state as on-chain proof of payment.
- **On-chain contract**: Enforces the challenge period, validates EIP-712 signatures, and pays out the final agreed balances.

## Security Considerations

- **Replay prevention**: Each state update increments `stateNonce`. The contract only accepts states with a nonce higher than the last recorded one.
- **Stale state protection**: Unilateral close triggers a challenge period during which the counterparty can submit a higher-nonce state.
- **Channel expiry**: Channels have a hard expiry timestamp. After expiry, anyone can finalize with the latest known state.
- **Hub insolvency**: The hub's total liabilities (sum of server-side channel balances) MUST NOT exceed its total assets (sum of client-side channel balances). Rebalance operations move funds between channels atomically on-chain.

## Appendix

### Relation to x402 Roles

| x402 Role | Stream Role |
|-----------|-------------|
| Client | Channel participant A (funder) |
| Facilitator | Hub — routes payments, co-signs states |
| Resource Server | Channel participant B on hub↔server channel |

### Related Specifications

- `scheme_stream_evm.md` — EVM implementation with EIP-712 signed states and Solidity contract
