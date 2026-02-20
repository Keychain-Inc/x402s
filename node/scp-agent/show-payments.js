/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const stateDir = process.env.AGENT_STATE_DIR || path.resolve(__dirname, "./state");
const stateFile = path.join(stateDir, "agent-state.json");

function fmtTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts * 1000).toISOString();
  } catch (_e) {
    return String(ts);
  }
}

function main() {
  if (!fs.existsSync(stateFile)) {
    console.log(`No agent state found at ${stateFile}`);
    process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const payments = state.payments || {};
  const ids = Object.keys(payments);
  if (ids.length === 0) {
    console.log("No payments yet.");
    process.exit(0);
  }

  const rows = ids
    .map((id) => ({ paymentId: id, ...payments[id] }))
    .sort((a, b) => Number(b.paidAt || 0) - Number(a.paidAt || 0));

  console.log(`Payments: ${rows.length}`);
  for (const p of rows) {
    console.log("-----");
    console.log(`  paymentId: ${p.paymentId}`);
    console.log(`  paidAt:    ${fmtTs(p.paidAt)}`);
    console.log(`  route:     ${p.route || "-"}`);
    if (p.amount) console.log(`  amount:    ${p.amount}`);
    if (p.payee) console.log(`  payee:     ${p.payee}`);
    if (p.resourceUrl) console.log(`  resource:  ${p.resourceUrl}`);
    if (p.ticketId) console.log(`  ticketId:  ${p.ticketId}`);
    if (p.receipt) console.log(`  receiptId: ${p.receipt.receiptId || p.receipt.merchantReceiptId || "-"}`);
  }
}

main();
