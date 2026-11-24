// The painting, and where its sales live on chain. The page reads every figure from the sale contract.
const file = "Joaqu%C3%ADn_Sorolla%2C_1909_%2851848859147%29.jpg";

export const painting = {
  artist: "Joaquín Sorolla",
  title: "Walk on the Beach",
  details: "1909, oil on canvas, 205 × 200 cm",
  image: `https://upload.wikimedia.org/wikipedia/commons/thumb/b/bb/${file}/1920px-${file}`,
  alt: "Two women in white dresses walk along a windy beach; one holds a parasol, the other a straw hat",
  note: "Testnet sample. The painting hangs in the Museo Sorolla, Madrid; these shares are test tokens and stand for nothing.",
  credit: "Photo: Ángel M. Felicísimo, CC BY 2.0, via Wikimedia Commons",
  source: `https://commons.wikimedia.org/wiki/File:${file}`,
};

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// Bids, deposits and payouts are in fUSD ("FestUSD", QoreChain's testnet dollar). QOR only pays network fees.
export const money = (d) => `${Number(d).toFixed(2)} fUSD`;
export const SALE_CONTRACT = "0x284b10c4760794d25c71dc90183c3dc9b6d1f42a";
// The RPC answers log queries over at most 10,000 blocks (about 4 hours), so each sale lists the block ranges
// its events fall in. ponytail: hand-kept; add a range whenever a sale gets new bids, its opening or its claims.
// The sample sales, newest first (listed sales come from the server). `lot` is what is sold.
export const SALES = [
  { saleId: 2, lot: painting, ranges: [[9961585, 9971584], [9976700, 9976720], [10010760, 10010780], [10197080, 10197100], [10213100, 10213130]] }, // settled 16 Nov 2026: bids, then the opening and claims
  { saleId: 1, lot: painting, ranges: [[9961325, 9971324]] }, // settled; created, bid on, opened and claimed in its first range
];
export const [openSale, lastSale] = SALES; // the landing shows the current sale and replays the last one

let listings;
export function readListings() {
  return (listings ??= fetch("/api/listings")
    .then((r) => (r.ok ? r.json() : []))
    .then((ls) => (Array.isArray(ls) ? ls : []).map((l) => ({
      saleId: l.saleId, closeAt: l.closeAt, done: l.done, backupSaleId: l.backupSaleId, ranges: [[l.createBlock, l.createBlock + 9999]],
      lot: {
        title: l.title, artist: l.by, details: l.about, alt: `${l.title}, by ${l.by}`,
        image: l.kind === "image" ? l.file : null, audio: l.kind === "audio" ? l.file : null, peaks: l.peaks ?? "", consigned: true, split: Boolean(l.split), winners: l.winners, winnersType: l.winnersType,
        note: "Listed by its owner; Allot runs the sale. Testnet sample: these shares are test tokens and stand for nothing.", credit: "",
      },
    })))
    .catch(() => []));
}
