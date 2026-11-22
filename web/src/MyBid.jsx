import { useEffect, useState } from "react";
import { formatUnits, hexToBytes } from "viem";
import { SiteHeader } from "./App.jsx";
import { openOwnBid } from "./lib/bid.js";
import { readReceiptBid } from "./lib/chain.js";
import { downloadReceipt, parseReceipt, readReceipts, saveReceipt } from "./lib/receipt.js";
import { short } from "./sale.js";

const link = "text-accent underline underline-offset-4";
const amount = (value) => `${formatUnits(BigInt(value), 6)} fUSD`;
const Tx = ({ hash, children }) => <a className={link} href={`/tx/${hash}`}>{children}</a>;

function BidResult({ receipt }) {
  const [result, setResult] = useState();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setResult(undefined);
    setError("");
    (async () => {
      const bid = await readReceiptBid(receipt);
      if (!current) return;
      if (!bid) {
        setResult(null);
        return;
      }
      const { placed, tx } = bid;
      let terms;
      try {
        terms = openOwnBid({ ...receipt, envelope: hexToBytes(placed.envelope) });
      } catch {
        throw new Error("This receipt could not open the bid. Choose the private file for this bid.");
      }
      if (!terms.matches) throw new Error("The opened bid does not match its on-chain commitment.");
      saveReceipt({ ...receipt, tx });
      setResult({ ...bid, terms });
    })().catch((e) => {
      if (current) setError(e.shortMessage ?? e.message);
    });
    return () => { current = false; };
  }, [receipt, refresh]);

  const retry = () => setRefresh((value) => value + 1);
  const retryButton = <button className={`min-h-11 ${link}`} onClick={retry} type="button">Refresh from testnet</button>;
  if (error) return <><p role="alert" className="text-destructive">{error}</p>{retryButton}</>;
  if (result === undefined) return <p role="status">Checking the bid on QoreChain…</p>;
  if (result === null) return <><p>No confirmed placement found yet.</p>{retryButton}</>;

  const { claim, claimed, sale, terms, tx } = result;
  const rows = [["Your sealed bid", `Up to ${terms.qty} at ${amount(terms.price)} each`]];
  if (claim) rows.push(
    ["Editions delivered", String(claim.args.assetAmount / sale.unit)],
    ["Clearing price per edition", sale.clearing ? amount(sale.clearing) : "No winning bids"],
    ["Deposit returned", amount(claim.args.refund)],
  );
  return (
    <>
      <p role="status" className="font-semibold">Your bid matches the commitment on QoreChain.</p>
      <dl className="mt-4 border-t border-border">
        {rows.map(([label, value]) => (
          <div className="flex flex-wrap justify-between gap-x-4 border-b border-border py-3" key={label}>
            <dt className="text-muted-foreground">{label}</dt><dd className="m-0 font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {!claim ? (
        <p className="mt-3 text-muted-foreground">
          {claimed ? "The payout is recorded. Its transaction proof is still being located." : sale.settled ? "The sale is settled. The payout is pending." : "The result will appear after the sale settles and the payout is recorded."}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Tx hash={tx}>Placement transaction</Tx>
        {claim ? <Tx hash={claim.transactionHash}>Payout transaction</Tx> : retryButton}
        <button className={`min-h-11 ${link}`} onClick={() => downloadReceipt({ ...receipt, tx })} type="button">Download private receipt</button>
      </div>
    </>
  );
}

export default function MyBid() {
  const [receipts, setReceipts] = useState(readReceipts);
  const [chosen, setChosen] = useState(() => {
    const query = new URLSearchParams(location.search);
    const tx = query.get("tx")?.toLowerCase();
    return query.get("bid") ?? (tx ? receipts.find((r) => r.tx === tx)?.fingerprint : receipts[0]?.fingerprint);
  });
  const [error, setError] = useState("");
  const receipt = receipts.find((r) => r.fingerprint === chosen);
  const load = async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      if (file.size > 16_384) throw new Error("Choose the small JSON file downloaded from Allot.");
      const imported = parseReceipt(JSON.parse(await file.text()));
      saveReceipt(imported);
      setReceipts((current) => [imported, ...current.filter((r) => r.fingerprint !== imported.fingerprint)]);
      setChosen(imported.fingerprint);
    } catch {
      setError("That file could not be read as an Allot private receipt.");
    }
  };
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[720px] px-5 pb-20 pt-6 sm:px-12">
        <h1 className="text-[44px] font-semibold leading-tight tracking-tight">My bid</h1>
        <div className="my-6 flex flex-wrap items-end gap-4">
          {receipts.length > 1 ? (
            <label className="grid gap-1 text-sm">
              Saved bids
              <select className="min-h-11 border border-border bg-background px-2" value={chosen ?? ""} onChange={(e) => setChosen(e.target.value)}>
                <option value="" disabled>Choose a bid</option>
                {receipts.map((r) => <option key={r.fingerprint} value={r.fingerprint}>Sale {r.saleId} · {short(r.tx ?? r.fingerprint)}</option>)}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1 text-sm">
            Open private receipt
            <input className="min-h-11 w-full text-sm file:mr-2 file:min-h-11 file:border-0 file:bg-muted file:px-3" accept=".json,application/json" type="file" onChange={load} />
          </label>
        </div>
        {error ? <p role="alert" className="mb-4 text-destructive">{error}</p> : null}
        {receipt ? (
          <>
            <a className={`mb-3 inline-block ${link}`} href={`/sales/${receipt.saleId}`}>Sale {receipt.saleId} →</a>
            <BidResult key={receipt.fingerprint} receipt={receipt} />
          </>
        ) : <p className="text-muted-foreground">Open the private file saved when you placed your bid. It opens in this browser.</p>}
      </main>
    </>
  );
}
