# PR: Scheme spec — `stream` (state channel micropayments)

## Title
`spec: add stream scheme for off-chain state channel micropayments`

## Description

### What

Proposes a new **`stream` scheme** for x402 that enables ongoing, incremental payments via off-chain state channels. While `exact` handles single-shot payments (pay $1 to read an article), `stream` handles continuous payment relationships (pay $0.0001/second to stream music, pay per LLM token generated, pay per API call in an agent loop).

### Why

The x402 protocol currently supports `exact` — a single transfer per request. Many emerging use cases require **thousands of sub-cent payments** over a persistent session:

- AI agents calling tools in a loop need per-call billing without per-call gas
- Media streaming (audio, video) is naturally priced per-second
- IoT sensor data and metered APIs charge per-unit

On-chain settlement per payment is infeasible at this scale (gas costs dwarf the payment). State channels solve this by moving payments off-chain with on-chain settlement only at open and close — two transactions total regardless of how many payments occur.

### How it works

1. Client opens a funded channel with a **hub** (the x402 facilitator)
2. Each payment tick: client signs an EIP-712 state update shifting `amount` from their balance to the hub
3. Hub routes the payment to the server's channel
4. Server delivers content and returns stream metadata (`nextCursor`, `hasMore`, cadence `t`)
5. When done, either party settles on-chain via cooperative close

The hub never has unilateral custody — every balance change requires a co-signed state, aligning with x402's trust-minimizing principle.

### Files

| File | Description |
|------|-------------|
| `specs/schemes/stream/scheme_stream.md` | Scheme overview: use cases, protocol flow, trust model, comparison with `exact` |
| `specs/schemes/stream/scheme_stream_evm.md` | EVM implementation: contract interface, EIP-712 signing, verification logic, settlement procedures, security considerations |

### Reference implementation

Full working implementation (hub, agent, payee, contract, stream clients):
**https://github.com/Keychain-Inc/x402s**

### Checklist

- [x] Spec follows `scheme_template.md` and `scheme_impl_template.md` format
- [x] Uses MUST/SHOULD/MAY language per specs contributing guide
- [x] Includes concrete JSON examples for PaymentRequired and PaymentPayload
- [x] Documents verification logic (8 checks)
- [x] Documents settlement logic (cooperative close, unilateral close, rebalance)
- [x] Documents security considerations (replay, authorization scope, atomicity, solvency)
- [x] References core types from x402-specification-v2.md
- [ ] Discussion issue (will open separately if preferred)

### Labels
`scheme`, `spec`, `enhancement`
