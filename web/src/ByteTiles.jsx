import { useEffect, useRef, useState } from "react";
import { tokenRgb, useTheme } from "./theme.jsx";

// Bytes drawn as the page's tiles: one tile per byte, shaded by its value, in the same 8px grid as the sea.
// `text` is a readable pose in lit tiles. mode "seal" turns the text into the bytes, "open" turns the bytes
// into the text, once, when the block scrolls into view. Under reduced motion it shows the end pose.
// Colours come from the theme: bytes run from the background to the accent, lit text is the foreground.
const DUR = { seal: 1000, open: 1200 };
const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
const jitter = (i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

const line = "color-mix(in srgb, var(--color-background) 65%, transparent)";
export const gaps = (tile) => ({
  backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
  backgroundSize: `${tile}px ${tile}px`,
});

// Which tiles the text lights, drawn with the page's mono font at tile resolution.
function textMask(text, cols, rows) {
  const c = document.createElement("canvas");
  c.width = cols;
  c.height = rows;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const fit = (lines) => {
    let px = Math.min(16, Math.floor(rows / lines.length) - 2);
    while (px > 6) {
      ctx.font = `${px}px "Fragment Mono", monospace`;
      if (Math.max(...lines.map((l) => ctx.measureText(l).width)) <= cols - 2) return px;
      px--;
    }
    return 0;
  };
  // One line or two, whichever lets the letters be bigger.
  let lines = [text];
  let px = fit(lines);
  if (text.includes(" ")) {
    const words = text.split(" ");
    const half = Math.ceil(words.length / 2);
    const two = [words.slice(0, half).join(" "), words.slice(half).join(" ")];
    const px2 = fit(two);
    if (px2 > px) [lines, px] = [two, px2];
  }
  if (!px) return null;
  ctx.font = `${px}px "Fragment Mono", monospace`;
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lh = px * 1.15;
  lines.forEach((l, i) => ctx.fillText(l, cols / 2, rows / 2 + (i - (lines.length - 1) / 2) * lh));
  const a = ctx.getImageData(0, 0, cols, rows).data;
  return Array.from({ length: cols * rows }, (_, i) => a[i * 4 + 3] > 100);
}

// `phoneTile`: a smaller tile on narrow screens, so lettering in the tiles stays readable.
// `pose`: when given, the parent decides: true shows the text, false the bytes, and a change animates between them
// (hover, tap, End sale). Without it, `mode` plays once on scroll as before.
export default function ByteTiles({ bytes, text, mode: playOnce, pose, tile: wide = 8, phoneTile, maxCols = 112, label, onDone }) {
  const box = useRef(null);
  const canvas = useRef(null);
  const played = useRef(false);
  const draw = useRef(null); // paints a given progress; set once the text mask is ready
  const at = useRef(pose ? 1 : 0); // controlled progress: 0 bytes, 1 text
  const theme = useTheme();
  const [[cols, tile], setGrid] = useState([0, wide]);
  const controlled = pose !== undefined;
  const mode = controlled ? "open" : playOnce;

  useEffect(() => {
    const watch = new ResizeObserver(([e]) => {
      const t = phoneTile && e.contentRect.width < 480 ? phoneTile : wide;
      setGrid([Math.max(8, Math.min(maxCols, Math.floor(e.contentRect.width / t))), t]);
    });
    watch.observe(box.current);
    return () => watch.disconnect();
  }, [wide, phoneTile, maxCols]);

  useEffect(() => {
    if (!cols || !bytes?.length) return;
    const rows = Math.ceil(bytes.length / cols);
    const c = canvas.current;
    c.width = cols;
    c.height = rows;
    c.style.width = `${cols * tile}px`;
    c.style.height = `${rows * tile}px`;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(cols, rows);
    const [base, accent, ink] = ["background", "accent", "foreground"].map(tokenRgb);
    let mask = null;
    // Tiles turn over left to right, with a little scatter so it reads as many small changes, not a wipe.
    const when = (i) => ((i % cols) / cols) * 0.75 + jitter(i) * 0.25;
    const paint = (p) => {
      for (let i = 0; i < cols * rows; i++) {
        const showBytes = !mode || (mode === "seal" ? p > when(i) : p <= when(i));
        const rgb = i >= bytes.length ? base : showBytes ? mix(base, accent, 0.15 + (0.85 * bytes[i]) / 255) : mask?.[i] ? ink : mix(base, accent, 0.08);
        img.data.set([...rgb, 255], i * 4);
      }
      ctx.putImageData(img, 0, 0);
    };
    let frame = 0;
    let watch = null;
    let gone = false;
    const run = () => {
      if (gone) return;
      if (text) mask = textMask(text, cols, rows);
      if (controlled) {
        draw.current = paint;
        paint(at.current);
        return;
      }
      // Already played (say, before a theme switch) or no motion wanted: draw the end pose.
      if (!mode || played.current || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        paint(1);
        onDone?.();
        return;
      }
      paint(0);
      watch = new IntersectionObserver(([e]) => {
        if (!e.isIntersecting) return;
        watch.disconnect();
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / DUR[mode]);
          paint(ease(p));
          if (p < 1) frame = requestAnimationFrame(step);
          else {
            played.current = true;
            onDone?.();
          }
        };
        frame = requestAnimationFrame(step);
      }, { threshold: 0.4 });
      watch.observe(c);
    };
    // The text pose needs the real font, or the first frame is drawn in a fallback.
    document.fonts.load('12px "Fragment Mono"').then(run, run);
    return () => { gone = true; draw.current = null; watch?.disconnect(); cancelAnimationFrame(frame); };
  }, [cols, bytes, text, mode, tile, theme]); // onDone is a fresh function each render; it doesn't change what's drawn

  // Controlled pose: animate from wherever the tiles are to the asked-for pose.
  useEffect(() => {
    if (!controlled) return;
    const target = pose ? 1 : 0;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      at.current = target;
      draw.current?.(target);
      return;
    }
    const from = at.current;
    const t0 = performance.now();
    let frame = 0;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 500);
      at.current = from + (target - from) * ease(p);
      draw.current?.(at.current);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [pose, controlled]);

  return (
    <div className="w-full" ref={box}>
      <div className="relative w-fit">
        <canvas aria-label={label} className="block" ref={canvas} role="img" style={{ imageRendering: "pixelated" }} />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={gaps(tile)} />
      </div>
    </div>
  );
}
