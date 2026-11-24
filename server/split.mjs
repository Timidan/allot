// A sealed bid that no single key opens. Pure bytes with no dependencies, so the browser seals with the same code
// the keeper and the other key holders open with.
//
// The bid is sealed to a fresh key that only the bidder keeps (in their receipt). That key's 32-byte seed is cut
// into three pieces, one per key holder, and each piece is sealed to its holder. Any two holders rebuild the seed;
// one holder alone learns nothing: with random pads a, c and e, holder 0 gets a and c, holder 1 gets seed^a and e,
// holder 2 gets seed^c and seed^e. Every value a holder sees is uniformly random by itself.
export const HOLDERS = 3;
const SEED = 32;
const MAGIC = new TextEncoder().encode("allot2:");

const xor = (x, y) => x.map((v, i) => v ^ y[i]);
const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Cuts a 32-byte seed into one 64-byte piece per holder. */
export function cut(seed, random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  if (seed?.length !== SEED) throw new Error("A seed is 32 bytes.");
  const [a, c, e] = [random(SEED), random(SEED), random(SEED)];
  return [join([a, c]), join([xor(seed, a), e]), join([xor(seed, c), xor(seed, e)])];
}

// Which half of each holder's piece pairs with the other holder's.
const HALVES = { "01": [0, 0], "02": [1, 0], "12": [1, 1] };
/** The seed, from two different holders' pieces. */
export function rebuild(i, pieceI, j, pieceJ) {
  if (i > j) return rebuild(j, pieceJ, i, pieceI);
  const halves = HALVES[`${i}${j}`];
  if (!halves || pieceI?.length !== 2 * SEED || pieceJ?.length !== 2 * SEED) throw new Error("Rebuilding needs two different holders' pieces.");
  const half = (piece, h) => piece.subarray(h * SEED, (h + 1) * SEED);
  return xor(half(pieceI, halves[0]), half(pieceJ, halves[1]));
}

/** True when the bytes claim to be a split bid. An old single-key bid is a bare QoreSeal envelope. */
export const isSplit = (bytes) => bytes.length >= MAGIC.length && MAGIC.every((m, i) => bytes[i] === m);

/** A split bid as it goes on chain: the marker, then the sealed bid and one sealed piece per holder, each with its length. */
export function pack(bid, pieces) {
  if (pieces.length !== HOLDERS) throw new Error("A split bid has one piece per holder.");
  return join([MAGIC, ...[bid, ...pieces].flatMap((p) => {
    if (!p.length || p.length > 0xffff) throw new Error("A part of a split bid is 1 to 65,535 bytes.");
    return [Uint8Array.of(p.length >> 8, p.length & 255), p];
  })]);
}

/** The parts of a split bid, or null when the bytes are not a well-formed one. */
export function unpack(bytes) {
  if (!isSplit(bytes)) return null;
  const parts = [];
  let at = MAGIC.length;
  while (at < bytes.length) {
    if (at + 2 > bytes.length) return null;
    const n = (bytes[at] << 8) | bytes[at + 1];
    at += 2;
    if (!n || at + n > bytes.length) return null;
    parts.push(bytes.subarray(at, at + n));
    at += n;
  }
  return parts.length === 1 + HOLDERS ? { bid: parts[0], pieces: parts.slice(1) } : null;
}

// What each envelope is sealed for. A piece names its sale in the purpose and its bid and holder in the data
// authenticated with it, so a piece copied into another sale, another bid or another holder's place won't open.
export const splitBidPurpose = (saleContract, saleId) => `allot:bid:v2:${saleContract.toLowerCase()}:${saleId}`;
export const piecePurpose = (saleContract, saleId) => `allot:piece:v2:${saleContract.toLowerCase()}:${saleId}`;
export function pieceAad(fingerprint, holder) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(fingerprint) || !(holder >= 0 && holder < HOLDERS)) throw new Error("A piece is tied to a bid's fingerprint and a holder.");
  return Uint8Array.from([...fingerprint.slice(2).match(/../g).map((b) => parseInt(b, 16)), holder]);
}

// ---- A file for the winners ----
// A lot can come with a file only its winners can open. The file's SHA-256 is written into the token's information
// text when the token is issued, before any bid, and each winner's copy is sealed to the key in their own receipt.
export const winnersLine = (sha256) => `Winners receive a file with SHA-256 ${sha256}.`;
export const winnersHash = (information) => /Winners receive a file with SHA-256 ([0-9a-f]{64})\./.exec(information ?? "")?.[1] ?? null;
export const deliveryPurpose = (saleContract, saleId) => `allot:delivery:v1:${saleContract.toLowerCase()}:${saleId}`;
/** What a winners' file may be saved as. The type is the lister's word, so it only ever picks an ending from this list. */
export const WINNERS_TYPES = ["txt", "md", "json", "csv", "pdf", "zip", "png", "jpg", "wav", "mp3"];
/** A copy is tied to the bid it was won with: the bid's fingerprint is authenticated with it. */
export const deliveryAad = (fingerprint) => pieceAad(fingerprint, 0).subarray(0, 32);
