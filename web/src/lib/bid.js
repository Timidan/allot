import { generateSealKeys, open, recipientOf, seal, sealKeysFromSeed } from "@qorechain/qoreseal";
import { resolveRecipient } from "@qorechain/qoreseal/network";
import { encodeAbiParameters, hexToBytes, keccak256, toHex } from "viem";
// The split-bid format is one file, shared with the keeper and the other key holders that open what this seals.
import { HOLDERS, cut, deliveryAad, deliveryPurpose, isSplit, pack, pieceAad, piecePurpose, splitBidPurpose, unpack } from "../../../server/split.mjs";

export const CHAIN_ID = "qorechain-diana";
export const REST = () => `${location.origin}/rest`;

/** The QoreSeal purpose for every bid in one sale. The opener must use the identical string. */
export const bidPurpose = (saleContract, saleId) => `allot:bid:v1:${saleContract.toLowerCase()}:${saleId}`;

/** Same as SealedSale.fingerprintOf: keccak256(abi.encode(saleId, bidder, price, qty, salt)). */
export const fingerprintOf = (saleId, bidder, price, qty, salt) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }],
      [BigInt(saleId), bidder, BigInt(price), BigInt(qty), salt],
    ),
  );

// Every bid's plaintext is padded to this many bytes, so an envelope's size says nothing about its price or shares.
const PLAINTEXT_BYTES = 160;
const encode = (bid) => {
  const json = JSON.stringify(bid);
  return new TextEncoder().encode(JSON.stringify({ ...bid, pad: " ".repeat(Math.max(0, PLAINTEXT_BYTES - json.length - 10)) }));
};

// A split sale's three key holders, each checked against its keys on chain. They must be three different accounts
// with three different keys, the seller first, or one holder could be counted twice.
async function splitHolders({ rest, issuer, card }) {
  const members = card.members;
  if (!Array.isArray(members) || members.length !== HOLDERS || members[0]?.address !== issuer || new Set(members.map((m) => m?.address)).size !== HOLDERS) {
    throw new Error("This sale doesn't name three different key holders, so Allot won't seal a bid to it.");
  }
  const holders = await Promise.all(members.map((m) => resolveRecipient({ rest, chainId: CHAIN_ID, address: m.address, card: m })));
  if (new Set(holders.map((h) => toHex(h.mlkemPublicKey))).size !== HOLDERS) throw new Error("Two of this sale's key holders share a key, so Allot won't seal a bid to it.");
  return holders;
}

/**
 * Seals {price, qty, salt} in the browser. A fresh key that only the bidder's receipt holds can always open it, so
 * the bidder can later open their own bid from the chain in their browser. Who else can depends on the sale's card:
 * - one card: the bid is also sealed to the issuer, whose card is checked against its keys on chain first;
 * - three cards (a split sale): the fresh key's seed is cut in three pieces, each sealed to a different holder, so
 *   any two holders open the bid and no one of them can (see server/split.mjs).
 * `price` is in payment-token base units per whole unit, `qty` in whole units.
 * Returns the envelope for placeBid, the fingerprint, and the receipt the bidder keeps.
 */
export async function sealBid({ saleContract, saleId, bidder, price, qty, issuer, card, rest = REST() }) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const mine = generateSealKeys();
  const receipt = { saleContract, saleId: String(saleId), bidder, price: String(price), qty: String(qty), salt, key: toHex(mine.seed) };
  const fingerprint = fingerprintOf(saleId, bidder, price, qty, salt);
  const plaintext = encode({ price: receipt.price, qty: receipt.qty, salt });
  if (card.v === 2) {
    const holders = await splitHolders({ rest, issuer, card });
    const bid = seal({ chainId: CHAIN_ID, purpose: splitBidPurpose(saleContract, saleId), recipients: [recipientOf(mine)], plaintext });
    const pieces = cut(mine.seed).map((piece, i) =>
      seal({ chainId: CHAIN_ID, purpose: piecePurpose(saleContract, saleId), recipients: [holders[i]], plaintext: piece, aad: pieceAad(fingerprint, i) }));
    return { envelope: pack(bid, pieces), fingerprint, receipt };
  }
  const seller = await resolveRecipient({ rest, chainId: CHAIN_ID, address: issuer, card });
  const envelope = seal({ chainId: CHAIN_ID, purpose: bidPurpose(saleContract, saleId), recipients: [seller, recipientOf(mine)], plaintext });
  return { envelope, fingerprint, receipt };
}

/**
 * Opens a bid in the browser with the key from the bidder's receipt, and checks it against the fingerprint the
 * contract stored. Returns { price, qty, salt, matches }; throws if this key can't open the envelope.
 */
export function openOwnBid({ saleContract, saleId, bidder, envelope, fingerprint, key }) {
  const split = isSplit(envelope) && unpack(envelope);
  if (isSplit(envelope) && !split) throw new Error("This sealed bid is malformed.");
  const plaintext = open({
    chainId: CHAIN_ID, keys: sealKeysFromSeed(hexToBytes(key)),
    purpose: split ? splitBidPurpose(saleContract, saleId) : bidPurpose(saleContract, saleId), envelope: split ? split.bid : envelope,
  });
  const bid = JSON.parse(new TextDecoder().decode(plaintext));
  return { price: bid.price, qty: bid.qty, salt: bid.salt, matches: fingerprintOf(saleId, bidder, bid.price, bid.qty, bid.salt) === fingerprint };
}

/** The public half of a receipt's key. A winner sends it to ask for its copy of the lot's file. */
export const receiptPublicKey = (key) => toHex(sealKeysFromSeed(hexToBytes(key)).mlkemPublicKey);

/** Opens a winner's sealed copy of the lot's file with the key in the receipt. Throws if this receipt can't open it. */
export const openDelivery = ({ saleContract, saleId, fingerprint, key, sealed }) =>
  open({ chainId: CHAIN_ID, purpose: deliveryPurpose(saleContract, saleId), envelope: sealed, keys: sealKeysFromSeed(hexToBytes(key)), aad: deliveryAad(fingerprint) });
