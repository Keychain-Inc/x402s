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

module.exports = {
  ticketDraftDigest,
  signTicketDraft,
  verifyTicket
};
