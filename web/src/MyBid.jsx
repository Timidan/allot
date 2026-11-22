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
const backupLabels = {
  waiting: "Waiting for the first lot’s result.",
  skipped: "Backup skipped.",
  expired: "The backup lot closed before a bid was placed.",
  failed: "The backup bid could not be placed.",
  placed: "Backup bid placed. Checking its receipt.",
};

async function readStatus(requestId) {
  if (!requestId) return null;
  try {
    const r = await fetch("/api/bid-status", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId }),
    });
    if (r.status === 404) return { state: "unrecorded" };
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function verifyBid(receipt) {
  const bid = await readReceiptBid(receipt);
  if (!bid) return null;
  let terms;
  try {
    terms = openOwnBid({ ...receipt, envelope: hexToBytes(bid.placed.envelope) });
  } catch {
    throw new Error("This receipt could not open the bid. Choose the private file for this bid.");
  }
  if (!terms.matches) throw new Error("The opened bid does not match its on-chain commitment.");
  return { ...bid, terms };
}

function BidProof({ bid }) {
  const { claim, claimed, sale, terms, tx } = bid;
  const rows = [["Your sealed bid", `Up to ${terms.qty} at ${amount(terms.price)} each`]];
  if (claim) rows.push(
    ["Shares delivered", String(claim.args.assetAmount / sale.unit)],
    ["Clearing price a share", sale.clearing ? amount(sale.clearing) : "No winning bids"],
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
        {claim ? <Tx hash={claim.transactionHash}>Payout transaction</Tx> : null}
      </div>
    </>
  );
}

function BidResult({ receipt }) {
  const [result, setResult] = useState();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setResult(undefined);
    setError("");
    (async () => {
      const order = await readStatus(receipt.requestId);
      const primary = await verifyBid({ ...receipt, tx: receipt.tx ?? order?.tx });
      if (!current) return;
      const backupTx = receipt.backup?.tx ?? order?.backup?.tx;
      let backup;
      let backupError;
      if (receipt.backup && (backupTx || (!order?.backup && primary?.claim))) {
        try {
          backup = await verifyBid({ ...receipt.backup, tx: backupTx });
        } catch (e) {
          backupError = e.shortMessage ?? e.message;
        }
      }
      if (!current) return;
      const saved = {
        ...receipt, ...(primary && { tx: primary.tx }),
        ...(backup && { backup: { ...receipt.backup, tx: backup.tx } }),
      };
      saveReceipt(saved);
      setResult({ primary, backup, order, saved, backupError });
    })().catch((e) => {
      if (current) setError(e.shortMessage ?? e.message);
    });
    return () => { current = false; };
  }, [receipt, refresh]);

  const retry = () => setRefresh((value) => value + 1);
  const retryButton = <button className={`min-h-11 ${link}`} onClick={retry} type="button">Refresh from testnet</button>;
  if (error) return <><p role="alert" className="text-destructive">{error}</p>{retryButton}</>;
  if (result === undefined) return <p role="status">Checking the bid on QoreChain…</p>;
  const { primary, backup, order, saved, backupError } = result;
  const status = order?.backup?.state;
  return (
    <>
      {primary ? <BidProof bid={primary} /> : <p role="status">{
        order?.state === "expired" ? "The lot closed before your bid was placed." :
          order?.state === "failed" ? "QoreChain refused the bid." :
          order?.state === "unrecorded" ? "Allot has no submission for this receipt yet. Refresh before bidding again." : "No confirmed placement found yet."
      }</p>}
      {receipt.backup ? (
        <section className="mt-6 border-t border-border pt-4">
          <h2 className="mb-2 font-semibold"><a className={link} href={`/sales/${receipt.backup.saleId}`}>Backup lot {receipt.backup.saleId}</a></h2>
          {backup ? <BidProof bid={backup} /> :
            <p className={backupError ? "text-destructive" : "text-muted-foreground"} role={backupError ? "alert" : "status"}>
              {backupError ?? backupLabels[status] ?? "Backup status is currently unavailable."}
            </p>}
        </section>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        {retryButton}
        <button className={`min-h-11 ${link}`} onClick={() => downloadReceipt(saved)} type="button">Download private receipt</button>
      </div>
    </>
  );
}

export default function MyBid() {
  const [receipts, setReceipts] = useState(readReceipts);
  const [chosen, setChosen] = useState(() => {
    const query = new URLSearchParams(location.search);
    const tx = query.get("tx")?.toLowerCase();
    return query.get("bid") ?? (tx ? receipts.find((r) => r.tx === tx || r.backup?.tx === tx)?.fingerprint : receipts[0]?.fingerprint);
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
          {receipts.length > 1 || (receipts.length === 1 && !receipt) ? (
            <label className="grid gap-1 text-sm">
              Saved bids
              <select className="min-h-11 border border-border bg-background px-2" value={chosen ?? ""} onChange={(e) => setChosen(e.target.value)}>
                <option value="" disabled>Choose a bid</option>
                {receipts.map((r) => <option key={r.fingerprint} value={r.fingerprint}>Sale {r.saleId} · {short(r.tx ?? r.fingerprint)}</option>)}
              </select>
            </label>
          ) : null}
          <label className="grid gap-1 text-sm">
            {receipt ? "Open another receipt" : "Open private receipt"}
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
