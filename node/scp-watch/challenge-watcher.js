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
  "function getChannelsByParticipant(address participant) view returns (bytes32[])",
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

function readLocalProofForChannel(channelId, role) {
  const c = cfg();
  if (role === "hub") {
    const store = loadJson(c.hubStorePath);
    const ch = (store.channels || {})[channelId];
    if (!ch || !ch.latestState || !ch.sigA) return null;
    return { state: ch.latestState, counterpartySig: ch.sigA };
  }

  const state = loadJson(c.agentStatePath);
  const watch = ((state.watch || {}).byChannelId || {})[channelId];
  if (!watch || !watch.state || !watch.sigB) return null;
  return { state: watch.state, counterpartySig: watch.sigB };
}

async function tickChannel(contract, channelId, role, safetyBufferSec) {
  const local = readLocalProofForChannel(channelId, role);
  if (!local) return;

  const onchain = await contract.getChannel(channelId);
  if (!onchain.participantA || onchain.participantA === ethers.constants.AddressZero) return;
  if (!onchain.isClosing) return;

  const onchainNonce = Number(onchain.latestNonce);
  const localNonce = Number(local.state.stateNonce);
  const closeDeadline = Number(onchain.closeDeadline);
  const ts = now();

  if (ts + safetyBufferSec >= closeDeadline) {
    console.log(`[watch:${role}] ${channelId.slice(0, 10)}... too close/past deadline`);
    return;
  }
  if (localNonce <= onchainNonce) return;

  console.log(`[watch:${role}] ${channelId.slice(0, 10)}... challenging: local ${localNonce} > onchain ${onchainNonce}`);
  const tx = await contract.challenge(local.state, local.counterpartySig);
  const rc = await tx.wait(1);
  console.log(`[watch:${role}] challenge mined: ${rc.transactionHash}`);
}

async function tick(contract, channelIds, role, safetyBufferSec) {
  for (const id of channelIds) {
    await tickChannel(contract, id, role, safetyBufferSec).catch((err) => {
      console.error(`[watch:${role}] ${id.slice(0, 10)}... error:`, err.message || err);
    });
  }
}

async function discoverChannels(contract, address) {
  try {
    return await contract.getChannelsByParticipant(address);
  } catch (_e) {
    return [];
  }
}

async function main() {
  const c = cfg();
  if (!c.rpcUrl || !c.contractAddress || !c.watcherKey) {
    throw new Error("missing env vars: RPC_URL, CONTRACT_ADDRESS, WATCHER_PRIVATE_KEY");
  }
  if (c.role !== "agent" && c.role !== "hub") {
    throw new Error("ROLE must be agent or hub");
  }

  const provider = new ethers.providers.JsonRpcProvider(c.rpcUrl);
  const signer = new ethers.Wallet(c.watcherKey, provider);
  const contract = new ethers.Contract(c.contractAddress, ABI, signer);

  let channelIds;
  if (c.channelId) {
    channelIds = [c.channelId];
    console.log(`[watch:${c.role}] watching channel ${c.channelId} as ${signer.address}`);
  } else {
    channelIds = await discoverChannels(contract, signer.address);
    console.log(`[watch:${c.role}] discovered ${channelIds.length} channels for ${signer.address}`);
    if (channelIds.length === 0) {
      console.log(`[watch:${c.role}] no channels found, will re-discover each poll`);
    }
  }

  const runTick = async () => {
    if (!c.channelId) {
      channelIds = await discoverChannels(contract, signer.address);
    }
    await tick(contract, channelIds, c.role, c.safetyBufferSec);
  };

  await runTick();
  setInterval(() => {
    runTick().catch((err) => {
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

module.exports = { readLocalProofForChannel, discoverChannels };
