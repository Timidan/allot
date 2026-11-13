// QOR, QoreChain's own token, with QoreChain's icon (from qorechain.io). fUSD has no official logo, so it stays a symbol.
export const Qor = () => (
  <span className="whitespace-nowrap">
    <img alt="" className="inline size-[1.1em] rounded-full align-[-0.2em]" src="/qor.png" /> QOR
  </span>
);

// For testers bidding from their own wallet: where the test tokens and the wallet come from.
const TestnetHelp = ({ className = "mt-4 border-t border-border pt-4" }) => (
  <p className={`text-[14px] leading-relaxed text-muted-foreground ${className}`}>
    Testing with your own wallet? You need <Qor /> for network fees and fUSD for bids. Get both from{" "}
    <a className="text-accent underline underline-offset-4 hover:decoration-2" href="https://dashboard.qorechain.io/faucet" rel="noreferrer" target="_blank">QoreChain's faucet ↗</a>{" "}
    (sign in, paste your qor1 address, once a day). Get QoreX for{" "}
    <a className="text-accent underline underline-offset-4 hover:decoration-2" href="https://chromewebstore.google.com/detail/qorex/cflpnggbnnifibblifgbeobogdpfjpcg" rel="noreferrer" target="_blank">Chrome ↗</a>,{" "}
    <a className="text-accent underline underline-offset-4 hover:decoration-2" href="https://addons.mozilla.org/firefox/addon/qorex/" rel="noreferrer" target="_blank">Firefox ↗</a> or{" "}
    <a className="text-accent underline underline-offset-4 hover:decoration-2" href="https://apps.apple.com/us/app/qorex-wallet/id6794132220" rel="noreferrer" target="_blank">Safari ↗</a>, or the app for{" "}
    <a className="text-accent underline underline-offset-4 hover:decoration-2" href="https://apps.apple.com/us/app/qorex-wallet/id6791256626" rel="noreferrer" target="_blank">iPhone ↗</a> or{" "}
    <a className="text-accent underline underline-offset-4 hover:decoration-2" href="https://play.google.com/store/apps/details?id=network.qore.qorex" rel="noreferrer" target="_blank">Android ↗</a>{" "}
    and open this site in its dApp browser. Turn on its testnet in its settings.
  </p>
);

export default TestnetHelp;
