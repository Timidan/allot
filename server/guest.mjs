// Guest bids. A visitor without a wallet gets one guest account's address, seals a bid for it in the browser,
// and this server places that sealed bid on chain from the guest. Guest keys never leave this process.
// Consignment: a visitor lists an image or a song, and the consign issuer (account CONSIGN of the same mnemonic)
// runs its sale; a keeper settles each one after its close. See consign.mjs.
// Env: GUESTS_MNEMONIC (or GUESTS_MNEMONIC_FILE), GUESTS (count, default 2), PORT (8787), DATA (./data),
// CONSIGN (account index, default 100), PUBLIC (the site's origin, for file links in token terms).
// Split bids: HOLDER_CARDS_FILE (the other two key holders' cards, a JSON array; with it, new listings take bids that
// no single key opens) and HOLDERS_AT (comma-separated addresses to ask those holders for their pieces after a close).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from "node:fs";
import http from "node:http";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { hexToBytes } from "viem";
import { OPEN_FOR, bidsOf, checkBid, checkSplit, createListing, finish, sealDelivery, setupIssuer } from "./consign.mjs";
import { guestBids, guestBidStatus, requestIdPattern } from "./guest-bids.mjs";
import { FUSD, REST, SALE, fusd as fusdContract, makeKit, pub, sale } from "./kit.mjs";
import { WINNERS_TYPES, winnersHash } from "./split.mjs";
const fusdAbi = fusdContract.abi;

const ISSUER = "0xCc7BfdE6Ed012e6E90B32D01979B87e34Ac00464"; // the treasury issuer of the sample sales
const MAX_ENVELOPE = 8192; // a split bid is the sealed bid and three sealed key pieces, about 7,250 bytes
const BACKUP_BUFFER = 3600n;
const pilot = process.env.BACKUP_LOTS?.trim();
if (pilot && !/^\d{1,6},\d{1,6}$/.test(pilot)) throw new Error("Set BACKUP_LOTS to two sale IDs separated by a comma.");
const [primaryId, backupId] = pilot ? pilot.split(",").map(Number) : [];
if (pilot && primaryId === backupId) throw new Error("The primary and backup need different sale IDs.");
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
// Sends token-form fUSD to QoreX bidders: the faucet pays fUSD as a bank coin, and QoreX won't sign the conversion.
const topper = await kit.account(Number(process.env.TOPUP ?? 50));
const LISTINGS = `${DATA}/listings.json`;
const FILES = `${DATA}/files`;
mkdirSync(FILES, { recursive: true });
// A lot's file for its winners is put in WINNERS by the operator, named by its SHA-256, and is never served as it
// is. Each winner's sealed copy is kept in SEALED; those open only with that winner's receipt.
const WINNERS = `${DATA}/winners`;
const SEALED = `${DATA}/deliveries`;
mkdirSync(WINNERS, { recursive: true });
mkdirSync(SEALED, { recursive: true });
const listings = existsSync(LISTINGS) ? JSON.parse(readFileSync(LISTINGS, "utf8")) : [];
const saveListings = () => writeFileSync(LISTINGS, JSON.stringify(listings, null, 2));
const ISSUERS = [ISSUER, consignor.evm].map((x) => x.toLowerCase()); // guests bid only into sales these created
const held = new Map(); // guest evm address -> { visitor, until }
const lastBid = new Map(); // visitor -> most recent guest order and its time
const queue = new Map(); // guest evm address -> promise; one transaction at a time per guest
const orders = guestBids({
  file: `${DATA}/guest-bids.json`, pub, sale, kit, guests, targets: [SALE, FUSD],
  checkBackup: async ({ guest, backup }) => {
    const state = await pub.readContract({ ...sale, functionName: "getSale", args: [BigInt(backup.saleId)] });
    if (state.issuer.toLowerCase() !== consignor.evm.toLowerCase() || state.deposit !== BigInt(backup.deposit)) return false;
    const bid = checkBid((await readyIssuer()).keys, backup.saleId, guest, backup.fingerprint, backup.envelope, state.deposit);
    return !bid.why && bid.price >= state.reserve && bid.qty <= state.supply;
  },
});

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

const handingOut = new Set(); // visitors with a hand-out in progress, so two at once can't hold two guests
async function handOut(saleId, visitor) {
  const now = Date.now();
  const recent = lastBid.get(visitor);
  if (recent && now - recent.at < PER_VISITOR && !orders.get(recent.id)?.primary.ended) {
    throw Object.assign(new Error("One guest bid per visitor a day."), { status: 429 });
  }
  const mine = guests.find((g) => held.get(g.evm)?.visitor === visitor && held.get(g.evm).until > now);
  if (mine) return mine;
  if (handingOut.has(visitor)) throw Object.assign(new Error("Already finding you a guest account. Try again in a moment."), { status: 409 });
  handingOut.add(visitor);
  try {
    return await pickGuest(saleId, visitor, now);
  } finally {
    handingOut.delete(visitor);
  }
}

async function pickGuest(saleId, visitor, now) {
  const s = await openSale(saleId);
  let busy = false;
  for (const g of guests) {
    if (orders.busy(g.evm)) { busy = true; continue; }
    if ((await kit.fusdOf(g.evm)) < s.deposit) continue;
    const h = held.get(g.evm);
    if (h && h.until > now) { busy = true; continue; }
    held.set(g.evm, { visitor, until: now + HOLD });
    return g;
  }
  throw Object.assign(new Error(busy ? "Every guest account is in use. Try again in a few minutes." : "No guest bids left in this sale. They free up when it settles."), { status: 409 });
}

function sealedLeg(value) {
  if (!/^\d{1,6}$/.test(String(value?.saleId)) ||
      !/^0x[0-9a-fA-F]{64}$/.test(value?.fingerprint ?? "") || typeof value?.fingerprint !== "string") {
    throw Object.assign(new Error("Invalid sale or bid fingerprint."), { status: 400 });
  }
  if (typeof value.envelope !== "string" || value.envelope.length > 2 + 2 * MAX_ENVELOPE || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value.envelope)) {
    throw Object.assign(new Error("Invalid bid envelope."), { status: 400 });
  }
  return { saleId: Number(value.saleId), fingerprint: value.fingerprint.toLowerCase(), envelope: value.envelope };
}

function listedBackup(saleId) {
  if (saleId !== primaryId) return;
  const primary = listings.find((l) => l.saleId === primaryId && !l.done && l.closeAt > Date.now());
  if (primary) return listings.find((l) => l.saleId === backupId && !l.done &&
    l.closeAt >= primary.closeAt + Number(OPEN_FOR + BACKUP_BUFFER) * 1000);
}

async function place(value, visitor) {
  const primary = sealedLeg(value);
  const { saleId, fingerprint, envelope } = primary;
  const { guest, backup, requestId = randomUUID() } = value;
  if (typeof requestId !== "string" || !requestIdPattern.test(requestId)) throw Object.assign(new Error("Invalid bid request."), { status: 400 });
  const id = requestId.toLowerCase();
  const second = backup === undefined ? null : sealedLeg(backup);
  const previous = () => {
    const existing = orders.get(id);
    if (!existing) return;
    if (existing.guest.toLowerCase() !== String(guest).toLowerCase() || existing.primary.saleId !== saleId ||
        existing.primary.fingerprint !== fingerprint || existing.backup?.saleId !== second?.saleId ||
        existing.backup?.fingerprint !== second?.fingerprint) {
      throw Object.assign(new Error("This receipt is already tied to another bid."), { status: 409 });
    }
    return guestBidStatus(existing);
  };
  const retry = previous();
  if (retry) return retry;
  const g = guests.find((x) => x.evm.toLowerCase() === String(guest).toLowerCase());
  const h = g && held.get(g.evm);
  const notYours = () => Object.assign(new Error("That guest isn't yours. Start the bid again."), { status: 409 });
  if (!h || h.visitor !== visitor || h.until < Date.now()) throw notYours();
  const s = await openSale(saleId);
  let candidate;
  if (second) {
    if (listedBackup(saleId)?.saleId !== second.saleId) throw Object.assign(new Error("This backup lot is unavailable."), { status: 409 });
    candidate = await openSale(second.saleId);
    const { timestamp } = await pub.getBlock();
    const issuer = consignor.evm.toLowerCase();
    if (s.issuer.toLowerCase() !== issuer || candidate.issuer.toLowerCase() !== issuer || timestamp >= s.closeAt ||
        candidate.deposit !== s.deposit || candidate.closeAt < s.openBy + BACKUP_BUFFER) {
      throw Object.assign(new Error("These lots cannot share a backup bid."), { status: 409 });
    }
  }
  // In a sale Allot runs, the server holds the opening key: refuse a bid that could never be opened, so it can't
  // hold up the sale's settlement until the opening deadline.
  // In a split sale the server holds one key of three and can't read the bid: it checks what one holder can.
  if (s.issuer.toLowerCase() === consignor.evm.toLowerCase()) {
    const { keys } = await readyIssuer();
    const holders = (id) => listings.find((l) => l.saleId === id)?.holders;
    if (second && (holders(saleId) || holders(second.saleId))) throw Object.assign(new Error("A backup bid isn't offered in this sale."), { status: 409 });
    const bid = holders(saleId)
      ? checkSplit(keys, await holderKeys(holders(saleId)), saleId, fingerprint, envelope)
      : checkBid(keys, saleId, g.evm, fingerprint, envelope, s.deposit);
    if (bid.why) throw Object.assign(new Error(`This bid can't be placed: ${bid.why}.`), { status: 400 });
  }
  return serial(g.evm, async () => {
    const retry = previous();
    if (retry) return retry;
    const now = held.get(g.evm);
    if (!now || now.visitor !== visitor || now.until < Date.now()) throw notYours();
    if (process.env.DRY) {
      await pub.simulateContract({ ...sale, functionName: "placeBid", args: [BigInt(saleId), fingerprint, envelope], account: g.evm });
      return { simulated: true, guest: g.evm };
    }
    const leg = (sealed, state) => ({ ...sealed, closeAt: String(state.closeAt), deposit: String(state.deposit) });
    const order = orders.save({
      id, guest: g.evm, primary: leg(primary, s),
      ...(second && { backup: leg(second, candidate) }),
    });
    held.delete(g.evm);
    lastBid.set(visitor, { id, at: Date.now() });
    try {
      return guestBidStatus(await orders.advance(id));
    } catch (e) {
      console.error("Guest placement will be checked by the keeper:", e.name);
      return guestBidStatus(orders.get(id) ?? order);
    }
  });
}

// A QoreX bidder short of token-form fUSD gets exactly enough for one sale's deposit: once per address and per
// visitor a day, at most TOPUPS_PER_DAY in all. ponytail: in memory, like the other limits.
const TOPUPS_PER_DAY = 10;
const lastTopup = new Map(); // visitor or address -> time
const topups = [];
async function topUp({ saleId, address }, visitor) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw Object.assign(new Error("That isn't an EVM address."), { status: 400 });
  const to = address.toLowerCase();
  const s = await openSale(saleId);
  const have = await kit.fusdOf(to);
  if (have >= s.deposit) return { amount: "0", have: have.toString() };
  if (!(await pub.readContract({ ...sale, functionName: "isHybridHolder", args: [to] }))) throw Object.assign(new Error("This account can't bid yet: register its post-quantum key first."), { status: 400 });
  const now = Date.now();
  for (const k of [visitor, to]) if (now - (lastTopup.get(k) ?? 0) < PER_VISITOR) throw Object.assign(new Error("Allot sends fUSD once a day per account. Try again tomorrow, or bid as a guest."), { status: 429 });
  while (topups.length && now - topups[0] > PER_VISITOR) topups.shift();
  if (topups.length >= TOPUPS_PER_DAY) throw Object.assign(new Error("Allot has sent today's fUSD. Bid as a guest, or try again tomorrow."), { status: 429 });
  [visitor, to].forEach((k) => lastTopup.set(k, now));
  topups.push(now);
  const amount = s.deposit - have;
  try {
    const tx = await serial(topper.evm, async () => {
      await kit.ensureWindow(topper, [FUSD]);
      const rc = await kit.evm(topper, { address: FUSD, abi: fusdAbi, functionName: "transfer", args: [to, amount] });
      if (rc.status !== "success") throw new Error("transfer failed");
      return rc.transactionHash;
    });
    return { amount: amount.toString(), tx };
  } catch (e) {
    [visitor, to].forEach((k) => lastTopup.delete(k));
    topups.pop();
    throw e;
  }
}

// ---------------------------------------------------------------- consignment

const MAX_FILE = 8 * 1024 * 1024;
const DEPOSIT = 10_000_000n; // 10 fUSD: small, so the two guests' float covers many bids
const LENGTHS = [600, 3600, 86400, 259200]; // 10 minutes, 1 hour, 1 day, 3 days
const PER_DAY = 20; // listings a day in all
const lastListing = new Map(); // visitor -> time of their last listing (memory only, like guest bids)
// The other two holders of a split bid's key. Their cards are public; their keys never come near this server.
const otherCards = process.env.HOLDER_CARDS_FILE ? JSON.parse(readFileSync(process.env.HOLDER_CARDS_FILE, "utf8")) : null;
if (otherCards && (!Array.isArray(otherCards) || otherCards.length !== 2)) throw new Error("HOLDER_CARDS_FILE holds the other two key holders' cards.");
const holdersAt = (process.env.HOLDERS_AT ?? "").split(",").map((u) => u.trim()).filter(Boolean);
const kemKeys = new Map(); // holder address -> its registered ML-KEM-1024 key
const holderKeys = (addresses) => Promise.all(addresses.map(async (address) => {
  if (!kemKeys.has(address)) kemKeys.set(address, (await fetchKemKey({ rest: REST, address })).publicKey);
  return kemKeys.get(address);
}));
// After a close, the other holders' pieces of a sale's split bids. Throws when none of them answers.
async function askHolders(saleId, blocks) {
  const out = {};
  let answered = 0;
  for (const at of holdersAt) {
    try {
      const r = await fetch(`${at}/pieces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ saleId: Number(saleId), blocks }), signal: AbortSignal.timeout(60_000) });
      if (!r.ok) continue;
      answered++;
      for (const [index, p] of Object.entries((await r.json()).pieces)) out[index] ??= { holder: p.holder, piece: hexToBytes(p.piece) };
    } catch {
      // unreachable: try the next holder
    }
  }
  if (!answered) throw new Error(holdersAt.length ? "none could be reached" : "HOLDERS_AT is not set");
  return out;
}
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
  const winners = q.get("winners") ?? undefined; // the SHA-256 of a file for the winners; the file itself is not uploaded here
  if (winners !== undefined && !/^[0-9a-f]{64}$/.test(winners)) throw bad("Name the winners' file by its SHA-256: 64 lowercase hex characters.");
  // Only a file the operator has already put in WINNERS can be promised, and only in a split sale (see sealDelivery).
  if (winners && !existsSync(`${WINNERS}/${winners}`)) throw bad("Allot holds no file with that SHA-256. Its operator adds winners' files before a lot is listed.");
  if (winners && !otherCards) throw bad("A winners' file needs a sale whose bids are split between key holders.");
  // The description goes into the same token text as the promise, so it may not carry a promise of its own.
  if (winnersHash(about)) throw bad("The description can't promise a winners' file. Allot's operator attaches one.");
  const winnersType = winners && WINNERS_TYPES.includes(q.get("winnersType")) ? q.get("winnersType") : undefined;
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
  // With the other holders' cards on file the sale publishes all three, the issuer's first, and bidders split each bid's key.
  const holders = otherCards && [JSON.parse(card), ...otherCards];
  const made = await serial(consignor.evm, () =>
    createListing(kit, consignor, holders ? JSON.stringify({ v: 2, members: holders }) : card, { title, about, fileUrl: `${process.env.PUBLIC ?? "https://allot.timidan.xyz"}/api/files/${name}`, sha256, supply: shares, reserve: reserve * 1_000_000, deposit: DEPOSIT, seconds, winners }),
  );
  const listing = { saleId: made.saleId, title, by, about, kind: k.kind, peaks: k.kind === "audio" ? peaks : "", file: `/api/files/${name}`, sha256, token: made.token, createBlock: made.createBlock, closeAt: made.closeAt, createdAt: now, txs: made.txs, bidBlocks: [], scanned: made.createBlock, done: false, ...(holders && { holders: holders.map((h) => h.address) }), ...(winners && { winners, winnersType }) };
  listings.push(listing);
  saveListings();
  return { saleId: made.saleId };
}

// A winner asks for its copy of the lot's file, with the public half of the key in its receipt. The sale, the bid
// and the sealed bid are read from the chain; nothing the caller says is trusted except that key, and it must be
// the one the bid was sealed to. Sealed copies are kept and can be handed to anyone: only the receipt opens them.
async function delivery({ saleId, bidIndex, key } = {}) {
  const refuse = (status, m) => Object.assign(new Error(m), { status });
  if (!Number.isInteger(saleId) || !Number.isInteger(bidIndex) || saleId < 0 || bidIndex < 0 || typeof key !== "string" || !/^0x[0-9a-fA-F]{3136}$/.test(key)) {
    throw refuse(400, "Send the sale, the bid's number and the receipt's public ML-KEM-1024 key.");
  }
  const l = listings.find((x) => x.saleId === saleId);
  const path = l?.winners && `${WINNERS}/${l.winners}`;
  if (!path || !existsSync(path)) throw refuse(404, "This lot has no file for its winners.");
  const kept = `${SEALED}/${saleId}-${bidIndex}.bin`;
  if (existsSync(kept)) return readFileSync(kept);
  const s = await pub.readContract({ ...sale, functionName: "getSale", args: [BigInt(saleId)] });
  if (!s.settled) throw refuse(409, "This sale isn't settled yet.");
  const bid = await pub.readContract({ ...sale, functionName: "bids", args: [BigInt(saleId), BigInt(bidIndex)] }).catch(() => null);
  if (!bid || bid[4] === 0n) throw refuse(403, "This bid won no shares.");
  const placed = (await Promise.all([...new Set(l.bidBlocks)].map((block) =>
    pub.getContractEvents({ ...sale, eventName: "BidPlaced", args: { saleId: BigInt(saleId), bidIndex: BigInt(bidIndex) }, fromBlock: BigInt(block), toBlock: BigInt(block) })))).flat()[0];
  if (!placed) throw refuse(404, "That bid isn't in this sale.");
  const file = readFileSync(path);
  if (createHash("sha256").update(file).digest("hex") !== l.winners) throw new Error(`the winners' file of sale ${saleId} doesn't match its SHA-256`);
  const made = sealDelivery(file, saleId, placed.args.fingerprint, placed.args.envelope, key);
  if (made.why) throw refuse(403, `No copy for this request: ${made.why}.`);
  writeFileSync(kept, made.sealed);
  return Buffer.from(made.sealed);
}

// Every minute: note each consigned sale's new bids (so the page finds QoreX bids too), and finish closed ones.
async function keepListings() {
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
        l.done = await serial(consignor.evm, () => finish(kit, consignor, keys, l, (...x) => console.log(new Date().toISOString(), ...x), askHolders));
        l.bidBlocks = [...new Set([...blocks, ...l.bidBlocks])];
      }
      saveListings();
    } catch (e) {
      console.error(new Date().toISOString(), `keeper, sale ${l.saleId}:`, e.shortMessage ?? e.message);
    }
  }
}

let keeping = false;
async function keep() {
  if (keeping) return;
  keeping = true;
  try {
    await keepListings();
    if (process.env.DRY) return;
    for (const order of orders.pending()) {
      try {
        await serial(order.guest, () => orders.advance(order.id));
      } catch (e) {
        console.error("Guest bid keeper will check again:", e.name);
      }
    }
  } finally {
    keeping = false;
  }
}
setInterval(keep, 60_000);

const body = (req, limit = 16_384) =>
  new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > limit) {
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
    let url;
    try { url = new URL(req.url, "http://x"); } catch { return reply(res, 400, { error: "Bad request." }); }
    const visitor = visitorOf(req);
    try {
      if (req.method === "GET" && url.pathname === "/api/guest") {
        const g = await handOut(url.searchParams.get("sale"), visitor);
        return reply(res, 200, { guest: g.evm });
      }
      if (req.method === "POST" && url.pathname === "/api/bid") {
        return reply(res, 200, await place(await body(req, 18 * 1024), visitor));
      }
      if (req.method === "POST" && url.pathname === "/api/bid-status") {
        const { requestId } = await body(req) ?? {};
        const order = typeof requestId === "string" && requestIdPattern.test(requestId) && orders.get(requestId.toLowerCase());
        return order ? reply(res, 200, guestBidStatus(order)) : reply(res, 404, { error: "No submitted bid for this receipt yet." });
      }
      if (req.method === "GET" && url.pathname === "/api/bids") {
        const id = Number(url.searchParams.get("sale"));
        const kept = listings.find((l) => l.saleId === id)?.bidBlocks ?? [];
        const bids = [...placed.filter((b) => b.saleId === id), ...orders.placements(id)];
        return reply(res, 200, [...bids.map(({ tx, block, bidIndex }) => ({ tx, block, bidIndex })), ...kept.map((block) => ({ block }))]);
      }
      if (req.method === "POST" && url.pathname === "/api/fusd") {
        return reply(res, 200, await topUp(await body(req), visitor));
      }
      if (req.method === "POST" && url.pathname === "/api/delivery") {
        const sealed = await delivery(await body(req, 8 * 1024));
        res.writeHead(200, { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-store" });
        return res.end(sealed);
      }
      if (req.method === "POST" && url.pathname === "/api/consign") {
        return reply(res, 200, await consign(req, url.searchParams, visitor));
      }
      if (req.method === "GET" && url.pathname === "/api/listings") {
        return reply(res, 200, listings.map(({ saleId, title, by, about, kind, peaks, file, sha256, token, createBlock, closeAt, done, winners, winnersType }) =>
          ({ saleId, title, by, about, kind, peaks, file, sha256, token, createBlock, closeAt, done, winners, winnersType, backupSaleId: listedBackup(saleId)?.saleId, split: Boolean(listings.find((l) => l.saleId === saleId)?.holders) })));
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
      reply(res, status, { error: status === 500 ? (url.pathname === "/api/fusd" ? "Allot couldn't send the fUSD just now. Try again in a minute, or bid as a guest." : `The ${url.pathname === "/api/consign" ? "listing" : "bid"} didn't go through. Try again in a minute.`) : e.message });
    }
  })
  .listen(Number(process.env.PORT ?? 8787), () => console.log(`guest server on ${process.env.PORT ?? 8787}, ${guests.length} guests:`, guests.map((g) => g.evm).join(" ")));
