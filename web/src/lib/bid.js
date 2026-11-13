import { generateSealKeys, open, recipientOf, seal, sealKeysFromSeed } from "@qorechain/qoreseal";
import { resolveRecipient } from "@qorechain/qoreseal/network";
import { encodeAbiParameters, hexToBytes, keccak256, toHex } from "viem";

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

/**
 * Seals {price, qty, salt} in the browser to two recipients: the issuer, whose card is checked against its keys on
 * chain first, and a fresh key that only the bidder's receipt holds, so the bidder can later open their own bid
 * from the chain in their browser. `price` is in payment-token base units per whole unit, `qty` in whole units.
 * Returns the envelope for placeBid, the fingerprint, and the receipt the bidder keeps.
 */
export async function sealBid({ saleContract, saleId, bidder, price, qty, issuer, card, rest = REST() }) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const mine = generateSealKeys();
  const receipt = { saleContract, saleId: String(saleId), bidder, price: String(price), qty: String(qty), salt, key: toHex(mine.seed) };
  const seller = await resolveRecipient({ rest, chainId: CHAIN_ID, address: issuer, card });
  const envelope = seal({
    chainId: CHAIN_ID,
    purpose: bidPurpose(saleContract, saleId),
    recipients: [seller, recipientOf(mine)],
    plaintext: encode({ price: receipt.price, qty: receipt.qty, salt }),
  });
  return { envelope, fingerprint: fingerprintOf(saleId, bidder, price, qty, salt), receipt };
}

/**
 * Opens a bid in the browser with the key from the bidder's receipt, and checks it against the fingerprint the
 * contract stored. Returns { price, qty, salt, matches }; throws if this key can't open the envelope.
 */
export function openOwnBid({ saleContract, saleId, bidder, envelope, fingerprint, key }) {
  const plaintext = open({ chainId: CHAIN_ID, purpose: bidPurpose(saleContract, saleId), envelope, keys: sealKeysFromSeed(hexToBytes(key)) });
  const bid = JSON.parse(new TextDecoder().decode(plaintext));
  return { price: bid.price, qty: bid.qty, salt: bid.salt, matches: fingerprintOf(saleId, bidder, bid.price, bid.qty, bid.salt) === fingerprint };
}
