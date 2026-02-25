# Scheme: `stream` on `EVM`

## Summary

The `stream` scheme on EVM uses a state channel smart contract (`X402StateChannel`) to enable off-chain micropayments settled on-chain via EIP-712 signed state updates. A hub facilitator routes payments between client↔hub and hub↔server channels, enabling any client to pay any server through a single channel.

This document specifies the on-chain contract interface, state signing format, payment payload structure, verification logic, and settlement procedures.

---

## 1. Smart Contract: `X402StateChannel`

### 1.1 Channel Structure

Each channel is identified by a deterministic `channelId`:

```solidity
channelId = keccak256(abi.encode(
    block.chainid, contractAddress, participantA, participantB, asset, salt
))
```

Channel state stored on-chain:

| Field | Type | Description |
|-------|------|-------------|
| `participantA` | `address` | Channel opener (client or hub) |
| `participantB` | `address` | Counterparty (hub or server) |
| `asset` | `address` | ERC-20 token address (`address(0)` for ETH) |
| `totalBalance` | `uint256` | Total funds locked in the channel |
| `challengePeriodSec` | `uint64` | Duration of the dispute window |
| `channelExpiry` | `uint64` | Hard deadline after which the channel can be finalized |
| `hubFlags` | `uint8` | Bit flags: 1 = A is hub, 2 = B is hub |
| `fundedBalA` | `uint256` | Cumulative funds attributed to A (from open/deposit/rebalance) |
| `fundedBalB` | `uint256` | Cumulative funds attributed to B (from open/deposit/rebalance) |
| `isClosing` | `bool` | Whether a unilateral close is in progress |
| `latestNonce` | `uint64` | Highest state nonce submitted on-chain |
| `closeBalA` | `uint256` | A's balance in the dispute state |
| `closeBalB` | `uint256` | B's balance in the dispute state |

**Invariant**: `fundedBalA + fundedBalB == totalBalance` for live channels. `closeBalA + closeBalB == totalBalance` during dispute.

### 1.2 Contract Functions

| Function | Description |
|----------|-------------|
| `openChannel(participantB, asset, amount, challengePeriodSec, channelExpiry, salt, hubFlags)` | Opens and funds a new channel. Caller is `participantA`. |
| `deposit(channelId, amount)` | Adds funds to an existing channel. |
| `cooperativeClose(state, sigA, sigB)` | Instant close with both signatures. Pays out `balA` to A, `balB` to B. |
| `startClose(state, sigCounterparty)` | Begins unilateral close. Starts the challenge period. |
| `challenge(state, sigCounterparty)` | Submits a higher-nonce state during the challenge period. |
| `finalizeClose(channelId)` | Pays out after the challenge period expires. |
| `rebalance(state, toChannelId, amount, sigCounterparty)` | Hub moves funds from one channel to another (both channels MUST share the hub as a participant). |
| `balance(channelId)` | View function returning `(totalBalance, balA, balB, latestNonce, isClosing)`. Returns `fundedBal` for live channels, `closeBal` during dispute. |

### 1.3 Hub Flags

The `hubFlags` field enables the contract to enforce that rebalance operations only move funds between channels where the caller is a hub participant:

| Value | Meaning |
|-------|---------|
| `0` | Neither participant is a hub |
| `1` | Participant A is the hub |
| `2` | Participant B is the hub |
| `3` | Both participants are hubs |

Rebalance MUST verify `hubFlags` to ensure the hub has standing on both the source and destination channels.

---

## 2. EIP-712 State Signing

All off-chain state updates are signed using EIP-712 typed data.

### 2.1 Domain Separator

```solidity
EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)
```

| Field | Value |
|-------|-------|
| `name` | `"X402StateChannel"` |
| `version` | `"1"` |
| `chainId` | Chain ID of the deployed contract |
| `verifyingContract` | Contract address |

### 2.2 ChannelState Type

```solidity
ChannelState(
    bytes32 channelId,
    uint64 stateNonce,
    uint256 balA,
    uint256 balB,
    bytes32 locksRoot,
    uint64 stateExpiry,
    bytes32 contextHash
)
```

| Field | Type | Description |
|-------|------|-------------|
| `channelId` | `bytes32` | Identifies the channel |
| `stateNonce` | `uint64` | Monotonically increasing. Higher nonce supersedes lower. |
| `balA` | `uint256` | A's balance in this state |
| `balB` | `uint256` | B's balance in this state |
| `locksRoot` | `bytes32` | Merkle root of conditional locks (zero if none) |
| `stateExpiry` | `uint64` | Timestamp after which this state is invalid |
| `contextHash` | `bytes32` | Application-specific context (e.g., hash of stream metadata) |

**Constraint**: `balA + balB == channel.totalBalance`. The contract MUST reject states that violate this.

---

## 3. `PAYMENT-SIGNATURE` Header Payload

### 3.1 PaymentPayload for Stream

The client sends a signed state channel update as the payment:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/stream/audio",
    "description": "Pay-per-second audio stream",
    "mimeType": "audio/mpeg"
  },
  "accepted": {
    "scheme": "stream",
    "network": "eip155:8453",
    "amount": "100000000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
    "payTo": "0xServerAddress...",
    "maxTimeoutSeconds": 86400,
    "extra": {
      "stream": { "t": 5, "unit": "seconds" },
      "hub": "https://hub.example.com",
      "hubAddress": "0xHubAddress..."
    }
  },
  "payload": {
    "channelId": "0xabc123...",
    "stateNonce": 42,
    "balA": "4900000000000",
    "balB": "100000000000",
    "locksRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "stateExpiry": "1740672154",
    "contextHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "signature": "0x2d6a7588..."
  }
}
```

### 3.2 Payload Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channelId` | `bytes32` | Yes | The client↔hub channel |
| `stateNonce` | `uint64` | Yes | Must be higher than the previous tick's nonce |
| `balA` | `uint256` | Yes | Client's new balance (previous `balA` minus `amount`) |
| `balB` | `uint256` | Yes | Hub's new balance (previous `balB` plus `amount`) |
| `locksRoot` | `bytes32` | No | Default `0x00...00` |
| `stateExpiry` | `uint64` | No | State validity deadline |
| `contextHash` | `bytes32` | No | Application context |
| `signature` | `bytes` | Yes | Client's EIP-712 signature over the `ChannelState` |

---

## 4. Verification Logic

The hub (facilitator) MUST perform these checks on each payment tick:

1. **Channel exists** — `channelId` maps to a live, non-closing channel.
2. **Signer is participant** — Recover the signer from the EIP-712 signature. The signer MUST be `participantA` (the client).
3. **Nonce advances** — `stateNonce` MUST be strictly greater than the last accepted nonce for this channel.
4. **Balance conservation** — `balA + balB == channel.totalBalance`.
5. **Correct payment amount** — `previous.balA - payload.balA == accepted.amount` (the tick moved exactly the required amount from A to B).
6. **Balance non-negative** — `balA >= 0` (client has sufficient remaining balance).
7. **State not expired** — If `stateExpiry > 0`, it MUST be in the future.
8. **Channel not expired** — `block.timestamp < channel.channelExpiry`.

If any check fails, the hub MUST reject the payment and respond with `402 Payment Required`.

---

## 5. Settlement Logic

### 5.1 Cooperative Close (Preferred)

Both parties sign the final state. Either party submits:

```
cooperativeClose(finalState, sigA, sigB)
```

The contract verifies both signatures, then transfers `balA` to A and `balB` to B in a single transaction. No challenge period.

### 5.2 Unilateral Close

If one party is unresponsive, the other can force-close:

1. **Start close** — Submit the latest state with the counterparty's signature:
   ```
   startClose(state, sigCounterparty)
   ```
   This begins the challenge period (`challengePeriodSec`).

2. **Challenge** — During the challenge period, the counterparty MAY submit a state with a higher nonce:
   ```
   challenge(newerState, sigCounterparty)
   ```
   This updates the close state and resets the deadline.

3. **Finalize** — After the challenge period expires:
   ```
   finalizeClose(channelId)
   ```
   Pays out `closeBalA` to A and `closeBalB` to B.

### 5.3 Hub Rebalancing

The hub routes payments between channels. When a client pays the hub on channel X, the hub credits the server on channel Y. To keep on-chain accounting accurate:

```
rebalance(fromState, toChannelId, amount, sigCounterparty)
```

This atomically:
- Deducts `amount` from the source channel's `totalBalance`
- Credits `amount` to the destination channel's `totalBalance`
- Updates `fundedBal` tracking on both channels
- Records the signed state on the source channel

The hub MUST have `hubFlags` set on both channels. The from-state MUST be signed by the counterparty (proving they agree the hub has earned the funds).

---

## 6. Stream Cadence Protocol

The resource server controls the payment cadence via the `stream` object in its response:

```
Client                          Hub                         Server
  |                              |                             |
  |-- signed state (tick 1) ---->|                             |
  |                              |-- credit server channel --> |
  |                              |                             |
  |<---- content + stream meta --|<--- content + stream meta --|
  |     {t: 5, nextCursor: 5,   |                             |
  |      hasMore: true}          |                             |
  |                              |                             |
  | ... wait t seconds ...       |                             |
  |                              |                             |
  |-- signed state (tick 2) ---->|                             |
  ...                            ...                           ...
  |<---- {hasMore: false} -------|                             |
  |                              |                             |
  |-- cooperativeClose --------->|                             |
```

The server's `stream.t` value in each response MAY change dynamically (e.g., slower cadence during buffering, faster during high-demand).

---

## 7. Security Considerations

### 7.1 Replay Prevention

Each state includes a monotonically increasing `stateNonce`. The contract records the highest nonce seen and rejects any state with an equal or lower nonce.

### 7.2 Authorization Scope

A signed state authorizes a *specific balance split* on a *specific channel*. The signature covers the `channelId`, so it cannot be replayed on a different channel. The signature covers `balA` and `balB`, so the hub cannot claim more than the signed amount.

### 7.3 Settlement Atomicity

- Cooperative close settles in one transaction.
- Unilateral close has a challenge period to prevent stale-state fraud.
- Rebalance is atomic — both channel balances update in the same transaction.

### 7.4 Hub Solvency

The hub's total `fundedBalB` across all client channels MUST be ≥ its total `fundedBalA` across all server channels. Rebalance enforces this on-chain by moving `totalBalance` atomically.

### 7.5 Fund Safety

The hub (facilitator) cannot move funds without a co-signed state. This aligns with x402's trust-minimizing principle: the facilitator serves only as a router, not a custodian.

---

## Appendix

### A. Canonical Contract

The reference `X402StateChannel` contract is available at:
[github.com/Keychain-Inc/x402s/contracts/X402StateChannel.sol](https://github.com/Keychain-Inc/x402s/blob/main/contracts/X402StateChannel.sol)

### B. Reference Implementation

A full hub (facilitator), agent (client), and payee (server) implementation is available at:
[github.com/Keychain-Inc/x402s](https://github.com/Keychain-Inc/x402s)

### C. Supported Assets

The scheme works with any ERC-20 token and native ETH (`asset = address(0)`). The `amount` field in `PaymentRequirements` is denominated in the token's atomic units (e.g., wei for ETH, 10⁻⁶ for USDC).
