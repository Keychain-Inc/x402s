const { ethers } = require("ethers");

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((k) => {
        out[k] = canonicalize(value[k]);
      });
    return out;
  }
  return value;
}

function ticketDraftDigest(ticketDraft) {
  const canonical = canonicalize(ticketDraft);
  const encoded = JSON.stringify(canonical);
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(encoded));
}

async function signTicketDraft(ticketDraft, signer) {
  const digest = ticketDraftDigest(ticketDraft);
  return signer.signMessage(ethers.utils.arrayify(digest));
}

function verifyTicket(ticket) {
  const { sig, ...ticketDraft } = ticket;
  if (!sig || typeof sig !== "string") return null;
  const digest = ticketDraftDigest(ticketDraft);
  return ethers.utils.verifyMessage(ethers.utils.arrayify(digest), sig);
}

/**
 * One-call ticket verification for payees.
 *
 *   const { ok, error, signer } = verifyPayment(req.headers["payment-signature"], {
 *     hub: "0xHubAddress",
 *     payee: "0xMyAddress",
 *     amount: "1000000"
 *   });
 */
function verifyPayment(header, expect) {
  if (!header) return { ok: false, error: "missing header" };
  let payload;
  try { payload = typeof header === "string" ? JSON.parse(header) : header; } catch (_) { return { ok: false, error: "bad json" }; }
  if (!payload || !payload.ticket) return { ok: false, error: "no ticket" };

  const signer = verifyTicket(payload.ticket);
  if (!signer) return { ok: false, error: "bad sig" };
  if (expect.hub && signer.toLowerCase() !== expect.hub.toLowerCase()) return { ok: false, error: "unknown hub", signer };
  if (expect.payee && payload.ticket.payee.toLowerCase() !== expect.payee.toLowerCase()) return { ok: false, error: "wrong payee", signer };
  if (expect.amount && payload.ticket.amount !== expect.amount) return { ok: false, error: "wrong amount", signer };
  if (payload.ticket.expiry && payload.ticket.expiry < (Date.now() / 1000 | 0)) return { ok: false, error: "expired", signer };

  return { ok: true, signer, ticket: payload.ticket, paymentId: payload.paymentId };
}

module.exports = {
  ticketDraftDigest,
  signTicketDraft,
  verifyTicket,
  verifyPayment
};
