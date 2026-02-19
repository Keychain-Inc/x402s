const { ethers } = require("ethers");

const STATE_TYPES = [
  "bytes32",
  "uint64",
  "uint256",
  "uint256",
  "bytes32",
  "uint64",
  "bytes32"
];

function hashChannelState(state) {
  const encoded = ethers.utils.defaultAbiCoder.encode(STATE_TYPES, [
    state.channelId,
    state.stateNonce,
    state.balA,
    state.balB,
    state.locksRoot,
    state.stateExpiry,
    state.contextHash
  ]);
  return ethers.utils.keccak256(encoded);
}

async function signChannelState(state, signer) {
  const digest = hashChannelState(state);
  return signer.signMessage(ethers.utils.arrayify(digest));
}

function recoverChannelStateSigner(state, signature) {
  const digest = hashChannelState(state);
  return ethers.utils.verifyMessage(ethers.utils.arrayify(digest), signature);
}

module.exports = {
  hashChannelState,
  signChannelState,
  recoverChannelStateSigner
};
