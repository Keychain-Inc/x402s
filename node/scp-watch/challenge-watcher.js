/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function cfg() {
  return {
    role: process.env.ROLE || "agent",
    rpcUrl: process.env.RPC_URL || "",
    contractAddress: process.env.CONTRACT_ADDRESS || "",
    channelId: process.env.CHANNEL_ID || "",
    pollMs: Number(process.env.POLL_MS || 5000),
    safetyBufferSec: Number(process.env.SAFETY_BUFFER_SEC || 2),
    hubStorePath:
      process.env.HUB_STORE_PATH || path.resolve(__dirname, "../scp-hub/data/store.json"),
    agentStatePath:
      process.env.AGENT_STATE_PATH || path.resolve(__dirname, "../scp-agent/state/agent-state.json"),
    watcherKey: process.env.WATCHER_PRIVATE_KEY || ""
  };
}

const ABI = [
  "function getChannel(bytes32 channelId) view returns ((address participantA,address participantB,address asset,uint64 challengePeriodSec,uint64 channelExpiry,uint256 totalBalance,bool isClosing,uint64 closeDeadline,uint64 latestNonce) params)",
  "function challenge((bytes32 channelId,uint64 stateNonce,uint256 balA,uint256 balB,bytes32 locksRoot,uint64 stateExpiry,bytes32 contextHash) newer, bytes sigFromCounterparty) external"
];

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_e) {
    return {};
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function readLocalProof() {
  const c = cfg();
  if (c.role === "hub") {
    const store = loadJson(c.hubStorePath);
    const ch = (store.channels || {})[c.channelId];
    if (!ch || !ch.latestState || !ch.sigA) return null;
    return {
      state: ch.latestState,
      counterpartySig: ch.sigA
    };
  }

  const state = loadJson(c.agentStatePath);
  const watch = ((state.watch || {}).byChannelId || {})[c.channelId];
  if (!watch || !watch.state || !watch.sigB) return null;
  return {
    state: watch.state,
    counterpartySig: watch.sigB
  };
}

async function tick(contract) {
  const c = cfg();
  const local = readLocalProof();
  if (!local) {
    console.log(`[watch:${c.role}] no local proof for channel ${c.channelId}`);
    return;
  }

  const onchain = await contract.getChannel(c.channelId);
  if (!onchain.participantA || onchain.participantA === ethers.constants.AddressZero) {
    console.log(`[watch:${c.role}] channel not found/closed`);
    return;
  }
  if (!onchain.isClosing) {
    console.log(`[watch:${c.role}] channel open; no challenge needed`);
    return;
  }

  const onchainNonce = Number(onchain.latestNonce);
  const localNonce = Number(local.state.stateNonce);
  const closeDeadline = Number(onchain.closeDeadline);
  const ts = now();
  if (ts + c.safetyBufferSec >= closeDeadline) {
    console.log(`[watch:${c.role}] too close/past deadline, cannot safely challenge`);
    return;
  }
  if (localNonce <= onchainNonce) {
    console.log(`[watch:${c.role}] no newer local state (${localNonce} <= ${onchainNonce})`);
    return;
  }

  console.log(`[watch:${c.role}] submitting challenge: local ${localNonce} > onchain ${onchainNonce}`);
  const tx = await contract.challenge(local.state, local.counterpartySig);
  const rc = await tx.wait(1);
  console.log(`[watch:${c.role}] challenge mined: ${rc.transactionHash}`);
}

async function main() {
  const c = cfg();
  if (!c.rpcUrl || !c.contractAddress || !c.channelId || !c.watcherKey) {
    throw new Error(
      "missing env vars: RPC_URL, CONTRACT_ADDRESS, CHANNEL_ID, WATCHER_PRIVATE_KEY"
    );
  }
  if (c.role !== "agent" && c.role !== "hub") {
    throw new Error("ROLE must be agent or hub");
  }

  const provider = new ethers.providers.JsonRpcProvider(c.rpcUrl);
  const signer = new ethers.Wallet(c.watcherKey, provider);
  const contract = new ethers.Contract(c.contractAddress, ABI, signer);

  console.log(
    `[watch:${c.role}] watching channel ${c.channelId} on ${c.rpcUrl} as ${signer.address}`
  );
  await tick(contract);
  setInterval(() => {
    tick(contract).catch((err) => {
      console.error(`[watch:${c.role}] tick error:`, err.message || err);
    });
  }, c.pollMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { readLocalProof };
