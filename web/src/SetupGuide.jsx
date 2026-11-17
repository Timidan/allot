import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { readiness } from "./lib/qorex.js";
import { Qor } from "./TestnetHelp.jsx";
import { GET_QOREX, connectWallet, findWallet, useWallet } from "./Wallet.jsx";

// One guide for getting a QoreX wallet ready to bid. Any page opens it at the step the visitor is stuck on:
// openSetup(2). It shows one step at a time and, once QoreX is connected, says which steps are already done.
export const STEP = { install: 0, testnet: 1, account: 2, pass: 3, funds: 4 };
let at = null; // the open step, or null when closed
const subs = new Set();
export const openSetup = (step = 0) => {
  at = step;
  subs.forEach((f) => f());
};
// An error the bid box can show in a few words, with the step that fixes it.
export const needs = (message, step) => Object.assign(new Error(message), { help: step });

const FAUCET = "https://dashboard.qorechain.io/faucet";
const link = "text-accent underline underline-offset-4 hover:decoration-2";
const primary = "inline-flex min-h-11 items-center justify-center bg-primary px-5 font-semibold text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-accent motion-safe:active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const quiet = "inline-flex min-h-11 items-center justify-center border border-foreground/40 px-4 transition-[background-color,color,scale] duration-150 hover:bg-foreground hover:text-background motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// Where to tap inside QoreX, drawn as the menu path itself.
const Path = ({ steps }) => (
  <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-2 font-mono text-[14px]">
    {steps.map((s, i) => (
      <span className="flex items-center gap-2" key={s}>
        {i ? <span aria-hidden="true" className="text-muted-foreground">→</span> : null}
        <span className={`border px-2.5 py-1.5 ${i === steps.length - 1 ? "border-accent text-foreground" : "border-foreground/25 text-muted-foreground"}`}>{s}</span>
      </span>
    ))}
  </p>
);

function Copy({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className={`${link} min-h-11`} onClick={() => navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, () => {})} type="button">
      {copied ? "Copied" : "Copy my address"}
    </button>
  );
}

export function SetupGuide() {
  const step = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => at);
  const { address, missing } = useWallet();
  const [info, setInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [dir, setDir] = useState(1);
  const ref = useRef(null);
  const still = useReducedMotion();
  const open = step !== null;

  const check = async () => {
    setChecking(true);
    try {
      await findWallet();
      if (address) setInfo(await readiness(address, 0n));
    } catch {
      setInfo(null);
    }
    setChecking(false);
  };
  useEffect(() => {
    const d = ref.current;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (open) check();
  }, [open, address]);

  const go = (n) => {
    setDir(n > step ? 1 : -1);
    openSetup(n);
  };
  const connect = () => connectWallet().catch(() => {});

  // done: true, false, or null when it can't be told yet.
  const steps = [
    {
      title: "Get QoreX",
      body: "QoreX is QoreChain's wallet. Bids are signed in it.",
      action: <a className={quiet} href={GET_QOREX} rel="noreferrer" target="_blank">Get QoreX ↗</a>,
      done: missing ? false : address ? true : null,
    },
    {
      title: "Turn on testnet",
      body: "Allot runs on QoreChain's testnet, which QoreX hides until you turn it on.",
      path: ["Settings", "Developer mode", "Use testnet"],
      action: address ? null : <button className={quiet} onClick={connect} type="button">Connect QoreX</button>,
      done: address ? true : null,
    },
    {
      title: "Use an Ethereum account",
      body: "A bid is a contract call, and QoreX sends those only from an Ethereum account. In QoreX, the account under your balance should read \u201cEthereum \u00b7 coin 60\u201d. If it doesn't, add or pick one under Wallets. It is still QoreChain, and fees are still paid in QOR.",
      path: ["Wallets", "Ethereum \u00b7 coin 60"],
      manual: "Allot can't see the account type: check it in QoreX.",
    },
    {
      title: "Open an EVM access window",
      body: "QoreChain refuses contract calls from an account with no open window. Opening the first one also registers this account's post-quantum key, which the sale requires.",
      path: ["QoreX", "MetaMask on QoreChain", "Open a window"],
      detail: info ? `Post-quantum key: ${info.holder ? "registered" : "not yet"}. Window: ${info.passOk ? "open" : info.live ? "nearly used up" : "closed"}.` : null,
      done: info ? info.holder && info.passOk : null,
    },
    {
      title: "Get QOR for fees",
      body: <>The faucet gives test <Qor /> for network fees, once a day. Bids also lock an fUSD deposit: the faucet's fUSD arrives as a bank coin that QoreX can't convert yet, so when you bid from your wallet, Allot offers to send you the deposit.</>,
      action: <span className="flex flex-wrap items-center gap-x-5 gap-y-1"><a className={quiet} href={FAUCET} rel="noreferrer" target="_blank">Open the faucet ↗</a>{info?.qor ? <Copy text={info.qor} /> : null}</span>,
      detail: info ? `QOR: ${(Number(info.uqor) / 1e6).toFixed(2)}. fUSD to bid with: ${(Number(info.token) / 1e6).toFixed(2)}.` : null,
      done: info ? info.uqor >= 300_000n : null,
    },
  ];
  const s = steps[step ?? 0];
  const last = step === steps.length - 1;
  const ready = steps.every((x) => x.manual || x.done === true);

  return (
    <dialog
      aria-labelledby="setup-title"
      className="m-auto w-[min(34rem,calc(100vw-2rem))] whitespace-normal border border-foreground/30 bg-background p-0 text-left font-sans text-[16px] font-normal text-foreground backdrop:bg-black/55"
      onClick={(e) => e.target === ref.current && openSetup(null)}
      onClose={() => openSetup(null)}
      ref={ref}
    >
      {open ? (
        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between gap-4 text-[14px] text-muted-foreground">
            <span>Set up QoreX, step {step + 1} of {steps.length}</span>
            <button aria-label="Close" className="-mr-2 grid size-11 place-items-center text-[22px] leading-none transition-colors hover:text-foreground" onClick={() => openSetup(null)} type="button">×</button>
          </div>
          <div aria-hidden="true" className="mt-1 flex gap-1.5">
            {steps.map((x, i) => (
              <span className={`h-[3px] flex-1 transition-colors duration-200 ${x.done ? "bg-accent" : i === step ? "bg-foreground" : "bg-foreground/15"}`} key={x.title} />
            ))}
          </div>
          <div className="mt-6 min-h-[15rem] overflow-hidden">
            <AnimatePresence custom={dir} initial={false} mode="wait">
              <motion.div animate={{ x: 0, opacity: 1 }} exit={still ? { opacity: 0 } : { x: -24 * dir, opacity: 0 }} initial={still ? { opacity: 0 } : { x: 24 * dir, opacity: 0 }} key={step} transition={{ duration: 0.18, ease: [0.2, 0.8, 0.3, 1] }}>
                <h2 className="text-[26px] font-semibold leading-tight tracking-tight" id="setup-title">{s.title}</h2>
                <p className="mt-3 text-[16px] leading-relaxed text-muted-foreground">{s.body}</p>
                {s.path ? <Path steps={s.path} /> : null}
                {s.action ? <div className="mt-5">{s.action}</div> : null}
                {s.detail ? <p className="mt-4 font-mono text-[14px] text-muted-foreground">{s.detail}</p> : null}
                <p aria-live="polite" className="mt-5 flex min-h-11 flex-wrap items-center gap-x-4 text-[15px]">
                  {s.manual ? <span className="text-muted-foreground">{s.manual}</span> : s.done === true ? <b className="font-semibold text-accent">Done</b> : s.done === false ? <b className="font-semibold">Not yet</b> : <span className="text-muted-foreground">{address ? "Checking" : "Connect QoreX to check"}</span>}
                  {address ? <button className={`${link} min-h-11`} disabled={checking} onClick={check} type="button">{checking ? "Checking" : "Check again"}</button> : null}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-foreground/15 pt-5">
            <button className={quiet} disabled={step === 0} onClick={() => go(step - 1)} type="button">Back</button>
            {last ? <button className={primary} onClick={() => openSetup(null)} type="button">{ready ? "Ready to bid" : "Close"}</button> : <button className={primary} onClick={() => go(step + 1)} type="button">Next</button>}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
