const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://mainnet.base.org");

const CONTRACT = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";
const CHANNEL_ID = "0x8875568F529BBA388542EA5D0E1D524D09DA520AEDFBF2CD20553BBB687D4D09";

const ABI = [
  "function getChannel(bytes32 channelId) external view returns (tuple(address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce, uint8 hubFlags))",
  "function DOMAIN_SEPARATOR() external view returns (bytes32)"
];

const ZERO = "0x0000000000000000000000000000000000000000";

(async () => {
  console.log("=== Base Mainnet (chainId 8453) ===");
  console.log("Contract:", CONTRACT);

  const code = await provider.getCode(CONTRACT);
  if (code === "0x") {
    console.log("Status: NOT DEPLOYED");
    return;
  }
  console.log("Status: DEPLOYED (code size:", (code.length - 2) / 2, "bytes)");

  const contract = new ethers.Contract(CONTRACT, ABI, provider);
  const ds = await contract.DOMAIN_SEPARATOR();
  console.log("DOMAIN_SEPARATOR:", ds);

  // Raw call to getChannel to handle zero-filled returns
  const iface = new ethers.utils.Interface(ABI);
  const calldata = iface.encodeFunctionData("getChannel", [CHANNEL_ID]);
  const raw = await provider.call({ to: CONTRACT, data: calldata });
  console.log("\nChannel:", CHANNEL_ID);
  console.log("Raw response length:", raw.length);

  const decoded = iface.decodeFunctionResult("getChannel", raw);
  const ch = decoded[0];
  console.log("  participantA:", ch.participantA);
  console.log("  participantB:", ch.participantB);
  console.log("  asset:", ch.asset);
  console.log("  challengePeriodSec:", ch.challengePeriodSec.toString());
  console.log("  channelExpiry:", ch.channelExpiry.toString());
  console.log("  totalBalance (raw):", ch.totalBalance.toString());
  console.log("  isClosing:", ch.isClosing);
  console.log("  closeDeadline:", ch.closeDeadline.toString());
  console.log("  latestNonce:", ch.latestNonce.toString());
  console.log("  hubFlags:", ch.hubFlags);

  if (ch.participantA === ZERO) {
    console.log("\n  => Channel does NOT exist (empty slot — not yet opened)");
  } else {
    const isUsdc = ch.asset.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const label = isUsdc ? "USDC" : (ch.asset === ZERO ? "ETH" : ch.asset);
    const fmt = isUsdc
      ? ethers.utils.formatUnits(ch.totalBalance, 6)
      : ethers.utils.formatEther(ch.totalBalance);
    console.log("\n  => Channel EXISTS");
    console.log("     Asset:", label);
    console.log("     Total balance:", fmt, label);
    if (ch.isClosing) {
      console.log("     WARNING: Channel is CLOSING, deadline:", new Date(ch.closeDeadline * 1000).toISOString());
    }
  }
})().catch(e => console.error("Fatal:", e.message));
