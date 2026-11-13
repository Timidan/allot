// Reads sales from the sale contract over the EVM RPC (it allows any web origin).
import { qorechainTestnet, toQorAddress } from "@qorechain/evm";
import { createPublicClient, decodeEventLog, hexToBytes, http, parseAbi } from "viem";

export const pub = createPublicClient({ chain: qorechainTestnet, transport: http("https://evm-testnet.qore.host") });
const abi = parseAbi([
  "function getSale(uint256) view returns ((address issuer, address asset, uint64 closeAt, uint64 openBy, uint128 supply, uint128 reserve, uint128 deposit, uint128 unit, uint128 clearing, uint128 sold, uint128 penaltyShare, uint128 earned, uint128 paid, uint32 opened, bool settled))",
  "function bidCount(uint256) view returns (uint256)",
  "event BidOpened(uint256 indexed saleId, uint256 indexed bidIndex, uint128 price, uint128 qty)",
  "event Claimed(uint256 indexed saleId, uint256 indexed bidIndex, uint256 assetAmount, uint256 refund)",
  "event BidPlaced(uint256 indexed saleId, uint256 indexed bidIndex, address indexed bidder, bytes32 fingerprint, bytes envelope)",
  "event SaleCreated(uint256 indexed saleId, address indexed issuer, address asset, string issuerCard)",
]);

// The card a sale's bids are sealed to: the one its issuer published in the sale itself (SaleCreated), which sits in
// the sale's first block range.
// The card must name the account that created the sale, or the bid would be sealed to someone else.
export async function readCard(address, s) {
  const [[from, to]] = await upTo(s.ranges.slice(0, 1));
  const [[e], sale] = await Promise.all([
    pub.getContractEvents({ address, abi, eventName: "SaleCreated", args: { saleId: BigInt(s.saleId) }, fromBlock: BigInt(from), toBlock: BigInt(to) }),
    pub.readContract({ address, abi, functionName: "getSale", args: [BigInt(s.saleId)] }),
  ]);
  if (!e) throw new Error("Couldn't find this sale's sealing key on QoreChain testnet. Try again in a minute.");
  const card = JSON.parse(e.args.issuerCard);
  if (card.address !== toQorAddress(sale.issuer)) throw new Error("This sale's sealing key doesn't belong to its seller, so Allot won't seal a bid to it.");
  return card;
}
const dollars = (x) => Number(x) / 1e6; // fUSD has 6 decimals

export async function readSale(address, saleId) {
  const id = BigInt(saleId);
  const [s, n] = await Promise.all([
    pub.readContract({ address, abi, functionName: "getSale", args: [id] }),
    pub.readContract({ address, abi, functionName: "bidCount", args: [id] }),
  ]);
  return {
    issuer: toQorAddress(s.issuer), // the seller, whose registered key every bid is sealed to
    supply: Number(s.supply), reserve: dollars(s.reserve), deposit: dollars(s.deposit), closeAt: Number(s.closeAt) * 1000,
    settled: s.settled, clearing: dollars(s.clearing), sold: Number(s.sold), bids: Number(n), opened: s.opened,
  };
}

// Block ranges cut at the chain's latest block: the RPC refuses a log query that ends in the future, which a new
// sale's first 10,000-block range does.
const upTo = async (ranges) => {
  const latest = Number(await pub.getBlockNumber());
  return ranges.filter(([from]) => from <= latest).map(([from, to]) => [from, Math.min(to, latest)]);
};

// The opened book of a settled sale: who bid what, what each won and got back, with transactions.
export async function readBook(address, saleId, wanted) {
  const ranges = await upTo(wanted);
  const events = (eventName) =>
    Promise.all(ranges.map(([from, to]) => pub.getContractEvents({ address, abi, eventName, args: { saleId: BigInt(saleId) }, fromBlock: BigInt(from), toBlock: BigInt(to) }))).then((r) => r.flat());
  const [all, opened, claimed] = await Promise.all(["BidPlaced", "BidOpened", "Claimed"].map(events));
  const placed = all.filter((e, i) => all.findIndex((x) => x.transactionHash === e.transactionHash && x.logIndex === e.logIndex) === i);
  return placed.map(({ args, transactionHash, blockNumber }) => {
    const o = opened.find((e) => e.args.bidIndex === args.bidIndex);
    const c = claimed.find((e) => e.args.bidIndex === args.bidIndex);
    return {
      bidder: args.bidder, tx: transactionHash, block: Number(blockNumber), bytes: (args.envelope.length - 2) / 2,
      envelope: hexToBytes(args.envelope), fingerprint: hexToBytes(args.fingerprint),
      price: o ? dollars(o.args.price) : null, shares: o ? Number(o.args.qty) : null, openTx: o?.transactionHash, openBlock: o && Number(o.blockNumber),
      won: c ? Number(c.args.assetAmount) : null, refund: c ? dollars(c.args.refund) : null, claimTx: c?.transactionHash, claimBlock: c && Number(c.blockNumber),
    };
  });
}

// A sale's block ranges: the hand-kept ones in sale.js, plus the block of every guest bid the server placed.
export async function rangesOf(s) {
  const guest = await fetch(`/api/bids?sale=${s.saleId}`)
    .then((r) => (r.ok ? r.json() : []))
    .then((list) => (Array.isArray(list) ? list : []))
    .catch(() => []); // no guest server (or not JSON): the hand-kept ranges still work
  return [...s.ranges, ...guest.map((b) => [b.block, b.block])];
}

// QoreChain's REST API, read through the page's own /rest relay (the API sends no CORS headers).
const rest = (path) => fetch(`${location.origin}/rest${path}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} for ${path}`))));

// An EVM address as its qor1… account (the same 20 bytes), by QoreChain's EVM kit.
export const toQor = (evm) => toQorAddress(evm);

// The EVM window that let `evm` send a transaction in `block`: opened by a transaction signed with ML-DSA-87.
export async function readWindow(evm, block) {
  const q = encodeURIComponent(`message.sender='${toQor(evm)}' AND message.action='/qorechain.pqc.v1.MsgOpenEVMWindow'`);
  const { tx_responses: txs = [] } = await rest(`/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&pagination.limit=20`);
  for (const t of txs) {
    const m = t.tx.body.messages[0];
    const from = Number(t.height);
    if (from <= block && block < from + Number(m.blocks)) {
      return { tx: t.txhash, from, blocks: Number(m.blocks), maxTxs: Number(m.max_txs), targets: m.allowed_targets };
    }
  }
  return null;
}

// One transaction, read from QoreChain testnet directly (the public explorer opens on mainnet for new visitors).
// An EVM hash (0x…) is a bid, an opening or a payout; a bare hash is a native transaction, such as a pass opening.
const attrs = (r, type) => r?.events?.find((e) => e.type === type)?.attributes.reduce((o, a) => ({ ...o, [a.key]: a.value }), {});
const qor = (coins = []) => coins.reduce((sum, c) => sum + Number(c.amount) / (c.denom === "aqor" ? 1e18 : c.denom === "uqor" ? 1e6 : Infinity), 0);
export async function readTx(hash) {
  if (/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    const q = encodeURIComponent(`ethereum_tx.ethereumTxHash='${hash.toLowerCase()}'`);
    const [found, rc] = await Promise.all([rest(`/cosmos/tx/v1beta1/txs?query=${q}`), pub.getTransactionReceipt({ hash })]);
    const c = found.tx_responses?.[0];
    const events = rc.logs.flatMap((l) => {
      try { return [decodeEventLog({ abi, data: l.data, topics: l.topics })]; } catch { return []; }
    });
    const used = attrs(c, "pqc_evm_window_used");
    const window = used ? await readWindow(rc.from, Number(used.window_open_height)).catch(() => null) : null;
    return {
      evm: true, hash, ok: rc.status === "success", block: Number(rc.blockNumber), time: c?.timestamp, from: rc.from, to: rc.to,
      fee: qor(c?.tx?.auth_info?.fee?.amount), events,
      pass: used && { tx: window?.tx, opened: Number(used.window_open_height), used: Number(used.used_txs), max: window?.maxTxs },
    };
  }
  const { tx_response: r, tx } = await rest(`/cosmos/tx/v1beta1/txs/${hash}`);
  const verify = attrs(r, "pqc_hybrid_verify");
  const opened = attrs(r, "pqc_evm_window_opened");
  return {
    evm: false, hash, ok: r.code === 0, block: Number(r.height), time: r.timestamp, from: attrs(r, "message")?.sender ?? verify?.address,
    fee: qor(tx.auth_info.fee.amount), messages: tx.body.messages.map((m) => m["@type"]),
    pq: verify && { verified: verify.status === "verified", algorithm: verify.algorithm_id },
    pass: opened && { until: Number(opened.expiry_height), max: Number(opened.max_txs), targets: opened.allowed_targets.split(",") },
  };
}
