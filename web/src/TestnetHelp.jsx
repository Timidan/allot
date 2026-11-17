import { openSetup } from "./SetupGuide.jsx";

// QOR, QoreChain's own token, with QoreChain's icon (from qorechain.io). fUSD has no official logo, so it stays a symbol.
export const Qor = () => (
  <span className="whitespace-nowrap">
    <img alt="" className="inline size-[1.1em] rounded-full align-[-0.2em]" src="/qor.png" /> QOR
  </span>
);

// For testers bidding from their own wallet: one line, and the guide behind it.
const TestnetHelp = ({ className = "mt-4 border-t border-border pt-4" }) => (
  <p className={`text-[14px] leading-relaxed text-muted-foreground ${className}`}>
    Bidding from your own wallet?{" "}
    <button className="min-h-11 text-accent underline underline-offset-4 hover:decoration-2" onClick={() => openSetup(0)} type="button">Set up QoreX in 5 steps</button>
  </p>
);

export default TestnetHelp;
