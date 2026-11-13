import { motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { generateSealKeys, open, recipientOf, seal as sealTo } from "@qorechain/qoreseal";
import DigitRoll from "@/components/smoothui/digit-roll";
import ByteTiles from "./ByteTiles.jsx";
import { CHAIN_ID } from "./lib/bid.js";
import { money, openSale } from "./sale.js";

// A practice auction: the last sale's four real bids plus the visitor's. On "Seal it" this browser makes an
// ML-KEM-1024 key and seals all five bids to it; on "End the sale" it opens every envelope with that key and
// settles from what it opened, the way the contract does: best price first, earlier bid first at equal prices,
// until the shares run out. Nothing is sent.
const PURPOSE = "allot:practice:v1";
const sealPractice = (keys, bid) => sealTo({ chainId: CHAIN_ID, purpose: PURPOSE, recipients: [recipientOf(keys)], plaintext: new TextEncoder().encode(JSON.stringify(bid)) });
const openPractice = (keys, envelope) => JSON.parse(new TextDecoder().decode(open({ chainId: CHAIN_ID, purpose: PURPOSE, envelope, keys })));
function settle(bids, supply, reserve) {
  const order = [...bids].sort((a, b) => b.price - a.price); // stable, so ties keep bid order
  const filled = new Map();
  let left = supply;
  let clearing = null;
  for (const b of order) {
    if (left <= 0 || b.price < reserve) break;
    const f = Math.min(b.qty, left);
    filled.set(b.key, f);
    left -= f;
    clearing = b.price;
  }
  return { order, filled, clearing };
}

export const NAMES = ["Ana", "Ben", "Chi", "Dee"]; // the last sale's four bidders, in bid order
const Button = ({ children, quiet, ...p }) => (
  <button
    className={`h-12 px-5 text-[16px] transition-[background-color,color,scale] duration-150 motion-safe:active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${quiet ? "border border-foreground/40 hover:bg-foreground hover:text-background" : "bg-foreground text-background hover:bg-accent"}`}
    type="button"
    {...p}
  >
    {children}
  </button>
);

export default function TryAuction({ last, book }) {
  const [price, setPrice] = useState(26);
  const [shares, setShares] = useState(3);
  const [mine, setMine] = useState(null); // once sealed: { keys, envelopes: { [bid key]: envelope } }
  const [opened, setOpened] = useState(null); // after the end: { [bid key]: { price, qty } }, decrypted in this browser
  const [phase, setPhase] = useState("pick"); // pick, sealing, sealed, opening, ended
  const [looking, setLooking] = useState(null); // the bid under the pointer or last tapped
  const [error, setError] = useState("");
  const still = useReducedMotion();
  const again = useRef(false); // after "Try again" or "Change my bid", focus returns to "Seal it"
  const { supply, reserve, deposit } = last;

  // Same limits as the real bid box: price × shares stays within the deposit.
  const onPrice = (v) => {
    const p = Math.max(reserve, Math.min(deposit, Math.round(v)));
    setPrice(p);
    setShares((n) => Math.max(1, Math.min(n, Math.floor(deposit / p))));
  };
  const onShares = (v) => setShares(Math.max(1, Math.min(Math.round(v), supply, Math.floor(deposit / price))));

  const seal = () => {
    setError("");
    setPhase("sealing");
    try {
      const keys = generateSealKeys();
      const envelopes = Object.fromEntries([...book.map((b) => [b.tx, sealPractice(keys, { price: b.price, qty: b.shares })]), ["you", sealPractice(keys, { price, qty: shares })]]);
      setMine({ keys, envelopes });
      setPhase("sealed");
    } catch (e) {
      setError(`Sealing failed: ${e.message}`);
      setPhase("pick");
    }
  };
  const endSale = () => {
    setLooking(null);
    try {
      setOpened(Object.fromEntries(Object.entries(mine.envelopes).map(([k, envelope]) => [k, openPractice(mine.keys, envelope)])));
    } catch (e) {
      setError(`Opening failed: ${e.message}`);
      return;
    }
    setPhase("opening");
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => setPhase("ended"), still ? 0 : 900);
  };
  const replay = () => {
    again.current = true;
    setMine(null);
    setOpened(null);
    setLooking(null);
    setPhase("pick");
  };

  // Before the end the page knows each bid only by what was typed or published; after it, by what this browser opened.
  const valueOf = (key, price, qty) => (opened?.[key] ? { price: opened[key].price, qty: opened[key].qty } : { price, qty });
  const bids = [
    ...book.map((b, i) => ({ key: b.tx, who: NAMES[i] ?? `Bidder ${i + 1}`, ...valueOf(b.tx, b.price, b.shares), envelope: mine?.envelopes[b.tx] ?? b.envelope })),
    ...(mine ? [{ key: "you", who: "You", ...valueOf("you", price, shares), envelope: mine.envelopes.you, mine: true }] : []),
  ];
  const result = settle(bids, supply, reserve);
  const rows = phase === "ended" ? result.order : bids;
  const lastWinner = [...result.filled.keys()].at(-1);
  const you = result.filled.get("you") ?? 0;

  return (
    <div>
      <p aria-live="polite" className="sr-only">
        {phase === "sealed" ? "Your bid is sealed." : phase === "ended" ? `Time's up. Everyone pays ${money(result.clearing)}. You won ${you}.` : ""}
      </p>
      {phase === "pick" || phase === "sealing" ? (
        <div className="@container max-w-[560px]">
          <div className="grid gap-3 @min-[18rem]:grid-cols-2">
            <DigitRoll className="w-full" label="Price a share in fUSD" max={deposit} min={reserve} onValueChange={onPrice} scrub={false} stepper value={price} />
            <DigitRoll className="w-full" label="Shares" max={Math.min(supply, Math.floor(deposit / price))} min={1} onValueChange={onShares} scrub={false} stepper value={shares} />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Button autoFocus={again.current} disabled={phase === "sealing"} onClick={seal}>{phase === "sealing" ? "Sealing…" : "Seal it"}</Button>
            <span className="text-[15px] text-muted-foreground">Practice: nothing is sent. Each bid locks a {deposit} fUSD deposit, so price × shares stays within it.</span>
          </div>
          {error ? <p className="mt-3 text-[15px] text-destructive" role="alert">{error}</p> : null}
        </div>
      ) : (
        <p className="max-w-[46ch] text-[18px]">
          {phase === "ended"
            ? `Time's up. Your browser opened all five envelopes with its key, and the ${supply} shares go to the top bids.`
            : "Your browser made an ML-KEM-1024 key and sealed all five bids to it. Nobody can read them until the sale ends. Hover or tap any bid."}
        </p>
      )}

      {phase !== "pick" && phase !== "sealing" ? (
        <>
          <ol className="mt-8 max-w-[660px] border-t border-foreground/15">
            {rows.map((b) => {
              const won = result.filled.get(b.key) ?? 0;
              const open = phase === "ended";
              const seen = looking === b.key;
              return (
                <motion.li className="border-b border-foreground/15" key={b.key} layout={open && !still ? "position" : false} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
                  <button
                    aria-label={open ? `${b.who}: ${b.qty} shares at ${b.price} fUSD, won ${won}` : b.mine ? `Your sealed bid: ${b.qty} shares at ${b.price} fUSD` : `${b.who}: sealed`}
                    className={`grid w-full grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-center gap-4 py-3 text-left ${b.mine ? "text-foreground" : ""}`}
                    onBlur={() => setLooking(null)}
                    onClick={() => setLooking(seen ? null : b.key)}
                    onMouseEnter={() => setLooking(b.key)}
                    onMouseLeave={() => setLooking(null)}
                    type="button"
                  >
                    <span className={`text-[15px] ${b.mine ? "font-semibold" : "text-muted-foreground"}`}>{b.who}</span>
                    {open ? (
                      <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <span className="w-24 text-[18px]">{b.price} <span className="text-[14px] text-muted-foreground">fUSD</span></span>
                        <span className="flex flex-wrap gap-1.5">
                          {Array.from({ length: b.qty }, (_, i) => (
                            <i className={`size-5 transition-colors duration-300 ${i < won ? "bg-accent" : "border border-foreground/35"}`} key={i} style={{ transitionDelay: `${300 + i * 60}ms` }} />
                          ))}
                        </span>
                      </span>
                    ) : (
                      <span className="relative block">
                        <ByteTiles bytes={b.envelope} label={b.mine ? "Your sealed bid" : "A sealed bid"} maxCols={150} pose={phase === "opening" || (b.mine && seen)} text={`${b.qty} × ${b.price} fUSD`} tile={3} />
                        {seen && !b.mine && phase === "sealed" ? (
                          <span className="absolute inset-0 flex items-center justify-center bg-background/85 px-2 text-center text-[15px]">Sealed. It opens when the sale ends.</span>
                        ) : null}
                      </span>
                    )}
                    <span className="text-right text-[15px] text-muted-foreground">
                      {!open ? "Sealed" : seen ? `Paid ${money(won * result.clearing)}` : `Won ${won}`}
                    </span>
                  </button>
                  {open && b.key === lastWinner ? (
                    <div className="flex items-center gap-3 pb-3 text-[15px] text-accent">
                      <span className="h-px flex-1 bg-accent" />
                      Price: {result.clearing} fUSD, paid by every winner
                    </div>
                  ) : null}
                </motion.li>
              );
            })}
          </ol>

          {phase === "ended" ? (
            <div className="mt-8 flex flex-col items-start gap-8">
              <div>
                <p className="text-[56px] leading-none tracking-[-0.04em] md:text-[72px]">
                  {result.clearing.toFixed(2)} <span className="text-[24px] tracking-normal md:text-[28px]">fUSD</span>
                </p>
                <p className="mt-3 max-w-[40ch] text-[18px]">Everyone pays {money(result.clearing)}, the lowest winning price.</p>
                <p className="mt-1 text-[17px] text-muted-foreground">
                  {you ? `You won ${you}: paid ${money(you * result.clearing)}, ${money(deposit - you * result.clearing)} back.` : `You won none, so your ${money(deposit)} deposit comes back.`}
                </p>
                <p className="mt-4 text-[16px] text-muted-foreground">{NAMES.slice(0, book.length).join(", ").replace(/, ([^,]*)$/, " and $1")}'s bids are real: this painting's last sale.</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button autoFocus onClick={replay} quiet>Try again</Button>
                <a className="inline-flex min-h-12 items-center bg-foreground px-5 py-3 text-[16px] text-background transition-[background-color,color,scale] duration-150 hover:bg-accent motion-safe:active:scale-[0.96]" href={`/sales/${openSale.saleId}?price=${price}&shares=${shares}`}>
                  Place this bid in the real sale →
                </a>
              </div>
            </div>
          ) : (
            <div className="mt-8 flex flex-wrap gap-3">
              <Button autoFocus disabled={phase === "opening"} onClick={endSale}>End the sale</Button>
              <Button onClick={replay} quiet>Change my bid</Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
