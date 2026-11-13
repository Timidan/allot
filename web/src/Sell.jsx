import { useState } from "react";
import { SiteHeader } from "./App.jsx";

// /sell: an owner lists an image or a song, and Allot runs its sealed-bid sale (the guest server's /api/consign).
// The file goes up as the raw request body; its type is checked on the server by its bytes.
const LENGTHS = [[600, "10 minutes"], [3600, "1 hour"], [86400, "1 day"], [259200, "3 days"]];
const field = "mt-2 block w-full rounded border border-border bg-background px-3 py-2.5 text-[16px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const Label = ({ text, hint, children }) => (
  <label className="block text-[15px]">
    {text}
    {hint ? <span className="text-muted-foreground"> {hint}</span> : null}
    {children}
  </label>
);

export default function Sell() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [peaks, setPeaks] = useState(""); // a song's shape: 64 heights, 0 to z, drawn as its picture in the gallery
  const pick = async (e) => {
    const f = e.target.files?.[0] ?? null;
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : "");
    setPeaks("");
    if (f?.type.startsWith("audio/")) {
      try {
        const data = (await new AudioContext().decodeAudioData(await f.arrayBuffer())).getChannelData(0);
        const step = Math.floor(data.length / 64);
        const max = Array.from({ length: 64 }, (_, i) => data.subarray(i * step, (i + 1) * step).reduce((m, v) => Math.max(m, Math.abs(v)), 0));
        const top = Math.max(...max) || 1;
        setPeaks(max.map((m) => Math.round((m / top) * 35).toString(36)).join(""));
      } catch {
        // the browser can't decode it: the song lists without a waveform
      }
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    const form = new FormData(e.currentTarget);
    if (!file) return setError("Choose an image or a song to sell.");
    if (file.size > 8 * 1024 * 1024) return setError("Files can be up to 8 MB.");
    const q = new URLSearchParams({ title: form.get("title"), by: form.get("by"), about: form.get("about"), shares: form.get("shares"), reserve: form.get("reserve"), length: form.get("length"), rights: form.get("rights") ? "1" : "0", ...(peaks && { peaks }) });
    setBusy(true);
    try {
      const r = await fetch(`/api/consign?${q}`, { method: "POST", body: file });
      const json = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(json.error ?? "The listing didn't go through. Try again in a minute.");
      location.href = `/sales/${json.saleId}`;
    } catch (x) {
      setError(x.message);
      setBusy(false);
    }
  };

  const audio = file?.type.startsWith("audio/");
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-[1200px] px-5 pb-20 md:px-12">
        <h1 className="text-[40px] font-semibold leading-tight tracking-tight md:text-[56px]">Sell shares in your own work</h1>
        <p className="mt-3 max-w-[60ch] text-pretty text-[18px] text-muted-foreground">
          Upload an image or a song. Allot runs a sealed-bid sale of shares in it: it issues the shares on QoreChain testnet, holds the key that opens the bids, and settles when time runs out. Every bid locks a 10 fUSD deposit.
        </p>
        <form className="mt-10 grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(320px,440px)] md:items-start" onSubmit={submit}>
          <div>
            {/* The whole area is the file input (transparent, on top), so a click or a dropped file both work. */}
            <label className="relative flex min-h-[200px] flex-col md:min-h-[360px] items-center justify-center gap-2 rounded-md border border-dashed border-foreground/30 p-6 text-center focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring hover:border-foreground/60">
              <input accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/ogg,audio/wav,audio/mp4,.m4a" aria-label="What you're selling: an image or a song" className="absolute inset-0 cursor-pointer opacity-0" name="file" onChange={pick} type="file" />
              {preview && !audio ? (
                <img alt="" className="max-h-[56vh] w-full object-contain" src={preview} />
              ) : (
                <>
                  <span className="text-[20px]">{file ? file.name : <>Choose an image or a song<span className="hidden pointer-fine:inline">, or drop it here</span></>}</span>
                  <span className="text-[15px] text-muted-foreground">JPEG, PNG or WebP image, or MP3, OGG, WAV or M4A song, up to 8 MB</span>
                </>
              )}
            </label>
            {preview && audio ? <audio className="mt-4 w-full" controls src={preview} /> : null}
            {file ? <p className="mt-2 text-[15px] text-muted-foreground">{file.name}. Click the area to choose another.</p> : null}
          </div>
          <div className="space-y-5 rounded-md border border-border bg-muted p-5">
            <Label text="Title"><input className={field} maxLength={80} name="title" required /></Label>
            <Label text="Made by"><input className={field} maxLength={60} name="by" required /></Label>
            <Label hint="optional" text="About it"><textarea className={`${field} min-h-24`} maxLength={280} name="about" /></Label>
            <div className="grid grid-cols-2 gap-3">
              <Label text="Shares"><input className={field} defaultValue={10} max={100} min={1} name="shares" required step={1} type="number" /></Label>
              <Label text="Lowest price, fUSD"><input className={field} defaultValue={1} max={10} min={1} name="reserve" required step={1} type="number" /></Label>
            </div>
            <Label text="Sale length">
              <select className={field} defaultValue={3600} name="length">{LENGTHS.map(([s, t]) => <option key={s} value={s}>{t}</option>)}</select>
            </Label>
            <label className="flex gap-3 text-[15px]">
              <input className="mt-1 size-4 shrink-0 pointer-coarse:size-6" name="rights" required type="checkbox" />
              <span>I made this or may sell shares in it. These are testnet shares: they stand for nothing.</span>
            </label>
            <button className="h-13 w-full rounded bg-primary font-semibold text-primary-foreground transition-[background-color,scale] duration-150 hover:bg-accent motion-safe:active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60" disabled={busy} type="submit">
              {busy ? "Creating the shares and the sale…" : "List it for sale"}
            </button>
            <p aria-live="polite" className="text-[15px] text-muted-foreground">{busy ? "Three transactions on QoreChain testnet. About 20 seconds." : "One listing per visitor a day."}</p>
            {error ? <p className="text-[15px] text-destructive" role="alert">{error}</p> : null}
          </div>
        </form>
      </main>
    </>
  );
}
