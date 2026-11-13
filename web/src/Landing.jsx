import { useEffect, useMemo, useRef, useState } from "react";
import ByteTiles from "./ByteTiles.jsx";
import Countdown from "./Countdown.jsx";
import SeaShader from "./SeaShader.jsx";
import TryAuction from "./TryAuction.jsx";
import { rangesOf, readBook, readSale, readWindow } from "./lib/chain.js";
import { SALE_CONTRACT, lastSale, openSale, painting, short } from "./sale.js";
import { ThemeSwitch } from "./theme.jsx";

// A share split four ways, one taken: the mark.
export const Mark = () => (
  <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16">
    <rect fill="currentColor" height="7" width="7" x="0.5" y="0.5" />
    <rect fill="none" height="6" stroke="currentColor" width="6" x="9" y="1" />
    <rect fill="none" height="6" stroke="currentColor" width="6" x="1" y="9" />
    <rect fill="none" height="6" stroke="currentColor" width="6" x="9" y="9" />
  </svg>
);

// Links are underlined, not just coloured; buttons give a small press; photos get a hairline edge in both themes.
const link = "text-accent underline underline-offset-4 hover:decoration-2";
const press = "transition-[background-color,color,scale] duration-150 motion-safe:active:scale-[0.96]";
const tap = "pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"; // a 44px target for fingers
const outlined = "outline-1 -outline-offset-1 outline-black/10 [[data-theme=dark]_&]:outline-white/10";
const H2 = ({ children }) => <h2 className="max-w-[24ch] text-balance text-[30px] leading-tight tracking-[-0.03em] lg:text-[40px]">{children}</h2>;
const Sub = ({ children }) => <p className="mt-4 max-w-[40ch] text-pretty text-[17px] leading-normal text-muted-foreground">{children}</p>;
// Every section and the footer share one grid: heading on the left (5 of 12 columns), the working part on the right.
const Grid = ({ children }) => <div className="max-w-[1344px] lg:grid lg:grid-cols-12 lg:gap-x-12">{children}</div>;
const Section = ({ id, title, sub, children }) => (
  <section className="border-t border-foreground/10 px-6 py-20 md:px-12 md:py-28" id={id}>
    <Grid>
      <div className="lg:col-span-5"><H2>{title}</H2>{sub}</div>
      <div className="mt-10 lg:col-span-7 lg:mt-0">{children}</div>
    </Grid>
  </section>
);
// Chain reads take a few seconds, so an empty section says what it is waiting for.
const Waiting = ({ down, className = "" }) => (
  <p className={`h-64 text-[17px] text-muted-foreground ${className}`}>{down ? "QoreChain testnet didn't answer. Reload the page to try again." : "Reading QoreChain testnet…"}</p>
);
const Switch = ({ options, value, onChange, label }) => (
  <div aria-label={label} className="inline-flex border border-foreground/40" role="group">
    {options.map(([v, text]) => (
      <button aria-pressed={value === v} className={`h-11 px-4 text-[15px] transition-colors duration-150 ${value === v ? "bg-foreground text-background" : "hover:bg-foreground/10"}`} key={v} onClick={() => onChange(v)} type="button">
        {text}
      </button>
    ))}
  </div>
);

// One sealed bid, shown two ways. After Q-Day the usual seal falls open and the bid can be read; QoreChain's stays shut.
const SealedPanel = ({ title, bytes, text, open, state }) => (
  <div>
    <p className="mb-4 text-[16px] lg:text-[18px]">{title}</p>
    <ByteTiles bytes={bytes} label={open ? `Open: ${text}` : "A sealed bid"} maxCols={90} pose={open} text={text} tile={4} />
    <p aria-live="polite" className={`mt-4 text-[16px] lg:text-[18px] ${open ? "text-destructive" : "text-accent"}`}><span className="sr-only">{title}: </span>{state}</p>
  </div>
);

// ponytail: the usual-seal panel is drawn for comparison (it reuses the real envelope's tiles); the rail says so.
function QDay({ book }) {
  const [after, setAfter] = useState(false);
  const bid = book?.[0];
  if (!bid) return <div className="h-64" />;
  const text = `${bid.shares} × ${bid.price} fUSD`;
  return (
    <>
      <Switch label="When" onChange={(v) => setAfter(v === "after")} options={[["today", "Today"], ["after", "After Q-Day"]]} value={after ? "after" : "today"} />
      <div className="mt-8 grid grid-cols-2 gap-4 lg:gap-12">
        <SealedPanel bytes={bid.envelope} open={after} state={after ? "Open" : "Sealed"} text={text} title="Usual seal" />
        <SealedPanel bytes={bid.envelope} open={false} state={after ? "Still sealed" : "Sealed"} text={text} title="QoreChain seal" />
      </div>
    </>
  );
}

const PassRow = ({ what, how, tx }) => (
  <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-foreground/15 py-3 text-[17px]">
    <span className="sm:w-48">{what}</span>
    <span className="order-last w-full text-muted-foreground sm:order-none sm:w-auto sm:flex-1">{how}</span>
    {tx ? <a aria-label={`See it: ${what} on QoreChain testnet`} className={`${link} ${tap}`} href={`/tx/${tx}`}>See it →</a> : null}
  </li>
);

// The rule as a switch (no chain data needed), then a real pass and the bids it let through, each a link.
function Pass({ sealed, book, down }) {
  const [when, setWhen] = useState("open");
  const [w, setW] = useState(); // undefined until read, null if no pass was found, false if the read failed
  const bid = sealed?.[0];
  useEffect(() => {
    if (bid) readWindow(bid.bidder, bid.block).then(setW, () => setW(false));
  }, [bid]);
  const end = w && w.from + w.blocks;
  const bids = !w ? [] : [...(book ?? []).map((b) => ({ ...b, sale: "last sale" })), ...sealed.map((b) => ({ ...b, sale: "current sale" }))]
    .filter((b) => b.bidder === bid.bidder && b.block >= w.from && b.block < end)
    .sort((a, b) => a.block - b.block);
  const state = { before: "Refused: no pass yet", open: "Goes through: the pass is open", after: "Refused: the pass has ended" }[when];
  return (
    <>
      <Switch label="When the bid is sent" onChange={setWhen} options={[["before", "Before"], ["open", "Pass open"], ["after", "After"]]} value={when} />
      <p aria-live="polite" className={`mt-6 text-[24px] ${when === "open" ? "text-accent" : "text-destructive"}`}>{state}</p>
      {w ? (
        <ol className="mt-10 border-t border-foreground/15">
          <PassRow how="post-quantum signature, ML&#8209;DSA&#8209;87" tx={w.tx} what="Pass opened" />
          {bids.map((b) => <PassRow how="ordinary signature, accepted" key={b.tx} tx={b.tx} what={`Bid, ${b.sale}`} />)}
          <PassRow how={`after about ${Math.round((w.blocks * 1.43) / 60)} min or ${w.maxTxs} transactions`} what="Pass ends" />
          <PassRow how={w.targets.length === 2 ? "the sale and fUSD only" : `${w.targets.length} contracts only`} what="Works for" />
        </ol>
      ) : sealed?.length === 0 || w === null ? null : (
        <Waiting className="mt-10" down={down || w === false} />
      )}
    </>
  );
}

const Facts = ({ open, className = "" }) => (
  <dl className={`space-y-1 ${className}`}>
    <div className="flex justify-between gap-6"><dt>Shares on sale</dt><dd>{open?.supply ?? "–"}</dd></div>
    <div className="flex justify-between gap-6"><dt>Sealed bids</dt><dd>{open?.bids ?? "–"}</dd></div>
    <div className="flex justify-between gap-6"><dt>Ends in</dt><dd>{open ? <Countdown to={open.closeAt} /> : "–"}</dd></div>
  </dl>
);

export default function Landing() {
  const [open, setOpen] = useState(null);
  const [sealed, setSealed] = useState(null);
  const [last, setLast] = useState(null);
  const [book, setBook] = useState(null);
  const [down, setDown] = useState(false); // a chain read failed
  const nav = useRef(null);
  const words = useRef(null);
  const card = useRef(null);
  const calm = useMemo(() => [nav, words, card], []);
  useEffect(() => {
    const fail = () => setDown(true);
    readSale(SALE_CONTRACT, openSale.saleId).then(setOpen, fail);
    rangesOf(openSale).then((r) => readBook(SALE_CONTRACT, openSale.saleId, r)).then(setSealed, fail);
    readSale(SALE_CONTRACT, lastSale.saleId).then(setLast, fail);
    readBook(SALE_CONTRACT, lastSale.saleId, lastSale.ranges).then(setBook, fail);
  }, []);

  return (
    <div className="relative min-h-dvh bg-background font-mono text-foreground">
      {/* The header sits over the sea but outside <main>, so it stays the page's banner. */}
      {/* On a phone the links take a second row under the logo. */}
      <header className="absolute inset-x-0 top-0 z-10 flex flex-wrap items-center gap-x-10 whitespace-nowrap px-6 pt-4 md:h-22 md:flex-nowrap md:px-12 md:pt-0" ref={nav}>
        <a className="flex min-h-11 items-center gap-2 font-sans text-lg font-semibold" href="/"><Mark />Allot</a>
        <nav className="order-last flex w-full gap-5 text-[14px] text-foreground/80 md:order-none md:w-auto md:gap-7">
          {/* "Why QoreChain" is a section further down; on a narrow phone it gives way so the other three fit. */}
          {[["#how", "How it works"], ["#why", "Why QoreChain"], ["/sales", "Sales"], ["/sell", "Sell"]].map(([href, text]) => (
            <a className={`${href === "#why" ? "hidden sm:inline-flex" : "inline-flex"} min-h-11 items-center hover:text-foreground`} href={href} key={href}>{text}</a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-5 text-[14px]">
          <ThemeSwitch className="min-h-11 px-1 py-2 text-foreground/80 hover:text-foreground" />
          <a className={`hidden min-h-11 items-center border border-foreground/70 bg-background px-4 py-2 hover:bg-foreground hover:text-background lg:inline-flex ${press}`} href="/sales">See the sales</a>
        </div>
      </header>

      <main>
      <section className="relative isolate flex min-h-dvh flex-col overflow-hidden pt-28 md:pt-22">
        <SeaShader calm={calm} />
        <div className="flex flex-1 flex-col gap-12 px-6 pb-10 md:justify-end md:px-12 md:pb-16">
          {/* On a phone the words sit at the foot of the first screen, so the sea shows above them. From lg the
              sale card takes the top right, so the words keep clear of its column. */}
          <div className="flex min-h-[calc(100dvh-8rem)] flex-col justify-end md:min-h-0 lg:pr-[348px]">
            <div className="max-w-[1000px]" ref={words}>
              <h1 className="text-balance text-[40px] leading-[1.05] tracking-[-0.04em] md:text-[56px] lg:text-[64px] xl:text-[72px]">
                Bid without being seen.<br />Even after Q&#8209;Day.
              </h1>
              <p className="mt-6 max-w-[44ch] text-pretty text-[17px] leading-normal text-foreground/80 md:text-[19px]">
                Allot is a secret-bid marketplace on QoreChain for shares of real things: art, property, a fund. Each bid is sealed with post-quantum encryption, so no other bidder can read it, today or after Q&#8209;Day. When time runs out, the best bids win and every winner pays the same price.
              </p>
            </div>
          </div>
          <aside className="w-full max-w-[300px] border border-foreground/30 bg-background p-3 lg:absolute lg:right-12 lg:top-24" ref={card}>
            <img alt={painting.alt} className={`block aspect-[16/10] w-full object-cover ${outlined}`} src={painting.image} />
            <div className="mt-3 font-sans text-[16px] font-semibold">{painting.title}</div>
            <div className="text-[13px] text-muted-foreground">{painting.artist}, 1909. Testnet sample</div>
            <Facts className="mt-3 text-[13px] text-foreground/80" open={open} />
            <a className={`mt-3 flex min-h-11 items-center justify-center bg-foreground px-3 py-2 text-[14px] text-background hover:bg-accent ${press}`} href={`/sales/${openSale.saleId}`}>Place a bid →</a>
          </aside>
        </div>
      </section>

      <Section id="how" sub={<Sub>10 shares of {painting.title} are for sale. Ana, Ben, Chi and Dee have already bid. Your turn.</Sub>} title="How a secret&#8209;bid sale works">
        {last && book ? <TryAuction book={book} last={last} /> : <Waiting down={down} />}
      </Section>

      <Section
        id="why"
        sub={
          <>
            <Sub>Bids stay sealed for days. QoreChain seals them with post-quantum encryption, so even a quantum computer can't open them early.</Sub>
            <Sub>
              The usual seal is drawn for comparison. The QoreChain seal is Ana's real bid.{" "}
              {book?.[0] ? <a aria-label="See it: Ana's bid on QoreChain testnet" className={link} href={`/tx/${book[0].tx}`}>See it →</a> : null}
            </Sub>
          </>
        }
        title="Q-Day: the day a quantum computer can break today's locks"
      >
        {book ? <QDay book={book} /> : <Waiting down={down} />}
      </Section>

      <Section
        id="under"
        sub={<Sub>A pass is a short permission to bid. A bidder opens one by signing with a post-quantum key. Without one, QoreChain refuses the bid. QoreChain calls it an EVM window.</Sub>}
        title="A post-quantum pass for every bidder"
      >
        <Pass book={book} down={down} sealed={sealed} />
      </Section>

      <Section sub={<Sub>{painting.title}, {painting.artist}. Testnet sample. Only accounts with a post-quantum key can hold its shares.</Sub>} title="The real sale">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end">
          <img alt={painting.alt} className={`aspect-[16/10] w-full object-cover sm:w-[300px] ${outlined}`} src={painting.image} />
          <div className="flex-1">
            <Facts className="text-[17px]" open={open} />
            <a className={`mt-6 flex h-12 items-center justify-center bg-foreground text-[16px] text-background hover:bg-accent ${press}`} href={`/sales/${openSale.saleId}`}>Place a bid →</a>
          </div>
        </div>
      </Section>
      </main>

      {/* One flat row. The own-wallet help lives on the sale page, where bids are placed. */}
      <footer className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-foreground/10 px-6 py-8 text-[14px] text-muted-foreground md:px-12">
        <span className="flex items-center gap-2 self-center font-sans text-[15px] font-semibold text-foreground"><Mark />Allot</span>
        <span>QoreChain testnet</span>
        <span>Sale contract {short(SALE_CONTRACT)}</span>
        <span>
          Photo: <a className={link} href={painting.source} rel="noreferrer" target="_blank">Ángel M. Felicísimo</a>,{" "}
          <a className={link} href="https://creativecommons.org/licenses/by/2.0/" rel="noreferrer" target="_blank">CC BY 2.0</a>
        </span>
        <span>No cookies or analytics; IPs held in memory only</span>
      </footer>
    </div>
  );
}
