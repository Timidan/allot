// Consignment: Allot runs the sale of something a visitor listed. One account (the consign issuer) issues each
// item's token from the Asset Kit's CMTAT build, holds the key that opens the bids, and settles after the close.
// The keeper works from chain state only, so a restart is safe.
import { readFileSync } from "node:fs";
import { REGISTER_KEM_KEY_TYPE_URL, buildRegisterPqcKeyMsg, signProofOfPossession } from "@qorechain/sdk";
import { deriveSealKeys, open, signRecipientCard } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { decodeEventLog, encodeAbiParameters, hexToBytes, keccak256, parseAbi, toBytes, zeroAddress } from "viem";
import { CHAIN_ID, REST, SALE, chain, pub } from "./kit.mjs";

const RULE = "0x5d7a6de418a3d7d3c280c7e1856830942d394872"; // the Asset Kit holder rule: holders need a registered ML-DSA-87 key
const TOKEN = JSON.parse(readFileSync(new URL("./kit/CMTATStandalone.json", import.meta.url), "utf8"));
const MINTER = keccak256(toBytes("MINTER_ROLE"));
export const OPEN_FOR = 2n * 86400n; // seconds after the close in which bids can be opened
const abi = parseAbi([
  "function createSale(address asset, uint128 supply, uint128 reserve, uint128 deposit, uint64 closeAt, uint64 openBy, string issuerCard) returns (uint256)",
  "function getSale(uint256) view returns ((address issuer, address asset, uint64 closeAt, uint64 openBy, uint128 supply, uint128 reserve, uint128 deposit, uint128 unit, uint128 clearing, uint128 sold, uint128 penaltyShare, uint128 earned, uint128 paid, uint32 opened, bool settled))",
  "function bidCount(uint256) view returns (uint256)",
  "function bids(uint256, uint256) view returns (address bidder, bytes32 fingerprint, uint128 price, uint128 qty, uint128 filled, bool opened, bool claimed)",
  "function openBids(uint256 saleId, uint256[] bidIndexes, uint128[] prices, uint128[] qtys, bytes32[] salts)",
  "function settle(uint256 saleId)",
  "function claim(uint256 saleId, uint256 bidIndex)",
  "function payProceeds(uint256 saleId)",
  "function isHybridHolder(address) view returns (bool)",
  "event SaleCreated(uint256 indexed saleId, address indexed issuer, address asset, string issuerCard)",
  "event BidPlaced(uint256 indexed saleId, uint256 indexed bidIndex, address indexed bidder, bytes32 fingerprint, bytes envelope)",
]);
const sale = { address: SALE, abi };
const roles = parseAbi(["function grantRole(bytes32 role, address account)"]);

// The same purpose and fingerprint as web/src/lib/bid.js; the browser seals with them, the keeper opens with them.
const purpose = (saleId) => `allot:bid:v1:${SALE.toLowerCase()}:${saleId}`;
const fingerprintOf = (saleId, bidder, price, qty, salt) =>
  keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }], [BigInt(saleId), bidder, BigInt(price), BigInt(qty), salt]));

// Opens one sealed bid with the issuer's keys and checks it the way the contract will at opening. Returns the bid,
// or null with the reason in `why` when it could never be opened (so the keeper skips it and the guest server
// refuses to place it).
export function checkBid(keys, saleId, bidder, fingerprint, envelopeHex, deposit) {
  let bid;
  try {
    bid = JSON.parse(new TextDecoder().decode(open({ chainId: CHAIN_ID, purpose: purpose(saleId), envelope: hexToBytes(envelopeHex), keys })));
  } catch (x) {
    return { why: `it can't be opened (${x.message})` };
  }
  const fits = BigInt(bid.price) > 0n && BigInt(bid.qty) > 0n && BigInt(bid.price) * BigInt(bid.qty) <= BigInt(deposit);
  if (!fits) return { why: "price × shares exceeds the deposit" };
  if (fingerprintOf(saleId, bidder, bid.price, bid.qty, bid.salt) !== fingerprint) return { why: "it doesn't match its fingerprint" };
  return { price: BigInt(bid.price), qty: BigInt(bid.qty), salt: bid.salt };
}

// Readies the issuer once: its ML-DSA-87 key, its encryption key, and the card bidders seal to. Returns the card.
export async function setupIssuer(kit, a, mnemonic, log = () => {}) {
  if (!(await pub.readContract({ ...sale, functionName: "isHybridHolder", args: [a.evm] }))) {
    const msg = buildRegisterPqcKeyMsg(a.cosmos, { pqcKeypair: a.pqc, ecdsaPubkey: hexToBytes(a.publicKey), proofOfPossession: signProofOfPossession({ chainId: CHAIN_ID, account: a.cosmos, keypair: a.pqc }) });
    log("registered its ML-DSA-87 key, tx", await kit.native(a, [msg], { classical: true }));
  }
  const keys = deriveSealKeys({ mnemonic, index: a.index });
  if (!(await fetchKemKey({ rest: REST, address: a.cosmos })).registered) {
    log("registered its encryption key, tx", await kit.native(a, [{ typeUrl: REGISTER_KEM_KEY_TYPE_URL, value: { sender: a.cosmos, algorithmId: 2, publicKey: keys.mlkemPublicKey } }]));
  }
  const card = signRecipientCard({ chainId: CHAIN_ID, address: a.cosmos, keys, classicalKey: { type: "eth_secp256k1", privateKey: hexToBytes(a.privateKey), publicKey: hexToBytes(a.publicKey) }, pqKey: a.pqc });
  return { card: JSON.stringify(card), keys };
}

// One listing: the item's token (its terms name the file and its SHA-256), the minter role for the sale contract,
// then the sale. Three transactions from the issuer.
export async function createListing(kit, a, card, { title, about, fileUrl, sha256, supply, reserve, deposit, seconds }) {
  await kit.ensureWindow(a); // unscoped: a scoped window refuses contract creation
  const symbol = title.replace(/[^A-Za-z0-9]/g, "").slice(0, 6).toUpperCase() || "SHARE";
  // ponytail: viem's deployContract, not @qorechain/evm's: the kit's takes no gas limit, and the RPC estimates only up to 5,000,000.
  const deployTx = await a.wallet.deployContract({
    abi: TOKEN.abi, bytecode: TOKEN.bytecode.object, chain, gas: 7_000_000n,
    args: [zeroAddress, a.evm, { name: `${title} shares (testnet)`, symbol, decimalsIrrevocable: 0 },
      { tokenId: `ALLOT-${sha256.slice(0, 12)}`, terms: { name: "Testnet sample: confers no ownership", uri: fileUrl, documentHash: `0x${sha256}` }, information: about || `Testnet shares in ${title}.` },
      { ruleEngine: RULE }],
  });
  const deployed = await pub.waitForTransactionReceipt({ hash: deployTx });
  if (deployed.status !== "success") throw new Error(`token deploy reverted: ${deployTx}`);
  const token = deployed.contractAddress;
  const grant = await kit.evm(a, { address: token, abi: roles, functionName: "grantRole", args: [MINTER, SALE] });
  const closeAt = (await pub.getBlock()).timestamp + BigInt(seconds);
  const rc = await kit.evm(a, { ...sale, functionName: "createSale", args: [token, BigInt(supply), BigInt(reserve), BigInt(deposit), closeAt, closeAt + OPEN_FOR, card] });
  const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e?.eventName === "SaleCreated");
  return { saleId: Number(ev.args.saleId), token, createBlock: Number(rc.blockNumber), closeAt: Number(closeAt) * 1000, txs: { deploy: deployTx, grant: grant.transactionHash, create: rc.transactionHash } };
}

// Every BidPlaced of a sale between two blocks, in slices the RPC accepts (10,000 blocks).
export async function bidsOf(saleId, fromBlock, toBlock) {
  const latest = BigInt(toBlock ?? (await pub.getBlockNumber()));
  const out = [];
  for (let from = BigInt(fromBlock); from <= latest; from += 10_000n) {
    const to = from + 9_999n < latest ? from + 9_999n : latest;
    out.push(...(await pub.getContractEvents({ ...sale, eventName: "BidPlaced", args: { saleId: BigInt(saleId) }, fromBlock: from, toBlock: to })));
  }
  return out;
}

// After the close: open what can be opened, settle, claim every bid, pay proceeds. Each step is skipped when the
// chain shows it done. Returns true once the sale is fully finished.
export async function finish(kit, a, keys, listing, log = () => {}) {
  const id = BigInt(listing.saleId);
  let s = await pub.readContract({ ...sale, functionName: "getSale", args: [id] });
  const now = (await pub.getBlock()).timestamp;
  if (now < s.closeAt) return false;
  const placed = await bidsOf(id, listing.createBlock);
  // The blocks of the sale's bids and of the keeper's own transactions, so the page can find every event even when
  // the opening and claims land long after the sale's first 10,000 blocks.
  listing.bidBlocks = placed.map((e) => Number(e.blockNumber));
  const note = (rc) => listing.bidBlocks.push(Number(rc.blockNumber));
  const state = await Promise.all(placed.map((e) => pub.readContract({ ...sale, functionName: "bids", args: [id, e.args.bidIndex] })));
  await kit.ensureWindow(a);
  if (!s.settled && now < s.openBy) {
    const opened = [];
    for (const [i, { args: e }] of placed.entries()) {
      if (state[i][5]) continue; // already opened
      const bid = checkBid(keys, id, e.bidder, e.fingerprint, e.envelope, s.deposit);
      if (bid.why) log(`sale ${id} bid ${e.bidIndex}: left unopened, ${bid.why}`);
      else opened.push({ index: e.bidIndex, ...bid });
    }
    if (opened.length) {
      const rc = await kit.evm(a, { ...sale, functionName: "openBids", args: [id, opened.map((o) => o.index), opened.map((o) => o.price), opened.map((o) => o.qty), opened.map((o) => o.salt)] });
      note(rc);
      log(`sale ${id}: opened ${opened.length} bids, tx ${rc.transactionHash}`);
    }
  }
  if (!s.settled) {
    try {
      const rc = await kit.evm(a, { ...sale, functionName: "settle", args: [id] });
      note(rc);
      log(`sale ${id}: settled, tx ${rc.transactionHash}`);
    } catch (x) {
      log(`sale ${id}: can't settle yet (${x.shortMessage ?? x.message})`); // some bid is unopened: settle waits for openBy
      return false;
    }
  }
  for (const [i, { args: e }] of placed.entries()) {
    if ((await pub.readContract({ ...sale, functionName: "bids", args: [id, e.bidIndex] }))[6]) continue; // claimed
    const rc = await kit.evm(a, { ...sale, functionName: "claim", args: [id, e.bidIndex] });
    note(rc);
    log(`sale ${id}: claimed bid ${e.bidIndex}, tx ${rc.transactionHash}`);
  }
  s = await pub.readContract({ ...sale, functionName: "getSale", args: [id] });
  if (s.earned > s.paid) {
    const rc = await kit.evm(a, { ...sale, functionName: "payProceeds", args: [id] });
    note(rc);
    log(`sale ${id}: proceeds paid, tx ${rc.transactionHash}`);
  }
  return true;
}
