import { useEffect, useState } from "react";
import PriceFlow from "@/components/smoothui/price-flow";

export default function Countdown({ to }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((to - now) / 1000));
  if (!left) return "Ended";
  const d = Math.floor(left / 86400), h = Math.floor(left / 3600) % 24;
  // Seconds only matter on the last day; with days left the line stays short enough for a phone.
  return (
    <span className="inline-flex items-baseline whitespace-nowrap tabular-nums">
      {d ? `${d}d ` : ""}{h}h&nbsp;<PriceFlow value={Math.floor(left / 60) % 60} />m
      {d ? null : <>&nbsp;<PriceFlow value={left % 60} />s</>}
    </span>
  );
}
