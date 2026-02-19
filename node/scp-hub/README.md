# SCP Node Hub (Reference)

Minimal Node.js reference service for `statechannel-hub-v1`.

## Run

```bash
node node/scp-hub/server.js
```

Optional env vars:

- `HOST` (default `127.0.0.1`)
- `PORT` (default `4021`)
- `HUB_NAME` (default `pay.eth`)
- `CHAIN_ID` (default `8453`)
- `HUB_PRIVATE_KEY` (default local dev key)
- `DEFAULT_ASSET` (default Base USDC)
- `FEE_BASE` (default `10`)
- `FEE_BPS` (default `30`)
- `GAS_SURCHARGE` (default `0`)
- `STORE_PATH` (default `node/scp-hub/data/store.json`)

## Endpoints

- `GET /.well-known/x402`
- `POST /v1/tickets/quote`
- `POST /v1/tickets/issue`
- `POST /v1/refunds`
- `GET /v1/payments/:paymentId`
- `GET /v1/channels/:channelId`

## No-Bind Self Test

In environments that block socket binding (EPERM), run:

```bash
node node/scp-hub/http-selftest.js
```

## Notes

- Persistent JSON store on disk (`STORE_PATH`).
- Strict JSON Schema validation via Ajv using:
  - `docs/schemas/scp.quote-request.v1.schema.json`
  - `docs/schemas/scp.quote-response.v1.schema.json`
  - `docs/schemas/scp.ticket.v1.schema.json`
  - `docs/schemas/scp.channel-state.v1.schema.json`
- Signature format is `eth_sign` over JSON digest for ticket draft.
- Uses artifacts from `docs/openapi/pay-eth-scp-v1.yaml` and `docs/schemas/*`.
