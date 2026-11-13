import { useEffect, useState } from "react";
import { SiteHeader } from "./App.jsx";
import { readTx } from "./lib/chain.js";
import { SALE_CONTRACT, money as fusd, short } from "./sale.js";
import { Qor } from "./TestnetHelp.jsx";

// /tx/<hash>: one transaction, read from QoreChain testnet, in plain words.
const EXTERNAL = "https://dashboard.qorechain.io/explorer/tx/";
const money = (x) => fusd(Number(x) / 1e6); // event amounts are in fUSD base units (6 decimals)
const when = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");
const who = (a) => (a?.toLowerCase() === SALE_CONTRACT ? "the sale contract" : short(a ?? ""));

// What the transaction did, from the sale contract's own events.
function what(t) {
  if (!t.evm) return t.pass ? "A post-quantum pass opens" : "A QoreChain transaction";
  const placed = t.events.find((e) => e.eventName === "BidPlaced");
  if (placed) return `A sealed bid, placed in sale ${placed.args.saleId}`;
  if (t.events.some((e) => e.eventName === "BidOpened")) return `Bids opened in sale ${t.events[0].args.saleId}`;
  const claimed = t.events.find((e) => e.eventName === "Claimed");
  if (claimed) return `A bid paid out in sale ${claimed.args.saleId}`;
  return "A transaction on QoreChain";
}

const Row = ({ label, children }) => (
  <div className="grid gap-1 border-b border-border py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
    <dt className="text-[15px] text-muted-foreground">{label}</dt>
    <dd className="m-0 text-[17px]">{children}</dd>
  </div>
);

export default function TxPage({ hash }) {
  const [t, setT] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    readTx(hash).then(setT, (e) => setError(`Couldn't find this transaction on QoreChain testnet: ${e.shortMessage ?? e.message}`));
  }, [hash]);
  const placed = t?.events?.find((e) => e.eventName === "BidPlaced");
  const opened = t?.events?.filter((e) => e.eventName === "BidOpened") ?? [];
  const claimed = t?.events?.find((e) => e.eventName === "Claimed");
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[900px] px-5 pb-20 md:px-12">
        <p className="text-[15px] text-muted-foreground">Transaction on QoreChain testnet</p>
        <h1 className="mt-1 text-[32px] font-semibold leading-tight tracking-tight md:text-[44px]">{t ? what(t) : error ? "Not found" : "Reading…"}</h1>
        {error ? <p className="mt-4 text-[16px] text-destructive" role="alert">{error}</p> : null}
        {t ? (
          <dl className="mt-8 border-t border-border">
            <Row label="Status">{t.ok ? "Succeeded" : "Failed"}, block {t.block.toLocaleString()}, {when(t.time)}</Row>
            {t.evm ? <Row label="From → to">{who(t.from)} → {who(t.to)}</Row> : <Row label="Sent by">{short(t.from ?? "")}</Row>}
            {placed ? <Row label="Inside">Sealed: {((placed.args.envelope.length - 2) / 2).toLocaleString()} bytes. The price and shares stay hidden until the sale ends.</Row> : null}
            {opened.length ? <Row label="Opened">{opened.map((e) => `${e.args.qty} at ${money(e.args.price)}`).join(", ")}</Row> : null}
            {claimed ? <Row label="Paid out">{String(claimed.args.assetAmount)} shares, {money(claimed.args.refund)} back</Row> : null}
            {t.evm ? (
              <Row label="Signature">
                Ordinary (ECDSA).{" "}
                {t.pass ? (
                  <>
                    Accepted because a post-quantum pass was open: transaction {t.pass.used} of {t.pass.max ?? "–"} on it.{" "}
                    {t.pass.tx ? <a className="text-accent underline-offset-4 hover:underline" href={`/tx/${t.pass.tx}`}>See the pass →</a> : null}
                  </>
                ) : null}
              </Row>
            ) : (
              <Row label="Signature">
                {t.pq?.verified ? `Post-quantum (ML-DSA-87, listed as ${t.pq.algorithm}) and ordinary together. QoreChain verified both.` : "Ordinary"}
              </Row>
            )}
            {!t.evm && t.pass ? (
              <Row label="The pass">
                Open until block {t.pass.until.toLocaleString()}, up to {t.pass.max} transactions, only to {t.pass.targets.length === 2 ? "the sale and fUSD" : `${t.pass.targets.length} contracts`}.
              </Row>
            ) : null}
            <Row label="Fee">{t.fee ? <>{t.fee.toFixed(4)} <Qor /></> : "–"}</Row>
            <Row label="Hash"><span className="break-all font-mono text-[15px]">{hash}</span></Row>
          </dl>
        ) : null}
        <p className="mt-8 text-[15px] text-muted-foreground">
          <a className="text-accent underline-offset-4 hover:underline" href={EXTERNAL + hash} rel="noreferrer" target="_blank">Open in QoreChain's explorer ↗</a>{" "}
          It opens on mainnet: select Testnet at its top right.
        </p>
      </main>
    </>
  );
}
