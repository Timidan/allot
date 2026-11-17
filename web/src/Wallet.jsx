import { useEffect, useState, useSyncExternalStore } from "react";
import { connect, findQorex, readiness } from "./lib/qorex.js";
import { money } from "./sale.js";
import { STEP, SetupGuide, needs, openSetup } from "./SetupGuide.jsx";
import { Qor } from "./TestnetHelp.jsx";

// One QoreX connection for every page but the landing: the header shows it, the bid box uses it.
let state = { address: null, missing: false };
const subs = new Set();
const set = (s) => {
  state = { ...state, ...s };
  subs.forEach((f) => f());
};
const OFF = "allot-wallet-off"; // set on Disconnect, so a reload doesn't reconnect without asking
const off = () => {
  try {
    return localStorage.getItem(OFF) === "1";
  } catch {
    return false;
  }
};
let found; // QoreX is looked up once per page
export const findWallet = () =>
  (found ??= findQorex().then((p) => {
    if (!p) set({ missing: true });
    else p.on?.("accountsChanged", (a) => set({ address: off() ? null : (a?.[0] ?? null) }));
    return p;
  }));

export const useWallet = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state);

export async function connectWallet() {
  const provider = await findWallet();
  if (!provider) throw needs("QoreX isn't installed.", STEP.install);
  const address = await connect(provider);
  try {
    localStorage.removeItem(OFF);
  } catch {
    // storage off: nothing to forget
  }
  set({ address });
  return { provider, address };
}

async function disconnect() {
  set({ address: null });
  try {
    localStorage.setItem(OFF, "1");
  } catch {
    // storage off: the next reload reconnects silently
  }
  (await findWallet())?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
}

// Where to get QoreX for this device (links from QoreChain's docs). On a phone QoreX is an app, and a site uses
// it from inside the app's dApp browser, which injects the same window.qorex as the extension.
const ua = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const ANDROID = /Android/.test(ua);
export const PHONE = IOS || ANDROID;
export const STORES = {
  ios: "https://apps.apple.com/us/app/qorex-wallet/id6791256626",
  android: "https://play.google.com/store/apps/details?id=network.qore.qorex",
  chrome: "https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg",
  firefox: "https://addons.mozilla.org/firefox/addon/qorex/",
  safari: "https://apps.apple.com/us/app/qorex-wallet/id6794132220",
};
export const GET_QOREX = IOS ? STORES.ios : ANDROID ? STORES.android : /Firefox\//.test(ua) ? STORES.firefox : /Safari\//.test(ua) && !/Chrome|Chromium|Edg/.test(ua) ? STORES.safari : STORES.chrome;
const button = "inline-flex min-h-11 items-center border border-foreground/40 px-4 py-2 text-foreground transition-[background-color,color,scale] duration-150 hover:bg-foreground hover:text-background motion-safe:active:scale-[0.96]";
const link = "text-accent underline underline-offset-4 hover:decoration-2";
// Native popover: Escape and a tap outside close it. It sits under the header's top right, never wider than the screen.
const panel = "fixed inset-auto right-5 top-20 m-0 w-[min(20rem,calc(100vw-2.5rem))] whitespace-normal border border-foreground/30 bg-background p-5 font-mono text-[14px] text-foreground md:right-12";

// The header's wallet status: Connect QoreX, or the connected account with a panel of what it holds.
export const WalletButton = () => (
  <>
    <WalletStatus />
    <SetupGuide />
  </>
);

// The one thing this account still needs before it can bid, as the tap or link that does it.
function Next({ info }) {
  const how = (step) => <button className={`min-h-11 ${link}`} onClick={() => { document.getElementById("wallet")?.hidePopover(); openSetup(step); }} type="button">Show me how</button>;
  const openIt = "In QoreX, tap \u201cMetaMask on QoreChain\u201d and open a window";
  const say = !info.holder ? <>No post-quantum key on this account yet. {openIt}: QoreX registers the key as it opens it. {how(STEP.pass)}</>
    : !info.passOk ? <>{info.live ? "Your access window is nearly used up." : "Your access window is closed."} {openIt}. {how(STEP.pass)}</>
    : info.uqor < 300_000n ? <>No QOR for network fees. Get test QOR from QoreChain's faucet, once a day. {how(STEP.funds)}</>
    : !info.token ? <>Ready, except for fUSD to bid with. When you bid from your wallet, Allot offers to send the deposit.</>
    : <>Ready to bid from this account.</>;
  return <p className="mt-4 border-t border-foreground/15 pt-3">{say}</p>;
}

function WalletStatus() {
  const { address, missing } = useWallet();
  const [error, setError] = useState("");
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState(false);

  // A visitor who connected before comes back connected, without a prompt.
  useEffect(() => {
    findWallet()
      .then(async (p) => {
        if (!p || off()) return;
        const [a] = await p.request({ method: "eth_accounts" });
        if (a) set({ address: a });
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    setInfo(null);
    if (address) readiness(address, 0n).then(setInfo, () => setInfo({ failed: true }));
  }, [address]);

  if (!address) {
    if (missing && PHONE) {
      return (
        <>
          <button className={button} popoverTarget="wallet" type="button">Use QoreX</button>
          <div className={panel} id="wallet" popover="auto">
            <p>On a phone, you bid through the QoreX app.</p>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              <li><a className={link} href={GET_QOREX} rel="noreferrer" target="_blank">Get QoreX for {IOS ? "iPhone" : "Android"} ↗</a></li>
              <li>In its Settings, turn on Use testnet (developers).</li>
              <li>Open its dApp browser and go to {location.host}.</li>
            </ol>
          </div>
        </>
      );
    }
    if (missing) return <a className={button} href={GET_QOREX} rel="noreferrer" target="_blank">Get QoreX ↗</a>;
    const go = async () => {
      setError("");
      try {
        await connectWallet();
      } catch (e) {
        if (e.code !== 4001) setError((e.shortMessage ?? e.message ?? "").replace(/^QoreX: /, "") || "QoreX didn't connect.");
      }
    };
    return (
      <span className="relative">
        <button className={button} onClick={go} type="button">Connect QoreX</button>
        {error ? <span className="absolute right-0 top-full z-10 mt-2 w-72 whitespace-normal bg-background text-[14px] text-destructive" role="alert">{error}</span> : null}
      </span>
    );
  }

  const qor = info?.qor;
  const copy = () => navigator.clipboard?.writeText(qor).then(() => setCopied(true), () => {});
  return (
    <>
      <button className={button} popoverTarget="wallet" type="button">{qor ? `${qor.slice(0, 8)}…${qor.slice(-4)}` : `${address.slice(0, 6)}…${address.slice(-4)}`}</button>
      <div className={panel} id="wallet" onMouseLeave={() => setCopied(false)} popover="auto">
        <p className="break-all">{qor ?? address}</p>
        {qor ? <button className={`mt-1 min-h-11 ${link}`} onClick={copy} type="button">{copied ? "Copied" : "Copy address"}</button> : null}
        <dl className="mt-4 space-y-2 border-t border-foreground/15 pt-4 tabular-nums">
          {info?.failed ? (
            <div className="text-muted-foreground">QoreChain testnet didn't answer.</div>
          ) : (
            <>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Post-quantum key</dt><dd>{info ? (info.holder ? "Registered" : "Not yet") : "…"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">EVM access window</dt><dd>{info ? (info.passOk ? "Open" : info.live ? "Nearly used up" : "Closed") : "…"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">fUSD to bid with</dt><dd>{info ? money(Number(info.token) / 1e6) : "…"}</dd></div>
              {info?.bank ? <div className="flex justify-between gap-4"><dt className="text-muted-foreground">fUSD from the faucet</dt><dd>{money(Number(info.bank) / 1e6)}</dd></div> : null}
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Network fees</dt><dd>{info ? <>{(Number(info.uqor) / 1e6).toFixed(2)} <Qor /></> : "…"}</dd></div>
            </>
          )}
        </dl>
        {info && !info.failed ? <Next info={info} /> : null}
        <button className={`mt-5 w-full ${button}`} onClick={disconnect} type="button">Disconnect</button>
      </div>
    </>
  );
}
