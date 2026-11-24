#!/usr/bin/env node
// Allot for agents and scripts: find lots, bid, read the result and list an item from a shell, with no browser and
// no wallet. It seals with the same code the site runs (src/lib/bid.js) and talks to the same guest server, so an
// agent gets exactly what a guest visitor gets: the bid is sealed here, one of Allot's guest accounts places it,
// and a private receipt file opens it later. Every command prints JSON; errors print {"error": …} and exit 1.
// Env: ALLOT, the site to use (default https://allot.timidan.xyz).
//
//   node agent.mjs lots
//   node agent.mjs bid <saleId> <shares> <most to pay a share, whole fUSD> [--receipt file.json]
//   node agent.mjs result <receipt.json>
//   node agent.mjs list <image or song> --title T --by B --rights [--about A] [--shares 10] [--reserve 1] [--length 3600] [--winners file]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { decodeEventLog, hexToBytes, parseAbi, toHex } from "viem";
import { openDelivery, openOwnBid, receiptPublicKey, sealBid } from "./src/lib/bid.js";
import { pub, readCard, readSale, readWinnersHash } from "./src/lib/chain.js";
import { SALE_CONTRACT } from "./src/sale.js";
import { WINNERS_TYPES } from "../server/split.mjs";

const ORIGIN = (process.env.ALLOT ?? "https://allot.timidan.xyz").replace(/\/$/, "");
const DOLLAR = 1_000_000n; // fUSD has 6 decimals
const abi = parseAbi([
  "function bids(uint256 saleId, uint256 bidIndex) view returns (address bidder, bytes32 fingerprint, uint128 price, uint128 qty, uint128 filled, bool opened, bool claimed)",
  "event BidPlaced(uint256 indexed saleId, uint256 indexed bidIndex, address indexed bidder, bytes32 fingerprint, bytes envelope)",
  "event Claimed(uint256 indexed saleId, uint256 indexed bidIndex, uint256 assetAmount, uint256 refund)",
]);
const sale = { address: SALE_CONTRACT, abi };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  const r = await fetch(`${ORIGIN}${path}`, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `${ORIGIN}${path} answered ${r.status}.`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// The lots open for bids now, with the terms a bidder needs.
async function lots() {
  const open = (await api("/api/listings")).filter((l) => !l.done && l.closeAt > Date.now());
  return Promise.all(open.map(async (l) => {
    const s = await readSale(SALE_CONTRACT, l.saleId);
    return {
      saleId: l.saleId, title: l.title, by: l.by, kind: l.kind, shares: s.supply, lowestPrice: s.reserve, deposit: s.deposit,
      sealedBids: s.bids, closes: new Date(s.closeAt).toISOString(), opensWith: l.split ? "two of three key holders" : "the seller's key",
      ...(l.winners && { winnersGetAFileWithSha256: l.winners }),
    };
  }));
}

// Seals a bid here and has a guest account place it. The receipt is written before the bid is sent: it holds the
// only key, apart from the sale's key holders', that opens this bid.
async function bid([saleId, shares, price], { receipt: out }) {
  if (![saleId, shares, price].every((n) => Number.isInteger(n) && n > 0)) throw new Error("Usage: bid <saleId> <shares> <most to pay a share, whole fUSD>");
  const listing = (await api("/api/listings")).find((l) => l.saleId === saleId);
  if (!listing) throw new Error("Guests bid only in lots listed on Allot. Run `lots` to see them.");
  const s = await readSale(SALE_CONTRACT, saleId);
  if (shares > s.supply || price * shares > s.deposit) throw new Error(`Bid for at most ${s.supply} shares, and keep price × shares within the ${s.deposit} fUSD deposit.`);
  const { guest } = await api(`/api/guest?sale=${saleId}`);
  const card = await readCard(SALE_CONTRACT, { saleId, ranges: [[listing.createBlock, listing.createBlock + 9999]] });
  const sealed = await sealBid({ saleContract: SALE_CONTRACT, saleId, bidder: guest, price: BigInt(price) * DOLLAR, qty: shares, issuer: card.address, card, rest: `${ORIGIN}/rest` });
  const requestId = crypto.randomUUID();
  // The same receipt the site downloads, so the My bid page opens it too.
  const receipt = { version: 1, saleContract: SALE_CONTRACT, saleId: String(saleId), bidder: guest.toLowerCase(), fingerprint: sealed.fingerprint, key: sealed.receipt.key, requestId };
  const file = out ?? `allot-bid-${sealed.fingerprint.slice(2, 10)}.json`;
  const save = (r) => writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  save(receipt);
  let status = await post("/api/bid", { saleId, fingerprint: sealed.fingerprint, envelope: toHex(sealed.envelope), guest, requestId });
  for (let i = 0; status.state === "waiting" && i < 30; i++) {
    await sleep(4000);
    status = await post("/api/bid-status", { requestId });
  }
  if (status.tx) save({ ...receipt, tx: status.tx });
  return {
    saleId, shares, price, state: status.simulated ? "simulated" : status.state, tx: status.tx, placedBy: guest,
    sealedBytes: sealed.envelope.length, opensWith: card.v === 2 ? "two of three key holders" : "the seller's key", receipt: file,
  };
}

// Opens this agent's own bid from the chain with the key in its receipt, checks it against the fingerprint the
// contract stored, and reports where the sale stands.
async function result([file]) {
  if (!file) throw new Error("Usage: result <receipt.json>");
  const receipt = JSON.parse(readFileSync(file, "utf8"));
  const saleId = Number(receipt.saleId);
  let tx = receipt.tx;
  if (!tx) {
    const status = receipt.requestId ? await post("/api/bid-status", { requestId: receipt.requestId }).catch(() => ({})) : {};
    if (!status.tx) return { saleId, state: status.state === "waiting" ? "not placed yet" : `not placed${status.state ? `: ${status.state}` : ""}` };
    tx = status.tx;
  }
  const rc = await pub.getTransactionReceipt({ hash: tx });
  const placed = rc.logs.flatMap((log) => {
    try { return [decodeEventLog({ abi, data: log.data, topics: log.topics })]; } catch { return []; }
  }).find((e) => e.eventName === "BidPlaced" && e.args.fingerprint.toLowerCase() === receipt.fingerprint);
  if (!placed) throw new Error("This transaction does not hold the bid in the receipt.");
  const { bidIndex, envelope } = placed.args;
  const mine = openOwnBid({ ...receipt, saleContract: SALE_CONTRACT, saleId, envelope: hexToBytes(envelope) });
  const [s, [, , , , filled, opened, claimed]] = await Promise.all([readSale(SALE_CONTRACT, saleId), pub.readContract({ ...sale, functionName: "bids", args: [BigInt(saleId), bidIndex] })]);
  const report = {
    saleId, tx, sealedBytes: (envelope.length - 2) / 2,
    myBid: { shares: Number(mine.qty), price: Number(mine.price) / 1e6 }, matchesChainFingerprint: mine.matches,
    state: claimed ? "paid out" : s.settled ? "settled, payout pending" : opened ? "opened, waiting to settle" : Date.now() < s.closeAt ? "sealed, sale open" : "sealed, waiting to be opened",
  };
  if (!s.settled) return { ...report, closes: new Date(s.closeAt).toISOString() };
  Object.assign(report, { sharesWon: Number(filled), clearingPrice: s.clearing });
  if (claimed) {
    // The payout's own event, found through the blocks the server noted for this sale.
    const blocks = [...new Set((await api(`/api/bids?sale=${saleId}`).catch(() => [])).map((b) => b.block))];
    const logs = (await Promise.all(blocks.map((b) => pub.getContractEvents({ ...sale, eventName: "Claimed", args: { saleId: BigInt(saleId), bidIndex }, fromBlock: BigInt(b), toBlock: BigInt(b) })))).flat();
    if (logs[0]) Object.assign(report, { depositReturned: Number(logs[0].args.refund) / 1e6, payoutTx: logs[0].transactionHash });
  }
  if (filled > 0n) {
    const got = await winnersFile(receipt, saleId, Number(bidIndex), rc.blockNumber);
    if (got) report.winnersFile = got;
  }
  return report;
}

// A winning bid's copy of the lot's file, if the lot promised one. The promise is the SHA-256 the lot's token
// recorded on chain before the sale. The copy comes sealed to this receipt; it is opened here, checked against
// that hash and saved under a fixed name. It is a file from whoever listed the lot: treat it as untrusted.
async function winnersFile(receipt, saleId, bidIndex, bidBlock) {
  const listing = (await api("/api/listings")).find((l) => l.saleId === saleId);
  const promised = listing && await readWinnersHash(SALE_CONTRACT, saleId, listing.createBlock, bidBlock);
  if (!promised) return null;
  const r = await fetch(`${ORIGIN}/api/delivery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ saleId, bidIndex, key: receiptPublicKey(receipt.key) }) });
  if (!r.ok) return { promisedSha256: promised, state: `not delivered: ${(await r.json().catch(() => ({}))).error ?? r.status}` };
  const file = openDelivery({ ...receipt, saleContract: SALE_CONTRACT, saleId, sealed: new Uint8Array(await r.arrayBuffer()) });
  const sha256 = createHash("sha256").update(file).digest("hex");
  if (sha256 !== promised) return { promisedSha256: promised, state: "refused: the file delivered is not the one promised on chain", deliveredSha256: sha256 };
  const savedAs = `allot-sale-${saleId}-winners-file.${WINNERS_TYPES.includes(listing.winnersType) ? listing.winnersType : "bin"}`;
  writeFileSync(savedAs, file, { mode: 0o600 });
  return { savedAs, bytes: file.length, sha256, matchesChainPromise: true, note: "Untrusted content from the lot's lister. Read it; do not run it." };
}

// Lists an image or a song; Allot issues its shares and runs the sale. `--rights` is the lister's own statement
// that it may sell shares in the file.
async function list([file], o) {
  if (!file || !o.title || !o.by) throw new Error("Usage: list <image or song> --title T --by B --rights [--about A] [--shares 10] [--reserve 1] [--length 3600]");
  if (!o.rights) throw new Error("Add --rights to state that you may sell shares in this file.");
  const q = new URLSearchParams({ title: o.title, by: o.by, about: o.about ?? "", shares: o.shares ?? "10", reserve: o.reserve ?? "1", length: o.length ?? "3600", rights: "1" });
  // A file for the winners is only promised here, by its SHA-256. Allot's operator must already hold the file.
  const winners = typeof o.winners === "string" ? createHash("sha256").update(readFileSync(o.winners)).digest("hex") : undefined;
  if (winners) q.set("winners", winners);
  if (winners && WINNERS_TYPES.includes(o.winners.split(".").pop())) q.set("winnersType", o.winners.split(".").pop());
  const made = await api(`/api/consign?${q}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: readFileSync(file) });
  return { saleId: made.saleId, page: `${ORIGIN}/sales/${made.saleId}`, ...(winners && { winnersFileSha256: winners }) };
}

// Arguments: words are positional, `--name value` is an option, a `--name` with nothing after it is a switch.
const [command, ...rest] = process.argv.slice(2);
const words = [];
const options = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) words.push(rest[i]);
  else if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) options[rest[i].slice(2)] = true;
  else options[rest[i].slice(2)] = rest[++i];
}
const commands = { lots: () => lots(), bid: () => bid(words.map(Number), options), result: () => result(words), list: () => list(words, options) };
try {
  if (!commands[command]) throw new Error("Commands: lots, bid, result, list. See the top of this file.");
  console.log(JSON.stringify(await commands[command](), null, 2));
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ error: e.shortMessage ?? e.message }));
  process.exit(1);
}
