import { Fragment, useEffect, useState } from "react";
import { toHex } from "viem";
import AnimatedStepper from "@/components/smoothui/animated-stepper";
import DigitRoll from "@/components/smoothui/digit-roll";
import Countdown from "./Countdown.jsx";
import { Mark } from "./Landing.jsx";
import { sealBid } from "./lib/bid.js";
import { rangesOf, readBook, readCard, readSale } from "./lib/chain.js";
import { placeOwn, readiness } from "./lib/qorex.js";
import { downloadReceipt, parseReceipt, saveReceipt } from "./lib/receipt.js";
import { SALES, SALE_CONTRACT, money, readListings, short } from "./sale.js";
import { STEP, needs, openSetup } from "./SetupGuide.jsx";
import TestnetHelp from "./TestnetHelp.jsx";
import { ThemeSwitch } from "./theme.jsx";
import { WalletButton, connectWallet, findWallet } from "./Wallet.jsx";

const DOLLAR = 1_000_000n; // fUSD base units in one fUSD
const tap = "pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"; // a 44px target for fingers

function useSales() {
  const [extra, setExtra] = useState(null);
  useEffect(() => {
    readListings().then(setExtra);
  }, []);
  return { sales: [...SALES, ...(extra ?? [])].sort((a, b) => b.saleId - a.saleId), ready: extra !== null };
}
// Who can read a sealed bid before the close: the seller, or Allot when it runs the sale for an owner.
// Who can read a sealed bid before the close. In a split sale no single key can: it takes two of the sale's three.
const reader = (lot) => (lot.split ? "two of this sale's three key holders together" : lot.consigned ? "Allot, which runs this sale," : "the seller");

// The guest server: hands out a guest account, then places the bid sealed for it. Errors come back as plain words.
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error ?? "The bid didn't go through. Try again in a minute."), { status: r.status });
  return json;
};
// Old bid links can still prefill the form. New lot links carry just the sale ID.
function startingBid(sale) {
  const q = new URLSearchParams(location.search);
  const price = Math.max(sale.reserve, Math.min(sale.deposit, Math.round(Number(q.get("price")) || sale.reserve)));
  const shares = Math.max(1, Math.min(Math.round(Number(q.get("shares")) || 3), sale.supply, Math.floor(sale.deposit / price)));
  return { price, shares };
}

function BidBox({ sale, entry, backupEntry, onPlaced }) {
  const saleId = entry.saleId;
  const [price, setPrice] = useState(() => startingBid(sale).price);
  const [shares, setShares] = useState(() => startingBid(sale).shares);
  const [step, setStep] = useState(-1); // -1 choosing, 0 sealing, 1 placing, 2 placed
  const [bytes, setBytes] = useState(0);
  const [guest, setGuest] = useState(""); // the account the bid is sealed for: a guest, or the visitor's QoreX account
  const [own, setOwn] = useState(false); // bidding from QoreX rather than as a guest
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [help, setHelp] = useState(null); // the setup step that fixes the error, if one does
  const [topup, setTopup] = useState(null); // fUSD Allot can send this account for the deposit, or null
  const [sent, setSent] = useState(""); // what Allot just sent, said plainly
  const [backupSale, setBackupSale] = useState(null);
  const [backupLimit, setBackupLimit] = useState(null);
  useEffect(() => {
    if (!backupEntry) return;
    let current = true;
    readSale(SALE_CONTRACT, backupEntry.saleId).then((state) => { if (current) setBackupSale(state); }, () => {});
    return () => { current = false; };
  }, [backupEntry]);
  const backupOpen = backupEntry && backupSale && !backupSale.settled && backupSale.closeAt > Date.now();
  const backupPrice = Number(backupLimit);
  const backupMax = backupSale && Math.floor(backupSale.deposit / shares);
  const validBackup = backupLimit === null || (backupOpen && shares <= backupSale.supply &&
    Number.isSafeInteger(backupPrice) && backupPrice >= backupSale.reserve && backupPrice <= backupMax);

  // The contract can't see inside a sealed bid, so this box is the only place its size is checked:
  // price × shares may not exceed the deposit, or the bid can never be opened.
  const onPrice = (v) => {
    const p = Math.max(sale.reserve, Math.min(sale.deposit, Math.round(v)));
    setPrice(p);
    setShares((n) => Math.max(1, Math.min(n, Math.floor(sale.deposit / p))));
  };
  const onShares = (v) => setShares(Math.max(1, Math.min(Math.round(v), sale.supply, Math.floor(sale.deposit / price))));

  // The order matters: the fingerprint names the bidder, so the guest comes first, then the seal, then the placing.
  const place = async () => {
    setError("");
    setHelp(null);
    setNote("Sealing your bid…");
    setStep(0);
    let draft;
    let sentToServer = false;
    try {
      if (!validBackup) throw new Error("Set a valid maximum for the backup lot or uncheck it.");
      const { guest: bidder } = await api(`/api/guest?sale=${saleId}`);
      setGuest(bidder);
      const sealLot = async (lot, limit) => {
        const card = await readCard(SALE_CONTRACT, lot);
        return sealBid({ saleContract: SALE_CONTRACT, saleId: lot.saleId, bidder, price: BigInt(limit) * DOLLAR, qty: shares, issuer: card.address, card });
      };
      const [sealed, backup] = await Promise.all([sealLot(entry, price), backupLimit === null ? null : sealLot(backupEntry, backupPrice)]);
      setBytes(sealed.envelope.length);
      const leg = (bid) => ({ saleId: bid.receipt.saleId, fingerprint: bid.fingerprint, envelope: toHex(bid.envelope) });
      const requestId = crypto.randomUUID();
      draft = parseReceipt({
        ...sealed.receipt, requestId, fingerprint: sealed.fingerprint,
        ...(backup && { backup: { ...backup.receipt, fingerprint: backup.fingerprint } }),
      });
      if (!saveReceipt(draft)) throw new Error("Allow this site to save your private receipt, then try again.");
      setStep(1);
      sentToServer = true;
      const placed = await api("/api/bid", { ...leg(sealed), guest: bidder, requestId, ...(backup && { backup: leg(backup) }) });
      if (placed.simulated) {
        setError("The bid was simulated. No testnet bid was placed.");
        setStep(-1);
        return;
      }
      const r = placed.tx ? parseReceipt({ ...draft, tx: placed.tx }) : draft;
      saveReceipt(r);
      setReceipt(r);
      setStep(2);
      if (r.tx) onPlaced?.();
    } catch (e) {
      if (sentToServer && (!e.status || e.status >= 500)) {
        setReceipt(draft);
        setStep(2);
        return;
      }
      setError(e.message);
      setStep(-1);
    }
  };

  // From the visitor's own QoreX wallet: connect, make sure the account can bid, seal for it, then QoreX signs.
  const placeWithQorex = async () => {
    setError("");
    setSent("");
    setHelp(null);
    setOwn(true);
    setNote("Connecting to QoreX…");
    setStep(0);
    try {
      if (!(await findWallet())) throw needs("QoreX isn't installed.", STEP.install);
      const { provider, address } = await connectWallet(); // the header's connection: no prompt if already connected
      setGuest(address);
      const deposit = BigInt(sale.deposit) * DOLLAR;
      const ready = await readiness(address, deposit);
      // Each check says the one thing to do in QoreX, in the order the guide walks through them.
      const tap = "In QoreX, tap \u201cMetaMask on QoreChain\u201d and open a window";
      if (!ready.holder) throw needs(`This account has no post-quantum key on QoreChain yet. ${tap}: QoreX registers the key as it opens it. Then bid again.`, STEP.pass);
      if (!ready.passOk) throw needs(`${ready.live ? "Your EVM access window is nearly used up" : "Your EVM access window is closed"}. ${tap}, then bid again.`, STEP.pass);
      if (ready.uqor < 300_000n) throw needs("This account has no QOR for network fees. Get test QOR from QoreChain's faucet (once a day), then bid again.", STEP.funds);
      if (ready.short) {
        const have = (Number(ready.token) / 1e6).toFixed(2);
        throw Object.assign(new Error(`This sale locks a ${sale.deposit} fUSD deposit, and this account has ${have} fUSD it can bid with.${ready.bank ? " Its faucet fUSD is a bank coin QoreX can't convert yet." : ""} Allot can send you the ${(Number(ready.short) / 1e6).toFixed(2)} fUSD you're short.`), { topup: ready.short });
      }
      setNote("Sealing…");
      const card = await readCard(SALE_CONTRACT, entry);
      const sealed = await sealBid({ saleContract: SALE_CONTRACT, saleId, bidder: address, price: BigInt(price) * DOLLAR, qty: shares, issuer: card.address, card });
      setBytes(sealed.envelope.length);
      setStep(1);
      const tx = await placeOwn(provider, address, saleId, deposit, sealed.fingerprint, toHex(sealed.envelope));
      const r = parseReceipt({ ...sealed.receipt, fingerprint: sealed.fingerprint, tx });
      saveReceipt(r);
      setReceipt(r);
      setStep(2);
      onPlaced?.();
    } catch (e) {
      setError(walletError(e));
      setHelp(e.help ?? (/Ethereum account/.test(walletError(e)) ? STEP.account : null));
      setTopup(e.topup ?? null);
      setStep(-1);
    }
  };

  // Allot sends the token-form fUSD this account is short of, then the visitor bids again.
  const sendFusd = async () => {
    setError("");
    setTopup(null);
    setNote("Allot is sending you fUSD for the deposit…");
    setStep(0);
    try {
      const { address } = await connectWallet();
      const r = await api("/api/fusd", { saleId, address });
      setStep(-1);
      setSent(Number(r.amount) ? `Sent ${(Number(r.amount) / 1e6).toFixed(2)} fUSD to your account. Now bid from your QoreX wallet again.` : "Your account already has enough fUSD. Bid from your QoreX wallet again.");
    } catch (e) {
      setStep(-1);
      setError(e.message);
    }
  };

  if (step >= 0) {
    const steps = [
      { label: "Seal", content: <p className="text-[16px] text-muted-foreground">{note}</p> },
      {
        label: "Place",
        content: (
          <p className="text-[16px] text-muted-foreground">
            Sealed: {bytes.toLocaleString()} bytes. {own ? "In QoreX, approve the deposit (first time only), then the bid." : "Placing it on QoreChain from a guest account. Up to a minute."}
          </p>
        ),
      },
      {
        label: receipt?.tx ? "Done" : "Check",
        content: receipt ? (
          <div className="space-y-3 text-[16px]">
            <p className="font-semibold">{receipt.tx ? "Bid confirmed" : "Check your bid status"}</p>
            <p className="text-muted-foreground">Up to {shares} shares at {price} fUSD each from {own ? "your QoreX account" : "Allot's guest account"} {short(guest)}.</p>
            {receipt.backup && receipt.tx ? <p className="text-muted-foreground">Backup queued for {backupEntry.lot.title}.</p> : null}
            <p className="flex flex-wrap gap-x-5 gap-y-2">
              <a className="text-accent underline underline-offset-4" href={`/my-bid?bid=${receipt.fingerprint}`}>My bid</a>
              <button className="underline underline-offset-4" onClick={() => downloadReceipt(receipt)} type="button">Download private receipt</button>
            </p>
            <p className="text-[14px] text-muted-foreground">Keep the file private. It opens your bid and lets you check the result on another device.</p>
          </div>
        ) : null,
      },
    ];
    return (
      <div className="rounded-md border border-border bg-muted p-5">
        <AnimatedStepper currentStep={step} steps={steps} />
      </div>
    );
  }

  return (
    <div className="@container rounded-md border border-border bg-muted p-4 sm:p-5">
      {/* side by side only when each field has room for "100" and both buttons */}
      <div className="grid gap-3 @min-[18rem]:grid-cols-2">
        {/* scrub off: a sideways drag on a phone would change the bid by accident */}
        <DigitRoll className="w-full" label="Shares" max={Math.min(sale.supply, Math.floor(sale.deposit / price))} min={1} onValueChange={onShares} scrub={false} stepper value={shares} />
        <DigitRoll className="w-full" label="Most you'll pay a share, fUSD" max={sale.deposit} min={sale.reserve} onValueChange={onPrice} scrub={false} stepper value={price} />
      </div>
      <div className="my-4 flex justify-between text-[15px] text-muted-foreground">
        <span>Maximum total</span>
        <b className="font-semibold text-foreground">{money(price * shares)}</b>
      </div>
      {backupOpen || backupLimit !== null ? (
        <div className="mb-4 border-y border-border py-3">
          <label className="flex items-start gap-3 text-[15px]">
            <input checked={backupLimit !== null} className="mt-1 size-4 shrink-0 accent-foreground" onChange={(e) => setBackupLimit(e.target.checked ? "" : null)} type="checkbox" />
            Try {backupEntry?.lot.title ?? "the backup lot"} if I win no shares and the full deposit comes back
          </label>
          {backupLimit !== null ? (
            <label className="mt-3 grid gap-1 pl-7 text-[15px]">
              Most you'll pay a share in the backup, fUSD
              <input className="min-h-11 w-full border border-border bg-background px-3 focus-visible:outline-2 focus-visible:outline-ring"
                min={backupSale?.reserve} max={backupMax ?? undefined} onChange={(e) => setBackupLimit(e.target.value)} step={1} type="number" value={backupLimit} />
              {backupOpen && shares <= backupSale.supply && backupMax >= backupSale.reserve
                ? <span className="text-muted-foreground">{validBackup ? `Maximum total ${money(backupPrice * shares)}` : `Enter ${backupSale.reserve} to ${backupMax} fUSD a share.`}</span>
                : <span className="text-muted-foreground">Choose fewer shares or remove the backup.</span>}
            </label>
          ) : null}
        </div>
      ) : null}
      <button className="h-13 w-full rounded bg-primary font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-accent active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60" disabled={!validBackup} onClick={() => { setOwn(false); place(); }} type="button">
        Leave a sealed bid
      </button>
      {backupLimit === null ? (
        <button className="mt-3 h-12 w-full rounded border border-foreground/40 text-[16px] transition-colors duration-150 hover:bg-foreground hover:text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={placeWithQorex} type="button">
          Use my wallet
        </button>
      ) : null}
      {sent ? <p className="mt-3 text-[15px] text-accent" role="status">{sent}</p> : null}
      {error ? (
        <p className="mt-3 text-[15px] text-destructive" role="alert">
          {error}{help !== null ? <> <button className="min-h-11 text-accent underline underline-offset-4 hover:decoration-2" onClick={() => openSetup(help)} type="button">Show me how</button></> : null}
          {topup ? <> <button className="min-h-11 font-semibold text-accent underline underline-offset-4 hover:decoration-2" onClick={sendFusd} type="button">Send me {(Number(topup) / 1e6).toFixed(2)} fUSD</button></> : null}
        </p>
      ) : null}
      <p className="mt-3 text-[15px] text-muted-foreground">
        You may win fewer shares, and every winner pays the clearing price. As a guest, Allot supplies the {sale.deposit} fUSD deposit, and the shares and refund go to its guest account.
      </p>
      <p className="mt-2 text-[15px] text-muted-foreground">
        {entry.lot.split
          ? <>Sealed in your browser with ML-KEM-1024 to a key in your receipt. That key is cut in three pieces, each sealed to a different registered key holder: any two can open your bid, no one of them alone. Other bidders can't read it.{entry.lot.winners ? <> Every winner also gets a file, sealed to the same key; its SHA-256 is in the lot's token: <span className="font-mono text-[14px]" title={entry.lot.winners}>{short(entry.lot.winners)}</span>.</> : null}</>
          : <>Sealed in your browser with ML-KEM-1024 to {entry.lot.consigned ? "Allot's" : "the seller's"} registered key, <span className="font-mono text-[14px]" title={sale.issuer}>{short(sale.issuer)}</span>, and to a key in your receipt. Other bidders can't read it; {reader(entry.lot)} can.</>}
      </p>
      <TestnetHelp />
    </div>
  );
}

// What QoreX or the chain said, as the one thing to do next.
function walletError(e) {
  const m = (e.shortMessage ?? e.message ?? "").replace(/^QoreX: /, "");
  if (e.help !== undefined || e.topup) return m;
  if (e.code === 4001 || /reject|denied|declined|cancel/i.test(m)) return "You declined in QoreX, so nothing was sent. Bid again when you're ready.";
  if (/coin ?118|ethereum account|evm (send|transaction)s? .*not|not an? (evm|ethereum)/i.test(m)) return "QoreX sends bids only from an Ethereum account. In QoreX, choose the account marked \u201cEthereum \u00b7 coin 60\u201d, then bid again.";
  if (/window/i.test(m)) return "QoreChain wants an open EVM access window. In QoreX, tap \u201cMetaMask on QoreChain\u201d and open a window, then bid again.";
  if (/failed on chain/i.test(m)) return "QoreChain refused the bid. The sale may have just ended, or your window may have run out: open a new window in QoreX and bid again.";
  return m ? `QoreX didn't send the bid (${m}). Nothing was charged; try again.` : "QoreX didn't send the bid. Nothing was charged; try again.";
}

const Tx = ({ hash, label }) =>
  hash ? (
    <a className={`text-accent underline-offset-4 hover:underline ${tap}`} href={`/tx/${hash}`}>
      {label} {short(hash)} →
    </a>
  ) : null;

// The open sale's bids as they sit on chain: who placed one and how big the sealed envelope is, nothing more.
function SealedBids({ book, lot }) {
  return (
    <section>
      <p className="text-[16px] text-muted-foreground">Sealed with ML-KEM-1024. Until they're opened on chain after the sale ends, only {reader(lot)} and each bid's own bidder can read them.</p>
      <ul className="mt-4 border-t border-border font-mono text-[14px]">
        {book.map((b) => (
          <li className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 border-b border-border py-2.5 sm:grid-cols-[8rem_1fr_auto]" key={b.tx}>
            <span>{short(b.bidder)}</span>
            <span aria-label={`Sealed, ${b.bytes.toLocaleString()} bytes`} className="hidden items-center gap-1 text-muted-foreground sm:flex" role="img">
              {Array.from({ length: 10 }, (_, i) => <i className="size-2 bg-accent/35" key={i} />)}
              <span className="ml-2 whitespace-nowrap">{b.bytes.toLocaleString()} bytes</span>
            </span>
            <Tx hash={b.tx} label="Placed" />
          </li>
        ))}
      </ul>
    </section>
  );
}

// A settled sale, opened: every bid with what it won and what came back, and the three transactions behind it.
function AllBids({ sale, book }) {
  return (
    <section>
      <p className="text-[16px] text-muted-foreground">
        {book.filter((b) => b.price != null).length} of {book.length} {book.length === 1 ? "bid" : "bids"} opened and checked against their fingerprints. {sale.sold} of {sale.supply} shares sold at <b className="font-semibold text-foreground">{money(sale.clearing)}</b>.
      </p>
      <table className="mt-4 w-full border-collapse text-[15px] tabular-nums">
        <thead>
          <tr className="text-left text-[14px] text-muted-foreground">
            <th className="border-b border-border py-2 font-normal">Bidder</th>
            <th className="border-b border-border py-2 text-right font-normal">Bid</th>
            <th className="border-b border-border py-2 text-right font-normal">Won</th>
            <th className="border-b border-border py-2 text-right font-normal">Back</th>
          </tr>
        </thead>
        <tbody>
          {book.map((b) => (
            <Fragment key={b.tx}>
              <tr>
                <td className="pt-3 font-mono text-[14px]">{short(b.bidder)}</td>
                <td className="pt-3 text-right">{b.shares} at {b.price} fUSD</td>
                <td className={`pt-3 text-right ${b.won ? "font-semibold" : "text-muted-foreground"}`}>{b.won || "None"}</td>
                <td className="pt-3 text-right">{b.refund == null ? "Not yet" : money(b.refund)}</td>
              </tr>
              <tr>
                <td className="border-b border-border pb-3 pt-1 font-mono text-[13px]" colSpan={4}>
                  <span className="flex flex-wrap gap-x-5 gap-y-1">
                    <Tx hash={b.tx} label="Placed" />
                    <Tx hash={b.openTx} label="Opened" />
                    <Tx hash={b.claimTx} label="Claimed" />
                  </span>
                </td>
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const Title = ({ lot, size = "text-[40px] md:text-[54px]" }) => (
  <div>
    <div className="text-base font-semibold">{lot.artist}</div>
    <h1 className={`my-0.5 text-balance font-serif italic leading-[1.05] ${size}`}>{lot.title}</h1>
    {lot.details ? <div className="text-pretty text-muted-foreground">{lot.details}</div> : null}
  </div>
);
// A song's picture is its waveform (64 heights the page measured when it was listed); the player sits under it.
const Picture = ({ lot, className }) =>
  lot.image ? (
    <img alt={lot.alt} className={`object-cover ${className}`} src={lot.image} />
  ) : (
    <div aria-hidden="true" className={`flex items-center gap-[2px] bg-muted px-4 ${className}`}>
      {lot.peaks
        ? [...lot.peaks].map((p, i) => <i className="flex-1 bg-foreground/70" key={i} style={{ height: `${4 + (parseInt(p, 36) / 35) * 76}%` }} />)
        : <span className="self-end pb-4 text-[15px] text-muted-foreground">Song</span>}
    </div>
  );

const Intro = () => (
  <p className="text-[18px] leading-snug">Bid once, in private. Best bids win. Every winner pays the same price.</p>
);

const Fact = ({ label, children, right }) => (
  <div className={right ? "text-right" : ""}><dt className="text-[14px] text-muted-foreground">{label}</dt><dd className="m-0 text-lg font-semibold">{children}</dd></div>
);
const Facts = ({ sale, ended }) => (
  <dl className="grid grid-cols-3 border-y border-border py-3.5 tabular-nums">
    <Fact label={ended ? "Shares sold" : "Shares on sale"}>{sale ? (ended ? `${sale.sold} of ${sale.supply}` : sale.supply) : "–"}</Fact>
    <Fact label={ended ? "Bids" : "Sealed bids"}>{sale?.bids ?? "–"}</Fact>
    <Fact label={ended ? "Price" : "Ends in"} right>{!sale ? "–" : ended ? (sale.settled && sale.sold ? money(sale.clearing) : "–") : <Countdown to={sale.closeAt} />}</Fact>
  </dl>
);

const Credit = ({ lot }) => <p className="text-[13px] leading-relaxed text-muted-foreground">{lot.note}{lot.credit ? ` ${lot.credit}.` : ""}</p>;

// A section that stays folded until the visitor opens it. Native <details>, so it works without script and by keyboard.
const Fold = ({ title, children }) => (
  <details className="group border-b border-border">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[18px] [&::-webkit-details-marker]:hidden">
      <span>{title}</span>
      <span aria-hidden="true" className="text-[22px] text-muted-foreground transition-transform duration-200 group-open:rotate-45">+</span>
    </summary>
    <div className="pb-8">{children}</div>
  </details>
);

// One sale: the lot and the bid (or the result) at the top, both short; the long lists folded below, full width.
function SalePage({ entry, sale, book, backupEntry, onPlaced }) {
  const ended = sale && (sale.settled || Date.now() >= sale.closeAt);
  const earlier = SALES.filter((e) => e.saleId !== entry.saleId && e.lot === entry.lot);
  const { lot } = entry;
  return (
    <main className="mx-auto max-w-[1200px] px-5 pb-20 md:px-12">
      <a className="inline-flex min-h-11 items-center text-[15px] text-muted-foreground hover:text-foreground" href="/sales">← All sales</a>
      <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(340px,440px)] md:items-start md:gap-12">
        <figure className="m-0">
          <Picture className={`block w-full ${lot.image ? "max-h-[78vh]" : "aspect-[4/3]"}`} lot={lot} />
          {lot.audio ? <audio className="mt-3 w-full" controls preload="metadata" src={lot.audio}>{lot.title}</audio> : null}
          <figcaption className="mt-3 max-w-[60ch]"><Credit lot={lot} /></figcaption>
        </figure>
        <section className="space-y-5">
          <Title lot={lot} />
          {ended ? (
            <p className="text-[18px] leading-snug">
              {!sale.settled ? "Ended. The bids are being opened." : sale.sold ? `Ended. ${sale.sold} of ${sale.supply} shares sold at ${money(sale.clearing)}, the price every winner paid.` : "Ended with no winning bids. Nothing was sold."}
            </p>
          ) : (
            <Intro />
          )}
          <Facts ended={ended} sale={sale} />
          {ended ? (
            sale.settled && sale.sold ? <a className="inline-flex min-h-11 items-center text-[16px] text-accent underline-offset-4 hover:underline" href={`/sales/${entry.saleId}?view=result`}>What a winner saw after the sale →</a> : null
          ) : sale ? (
            <BidBox backupEntry={backupEntry} entry={entry} onPlaced={onPlaced} sale={sale} />
          ) : (
            <div className="h-[230px] rounded-md border border-border bg-muted" />
          )}
        </section>
      </div>

      <div className="mt-16 border-t border-border">
        {book && !ended ? (
          <Fold title={`Sealed bids in this sale (${book.length})`}>
            <SealedBids book={book} lot={lot} />
          </Fold>
        ) : null}
        {book && ended && sale.settled ? (
          <Fold title={`Every bid, opened (${book.length})`}>
            <AllBids book={book} sale={sale} />
          </Fold>
        ) : null}
        {earlier.length ? (
          <Fold title="Other sales of these shares">
            <ul className="space-y-2 text-[17px]">
              {earlier.map((e) => (
                <li key={e.saleId}><a className={`text-accent underline-offset-4 hover:underline ${tap}`} href={`/sales/${e.saleId}`}>Sale {e.saleId} →</a></li>
              ))}
            </ul>
          </Fold>
        ) : null}
      </div>
    </main>
  );
}

// One real bidder's result from the last sale, shown as the screen a winner sees after the close.
function ResultPage({ last, book, lot }) {
  const b = book.find((x) => x.won && x.won === x.shares && x.refund > 0) ?? book[0];
  return (
    <main className="mx-auto max-w-[560px] px-5 pb-14 pt-4">
      <div className="mb-7 flex items-center gap-4">
        {lot.image ? <img alt="" className="h-14 w-16 object-cover" src={lot.image} /> : null}
        <div className="text-[15px] text-muted-foreground"><i className="font-serif text-[18px] text-foreground">{lot.title}</i><br />Bidder {short(b.bidder)}, after the sale</div>
      </div>
      <h1 className="text-[44px] font-semibold leading-none tracking-tight">You won {b.won} shares</h1>
      <p className="mb-6 mt-3 text-[17px] text-muted-foreground">
        Every winner paid <b className="font-semibold text-foreground">{money(last.clearing)}</b> a share.
      </p>
      <dl className="mb-6 border-t border-border tabular-nums">
        {[["You bid", `${b.shares} at ${money(b.price)}`], ["You paid", money(last.clearing * b.won)], ["Back to you", b.refund == null ? "Not yet" : money(b.refund)]].map(([k, v]) => (
          <div className="flex justify-between border-b border-border py-3.5 text-base" key={k}><dt className="text-muted-foreground">{k}</dt><dd className="m-0 font-semibold">{v}</dd></div>
        ))}
      </dl>
      <div aria-label={`${b.won} of ${last.supply} shares`} className="mb-2 grid grid-cols-10 gap-1" role="img">
        {Array.from({ length: last.supply }, (_, i) => <i className={`aspect-square ${i < b.won ? "bg-accent" : "bg-border"}`} key={i} />)}
      </div>
      <p className="text-[15px] text-muted-foreground">{b.won} of {last.supply} shares.</p>
      <p className="mt-6 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[14px]">
        <Tx hash={b.tx} label="Placed" />
        <Tx hash={b.openTx} label="Opened" />
        <Tx hash={b.claimTx} label="Claimed" />
      </p>
    </main>
  );
}

export const SiteHeader = () => (
  // On a phone the links take a second row, so every page stays one tap away.
  <header className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-4 px-5 pt-4 pb-2 md:flex-nowrap md:gap-x-10 md:py-6 md:px-12">
    <a className="flex min-h-11 items-center gap-2 text-lg font-semibold" href="/"><Mark />Allot</a>
    <nav className="order-last flex w-full flex-wrap gap-x-5 font-mono text-[14px] text-muted-foreground md:order-none md:w-auto md:gap-x-7">
      {[["/sales", "Sales"], ["/sell", "Sell"], ["/my-bid", "My bid"], ["/#how", "How it works"]].map(([href, text]) => (
        <a className={`inline-flex min-h-11 items-center ${location.pathname === href ? "text-foreground" : "hover:text-foreground"}`} href={href} key={href}>{text}</a>
      ))}
    </nav>
    <div className="ml-auto flex items-center gap-3 whitespace-nowrap font-mono text-[14px] text-muted-foreground sm:gap-5">
      <span className="hidden sm:inline">Testnet</span>
      <ThemeSwitch className="min-h-11 px-1 py-2 hover:text-foreground" />
      <WalletButton />
    </div>
  </header>
);
const readError = (e) => `Couldn't read the sale from QoreChain testnet: ${e.shortMessage ?? e.message}`;
const isOver = (s) => s.settled || Date.now() >= s.closeAt;

// /sales: everything listed, open sales first, each a link to its own page.
export function Gallery() {
  const { sales } = useSales();
  const [found, setFound] = useState({});
  const [error, setError] = useState("");
  useEffect(() => {
    for (const e of sales) if (!(e.saleId in found)) readSale(SALE_CONTRACT, e.saleId).then((s) => setFound((f) => ({ ...f, [e.saleId]: s })), (x) => setError(readError(x)));
  }, [sales.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const listed = sales.map((e) => ({ ...e, sale: found[e.saleId] }));
  // A sale shows once it has been read, so an ended one never flashes up under "Open for bids".
  const live = listed.filter((e) => e.sale && !isOver(e.sale));
  const ended = listed.filter((e) => e.sale && isOver(e.sale));
  const reading = !error && listed.some((e) => !e.sale);
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[1360px] px-5 pb-20 md:px-12">
        <h1 className="text-[40px] font-semibold leading-tight tracking-tight md:text-[56px]">Sales</h1>
        <p className="mt-2 text-[18px] text-muted-foreground">Shares in real things, sold by sealed bid. Testnet samples. <a className="text-accent underline underline-offset-4 hover:decoration-2" href="/sell">Sell your own →</a></p>
        <TestnetHelp className="mt-3 max-w-[70ch]" />
        {error ? <p className="mt-4 text-[15px] text-destructive" role="alert">{error}</p> : null}
        {reading && !live.length ? <p className="mt-14 text-[17px] text-muted-foreground">Reading the sales from QoreChain testnet…</p> : null}
        {live.length ? (
          <section className="mt-14">
            <h2 className="border-b border-border pb-3 text-[20px] font-semibold">Open for bids</h2>
            <Lots items={live} />
          </section>
        ) : null}
        {/* Ended sales stay folded until asked for. */}
        {ended.length ? (
          <div className="mt-14 border-t border-border">
            <Fold title={`Ended (${ended.length})`}>
              <Lots items={ended} />
            </Fold>
          </div>
        ) : null}
      </main>
    </>
  );
}

function Lots({ items }) {
  return (
              <ul className="mt-8 grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((e) => (
                  <li key={e.saleId}>
                    <a className="group block" href={`/sales/${e.saleId}`}>
                      <Picture className="block aspect-[4/3] w-full transition-[filter] duration-200 group-hover:brightness-95" lot={e.lot} />
                      <div className="mt-4 text-[15px] font-semibold">{e.lot.artist}</div>
                      <div className="font-serif text-[26px] italic leading-tight group-hover:underline group-hover:underline-offset-4">{e.lot.title}</div>
                      <div className="mt-2 text-[16px] text-muted-foreground">
                        {!e.sale ? "–" : isOver(e.sale)
                          ? !e.sale.settled ? "Ended, opening bids" : e.sale.sold ? `Sold ${e.sale.sold} of ${e.sale.supply} shares at ${money(e.sale.clearing)}` : "Ended with no winning bids"
                          : <>{e.sale.supply} shares · {e.sale.bids} sealed bids · ends in <Countdown to={e.sale.closeAt} /></>}
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
  );
}

// /sales/<id>: one sale. ?view=result on a settled sale shows what one real winner saw.
export default function App({ saleId }) {
  const { sales, ready } = useSales();
  const entry = sales.find((e) => e.saleId === saleId);
  const [sale, setSale] = useState(null);
  const [book, setBook] = useState(null);
  const [error, setError] = useState("");
  // Testnet reads take 1.5 to 7 seconds, so each part shows as soon as its own read lands.
  const fail = (e) => setError(readError(e));
  const load = () => {
    if (!entry) return;
    readSale(SALE_CONTRACT, entry.saleId).then(setSale, fail);
    rangesOf(entry).then((r) => readBook(SALE_CONTRACT, entry.saleId, r)).then(setBook, fail);
  };
  useEffect(load, [entry?.saleId]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = new URLSearchParams(location.search).get("view") === "result";
  return (
    <>
      <SiteHeader />
      {error ? <p className="mx-auto max-w-[1360px] px-5 pb-4 text-sm text-destructive md:px-12" role="alert">{error}</p> : null}
      {!entry ? (
        <main className="mx-auto max-w-[1200px] px-5 pb-20 md:px-12">
          <p className="text-[18px] text-muted-foreground">{ready ? <>There's no sale {saleId}. <a className="text-accent underline underline-offset-4" href="/sales">See every sale →</a></> : "Reading the sale…"}</p>
        </main>
      ) : result && sale?.settled && book ? (
        <ResultPage book={book} last={sale} lot={entry.lot} />
      ) : (
        <SalePage backupEntry={sales.find((s) => s.saleId === entry.backupSaleId)} book={book} entry={entry} onPlaced={load} sale={sale} />
      )}
    </>
  );
}
