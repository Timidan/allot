// A key holder of Allot's split bids, run apart from the guest server and from its own mnemonic. A split bid's key
// is cut in three pieces, each sealed to a different holder, and any two rebuild it (see split.mjs). This holder
// gives up its pieces of a sale's bids only once the chain says the sale has closed. It is told a sale id and
// which blocks to look in; the close time and the bids themselves it reads from the chain, so nothing it is sent
// can make it open a bid early, and a piece copied from another sale or bid won't open at all.
// Env: WITNESS_MNEMONIC_FILE, ISSUER (the 0x account whose sales it serves), PORT (8788), HOST (127.0.0.1).
// `node witness.mjs card` prints this holder's card (public) for the guest server's HOLDER_CARDS_FILE and exits.
import { readFileSync } from "node:fs";
import http from "node:http";
import { hexToBytes, toHex } from "viem";
import { ownPiece, setupIssuer } from "./consign.mjs";
import { makeKit, pub, sale } from "./kit.mjs";

const mnemonic = readFileSync(process.env.WITNESS_MNEMONIC_FILE, "utf8").trim();
const kit = await makeKit(mnemonic);
const { card, keys } = await setupIssuer(kit, await kit.account(0), mnemonic, (...x) => console.error("key holder:", ...x));
if (process.argv[2] === "card") {
  console.log(card);
  process.exit(0);
}
const ISSUER = process.env.ISSUER?.toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(ISSUER ?? "")) throw new Error("Set ISSUER to the account whose sales this key holder serves.");
const refuse = (status, message) => Object.assign(new Error(message), { status });

async function pieces(saleId, blocks) {
  const id = BigInt(saleId);
  const s = await pub.readContract({ ...sale, functionName: "getSale", args: [id] }).catch(() => {
    throw refuse(404, "No such sale.");
  });
  if (s.issuer.toLowerCase() !== ISSUER) throw refuse(403, "Not one of this key holder's sales.");
  if ((await pub.getBlock()).timestamp < s.closeAt) throw refuse(409, "This sale is still open.");
  const out = {};
  for (const block of blocks) {
    const placed = await pub.getContractEvents({ ...sale, eventName: "BidPlaced", args: { saleId: id }, fromBlock: BigInt(block), toBlock: BigInt(block) });
    for (const { args: e } of placed) {
      const mine = ownPiece(keys, id, e.fingerprint, hexToBytes(e.envelope));
      if (mine) out[e.bidIndex] = { holder: mine.holder, piece: toHex(mine.piece) };
    }
  }
  return out;
}

http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "POST" || req.url !== "/pieces") return reply(404, { error: "Not found." });
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) throw refuse(413, "Too large.");
    }
    const { saleId, blocks } = JSON.parse(body);
    if (!/^\d{1,6}$/.test(String(saleId)) || !Array.isArray(blocks) || blocks.length > 100 || !blocks.every((b) => Number.isSafeInteger(b) && b > 0)) {
      throw refuse(400, "Send a sale id and the blocks its bids are in.");
    }
    reply(200, { pieces: await pieces(saleId, [...new Set(blocks)]) });
  } catch (e) {
    if (!e.status && !(e instanceof SyntaxError)) console.error(new Date().toISOString(), "pieces:", e.shortMessage ?? e.message);
    reply(e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: e.status ? e.message : e instanceof SyntaxError ? "Send JSON." : "This key holder couldn't answer." });
  }
}).listen(Number(process.env.PORT ?? 8788), process.env.HOST ?? "127.0.0.1", () => console.error(`key holder for ${ISSUER} listening on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8788}`));
