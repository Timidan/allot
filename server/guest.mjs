// Guest bids. A visitor without a wallet gets one guest account's address, seals a bid for it in the browser,
// and this server places that sealed bid on chain from the guest. Guest keys never leave this process.
// Consignment: a visitor lists an image or a song, and the consign issuer (account CONSIGN of the same mnemonic)
// runs its sale; a keeper settles each one after its close. See consign.mjs.
// Env: GUESTS_MNEMONIC (or GUESTS_MNEMONIC_FILE), GUESTS (count, default 2), PORT (8787), DATA (./data),
// CONSIGN (account index, default 100), PUBLIC (the site's origin, for file links in token terms).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import http from "node:http";
import { decodeEventLog } from "viem";
import { bidsOf, checkBid, createListing, finish, setupIssuer } from "./consign.mjs";
import { FUSD, SALE, makeKit, pub, sale } from "./kit.mjs";

const ISSUER = "0xCc7BfdE6Ed012e6E90B32D01979B87e34Ac00464"; // the treasury issuer of the sample sales
const MAX_ENVELOPE = 4096; // bytes; one sealed bid is about 1.8 KB
const HOLD = 10 * 60_000; // a guest handed to a visitor is kept for them this long
const PER_VISITOR = 24 * 3600_000; // one guest bid per visitor in this time
const mnemonic = (process.env.GUESTS_MNEMONIC || readFileSync(process.env.GUESTS_MNEMONIC_FILE, "utf8")).trim();
const DATA = process.env.DATA ?? "./data";
mkdirSync(DATA, { recursive: true });
const BIDS = `${DATA}/bids.json`;
const placed = existsSync(BIDS) ? JSON.parse(readFileSync(BIDS, "utf8")) : [];

const kit = await makeKit(mnemonic);
const guests = await Promise.all(Array.from({ length: Number(process.env.GUESTS ?? 2) }, (_, i) => kit.account(i)));
const consignor = await kit.account(Number(process.env.CONSIGN ?? 100));
const LISTINGS = `${DATA}/listings.json`;
const FILES = `${DATA}/files`;
mkdirSync(FILES, { recursive: true });
const listings = existsSync(LISTINGS) ? JSON.parse(readFileSync(LISTINGS, "utf8")) : [];
const saveListings = () => writeFileSync(LISTINGS, JSON.stringify(listings, null, 2));
const ISSUERS = [ISSUER, consignor.evm].map((x) => x.toLowerCase()); // guests bid only into sales these created
const held = new Map(); // guest evm address -> { visitor, until }
const lastBid = new Map(); // visitor -> time of their last guest bid
const queue = new Map(); // guest evm address -> promise; one transaction at a time per guest

const serial = (addr, job) => {
  const next = (queue.get(addr) ?? Promise.resolve()).then(job, job);
  queue.set(addr, next.catch(() => {}));
  return next;
};
// ponytail: in-memory holds and visitor limits reset on restart; move to the data file if restarts get frequent.
const reply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const visitorOf = (req) => (req.headers["x-client-ip"] ?? req.socket.remoteAddress ?? "").toString().split(",")[0].trim();

// A sale a guest may bid into: created by our issuer and still taking bids.
async function openSale(saleId) {
  if (!/^\d{1,6}$/.test(String(saleId))) throw Object.assign(new Error("No such sale."), { status: 404 });
  const s = await pub.readContract({ ...sale, functionName: "getSale", args: [BigInt(saleId)] }).catch(() => {
    throw Object.assign(new Error("No such sale."), { status: 404 });
  });
  if (!ISSUERS.includes(s.issuer.toLowerCase())) throw Object.assign(new Error("Guests bid only in Allot's own sales."), { status: 403 });
  if (Date.now() / 1000 >= Number(s.closeAt)) throw Object.assign(new Error("This sale has ended."), { status: 409 });
  return s;
}

async function handOut(saleId, visitor) {
  const s = await openSale(saleId);
  const now = Date.now();
  if (now - (lastBid.get(visitor) ?? 0) < PER_VISITOR) throw Object.assign(new Error("One guest bid per visitor a day."), { status: 429 });
  const mine = guests.find((g) => held.get(g.evm)?.visitor === visitor && held.get(g.evm).until > now);
  if (mine) return mine;
  let busy = false;
  for (const g of guests) {
    if ((await kit.fusdOf(g.evm)) < s.deposit) continue;
    const h = held.get(g.evm);
    if (h && h.until > now) { busy = true; continue; }
    held.set(g.evm, { visitor, until: now + HOLD });
    return g;
  }
  throw Object.assign(new Error(busy ? "Every guest account is in use. Try again in a few minutes." : "No guest bids left in this sale. They free up when it settles."), { status: 409 });
}

async function place({ saleId, guest, fingerprint, envelope }, visitor) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(fingerprint ?? "")) throw Object.assign(new Error("Bad fingerprint."), { status: 400 });
  if (!/^0x[0-9a-fA-F]+$/.test(envelope ?? "") || (envelope.length - 2) / 2 > MAX_ENVELOPE) throw Object.assign(new Error("Bad envelope."), { status: 400 });
  const g = guests.find((x) => x.evm.toLowerCase() === String(guest).toLowerCase());
  const h = g && held.get(g.evm);
  const notYours = () => Object.assign(new Error("That guest isn't yours. Start the bid again."), { status: 409 });
  if (!h || h.visitor !== visitor || h.until < Date.now()) throw notYours();
  const s = await openSale(saleId);
  // In a sale Allot runs, the server holds the opening key: refuse a bid that could never be opened, so it can't
  // hold up the sale's settlement until the opening deadline.
  if (s.issuer.toLowerCase() === consignor.evm.toLowerCase()) {
    const bid = checkBid((await readyIssuer()).keys, saleId, g.evm, fingerprint, envelope, s.deposit);
    if (bid.why) throw Object.assign(new Error(`This bid can't be placed: ${bid.why}.`), { status: 400 });
  }
  return serial(g.evm, async () => {
    // Checked again in the queue: two requests racing on one hold must not both place a bid.
    const now = held.get(g.evm);
    if (!now || now.visitor !== visitor) throw notYours();
    const windowTx = await kit.ensureWindow(g, [SALE, FUSD]);
    const args = [BigInt(saleId), fingerprint, envelope];
    await pub.simulateContract({ ...sale, functionName: "placeBid", args, account: g.evm });
    if (process.env.DRY) return { simulated: true, guest: g.evm }; // local checks: everything but the send
    const rc = await kit.evm(g, { ...sale, functionName: "placeBid", args });
    const ev = rc.logs.filter((l) => l.address.toLowerCase() === SALE.toLowerCase()).map((l) => decodeEventLog({ abi: sale.abi, data: l.data, topics: l.topics })).find((e) => e.eventName === "BidPlaced");
    const bid = { saleId: Number(saleId), bidIndex: Number(ev.args.bidIndex), guest: g.evm, tx: rc.transactionHash, block: Number(rc.blockNumber), windowTx };
    placed.push(bid);
    writeFileSync(BIDS, JSON.stringify(placed, null, 2));
    held.delete(g.evm);
    lastBid.set(visitor, Date.now());
    return bid;
  });
}

// ---------------------------------------------------------------- consignment

const MAX_FILE = 8 * 1024 * 1024;
const DEPOSIT = 10_000_000n; // 10 fUSD: small, so the two guests' float covers many bids
const LENGTHS = [600, 3600, 86400, 259200]; // 10 minutes, 1 hour, 1 day, 3 days
const PER_DAY = 20; // listings a day in all
const lastListing = new Map(); // visitor -> time of their last listing (memory only, like guest bids)
let issuerKeys = null; // { card, keys }, readied on first use
const readyIssuer = async () => (issuerKeys ??= await setupIssuer(kit, consignor, mnemonic, (...x) => console.log("consign issuer:", ...x)).catch((e) => {
  issuerKeys = null;
  throw e;
}));

// The file's type, from its first bytes only (never its name or the browser's claim).
function kindOf(b) {
  const at = (i, s) => b.subarray(i, i + s.length).toString("latin1") === s;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", type: "image/jpeg", ext: "jpg" };
  if (at(0, "\x89PNG\r\n\x1a\n")) return { kind: "image", type: "image/png", ext: "png" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", type: "image/webp", ext: "webp" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "audio", type: "audio/wav", ext: "wav" };
  if (at(0, "OggS")) return { kind: "audio", type: "audio/ogg", ext: "ogg" };
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { kind: "audio", type: "audio/mpeg", ext: "mp3" };
  if (at(4, "ftypM4A")) return { kind: "audio", type: "audio/mp4", ext: "m4a" };
  return null;
}
const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", wav: "audio/wav", ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4" };

const raw = (req) =>
  new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_FILE) {
        reject(Object.assign(new Error("Files can be up to 8 MB."), { status: 413 }));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

async function consign(req, q, visitor) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const title = (q.get("title") ?? "").trim(), by = (q.get("by") ?? "").trim(), about = (q.get("about") ?? "").trim();
  const shares = Number(q.get("shares")), reserve = Number(q.get("reserve")), seconds = Number(q.get("length"));
  if (!title || title.length > 80) throw bad("Give it a title of up to 80 characters.");
  if (!by || by.length > 60) throw bad("Say who made it, in up to 60 characters.");
  if (about.length > 280) throw bad("Keep the description to 280 characters.");
  if (!Number.isInteger(shares) || shares < 1 || shares > 100) throw bad("Shares must be a whole number from 1 to 100.");
  if (!Number.isInteger(reserve) || reserve < 1 || reserve > 10) throw bad("The lowest price must be a whole number of fUSD from 1 to 10."); // bids are whole fUSD
  if (!LENGTHS.includes(seconds)) throw bad("Pick one of the sale lengths.");
  if (q.get("rights") !== "1") throw bad("Confirm you may sell shares in it.");
  const peaks = /^[0-9a-z]{64}$/.test(q.get("peaks") ?? "") ? q.get("peaks") : ""; // a song's waveform, drawn by the page
  const now = Date.now();
  if (now - (lastListing.get(visitor) ?? 0) < PER_VISITOR) throw Object.assign(new Error("One listing per visitor a day."), { status: 429 });
  if (listings.filter((l) => now - l.createdAt < PER_VISITOR).length >= PER_DAY) throw Object.assign(new Error("Allot has taken today's 20 listings. Try again tomorrow."), { status: 429 });
  // The day's listing is reserved before the upload is read, so two uploads racing can't both pass the limit.
  // A file that isn't an image or a song gives it back; a failed chain step still uses it.
  lastListing.set(visitor, now);
  let file, k;
  try {
    file = await raw(req);
    k = kindOf(file);
  } catch (e) {
    lastListing.delete(visitor);
    throw e;
  }
  if (!k) {
    lastListing.delete(visitor);
    throw Object.assign(new Error("Upload a JPEG, PNG or WebP image, or an MP3, OGG, WAV or M4A song."), { status: 415 });
  }
  const sha256 = createHash("sha256").update(file).digest("hex");
  const name = `${sha256}.${k.ext}`;
  if (!existsSync(`${FILES}/${name}`)) writeFileSync(`${FILES}/${name}`, file);
  const { card } = await readyIssuer();
  const made = await serial(consignor.evm, () =>
    createListing(kit, consignor, card, { title, about, fileUrl: `${process.env.PUBLIC ?? "https://allot.timidan.xyz"}/api/files/${name}`, sha256, supply: shares, reserve: reserve * 1_000_000, deposit: DEPOSIT, seconds }),
  );
  const listing = { saleId: made.saleId, title, by, about, kind: k.kind, peaks: k.kind === "audio" ? peaks : "", file: `/api/files/${name}`, sha256, token: made.token, createBlock: made.createBlock, closeAt: made.closeAt, createdAt: now, txs: made.txs, bidBlocks: [], scanned: made.createBlock, done: false };
  listings.push(listing);
  saveListings();
  return { saleId: made.saleId };
}

// Every minute: note each consigned sale's new bids (so the page finds QoreX bids too), and finish closed ones.
async function keep() {
  for (const l of listings.filter((x) => !x.done)) {
    try {
      const latest = Number(await pub.getBlockNumber());
      if (latest > l.scanned) {
        const found = await bidsOf(l.saleId, l.scanned + 1, latest);
        l.bidBlocks = [...new Set([...l.bidBlocks, ...found.map((e) => Number(e.blockNumber))])];
        l.scanned = latest;
      }
      if (Date.now() >= l.closeAt) {
        const { keys } = await readyIssuer();
        const blocks = l.bidBlocks;
        l.done = await serial(consignor.evm, () => finish(kit, consignor, keys, l, (...x) => console.log(new Date().toISOString(), ...x)));
        l.bidBlocks = [...new Set([...blocks, ...l.bidBlocks])];
      }
      saveListings();
    } catch (e) {
      console.error(new Date().toISOString(), `keeper, sale ${l.saleId}:`, e.shortMessage ?? e.message);
    }
  }
}
setInterval(keep, 60_000);

const body = (req) =>
  new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 16_384) {
        reject(Object.assign(new Error("Too large."), { status: 413 }));
        req.destroy(); // stop reading: an oversized body is not buffered further
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(s || "{}")); } catch { reject(Object.assign(new Error("Bad JSON."), { status: 400 })); }
    });
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const visitor = visitorOf(req);
    try {
      if (req.method === "GET" && url.pathname === "/api/guest") {
        const g = await handOut(url.searchParams.get("sale"), visitor);
        return reply(res, 200, { guest: g.evm });
      }
      if (req.method === "POST" && url.pathname === "/api/bid") {
        return reply(res, 200, await place(await body(req), visitor));
      }
      if (req.method === "GET" && url.pathname === "/api/bids") {
        const id = Number(url.searchParams.get("sale"));
        const kept = listings.find((l) => l.saleId === id)?.bidBlocks ?? [];
        return reply(res, 200, [...placed.filter((b) => b.saleId === id).map(({ tx, block, bidIndex }) => ({ tx, block, bidIndex })), ...kept.map((block) => ({ block }))]);
      }
      if (req.method === "POST" && url.pathname === "/api/consign") {
        return reply(res, 200, await consign(req, url.searchParams, visitor));
      }
      if (req.method === "GET" && url.pathname === "/api/listings") {
        return reply(res, 200, listings.map(({ saleId, title, by, about, kind, peaks, file, sha256, token, createBlock, closeAt, done }) => ({ saleId, title, by, about, kind, peaks, file, sha256, token, createBlock, closeAt, done })));
      }
      const f = req.method === "GET" && url.pathname.match(/^\/api\/files\/([0-9a-f]{64})\.(jpg|png|webp|wav|ogg|mp3|m4a)$/);
      if (f && existsSync(`${FILES}/${f[1]}.${f[2]}`)) {
        // Served as what its bytes said it was, and never as a page: no sniffing, no scripts, no frames.
        res.writeHead(200, { "content-type": TYPES[f[2]], "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "public, max-age=31536000, immutable" });
        return createReadStream(`${FILES}/${f[1]}.${f[2]}`).pipe(res);
      }
      reply(res, 404, { error: "Not found." });
    } catch (e) {
      const status = e.status ?? 500;
      if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, e.shortMessage ?? e.message);
      reply(res, status, { error: status === 500 ? `The ${url.pathname === "/api/consign" ? "listing" : "bid"} didn't go through. Try again in a minute.` : e.message });
    }
  })
  .listen(Number(process.env.PORT ?? 8787), () => console.log(`guest server on ${process.env.PORT ?? 8787}, ${guests.length} guests:`, guests.map((g) => g.evm).join(" ")));
