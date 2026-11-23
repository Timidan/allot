import { useLayoutEffect, useRef } from "react";
import { painting } from "./sale.js";

// The lot breaks into its shares as the page scrolls past: the painting cracks into ten pieces, they straighten
// into equal shares, then line up for sale. One paused timeline; the scroll position sets its time, so scrolling
// back mends the picture. Without motion the page shows the last frame: the row of shares.
// Lengths are shares of the picture's width (x) or height (y), so the whole thing scales with its box.
const COLS = 5;
const ROWS = 2; // ten shares, as in the practice sale below
export const SHARES = COLS * ROWS;
const RATIO = 10 / 16; // the picture's height over its width
const GAP = 0.02; // gutter between shares
const WIDE = (1 - (SHARES - 1) * GAP) / SHARES; // a share's width once in the row
const SMALL = WIDE * COLS; // its size there, against its size in the picture
const ROW = (SMALL / ROWS) * RATIO; // the row's height over its width

const CRACK = 0.3; // seconds of timeline; the scroll plays them
const LINE = 2.5; // the shares line up for sale
const T = 3.6;
const PLAYED = 0.85; // of the pinned scroll; the rest holds the row before the page moves on

// A small seeded generator: the break is the same on every visit.
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pct = (v) => `${(v * 100).toFixed(2)}%`;
const polygon = (pts) => `polygon(${pts.map(([x, y]) => `${pct(x)} ${pct(y)}`).join(",")})`;

// The cracks: a 5 × 2 lattice whose inner corners are nudged and whose inner edges are bent. Every piece has
// eight points (four corners, four edge points), so it can straighten into its rectangle without a jump.
const PIECES = (() => {
  const rand = rng(11);
  const j = (a) => (rand() - 0.5) * 2 * a;
  const P = Array.from({ length: ROWS + 1 }, (_, r) =>
    Array.from({ length: COLS + 1 }, (_, c) => [c / COLS + (c % COLS ? j(0.045) : 0), r / ROWS + (r % ROWS ? j(0.1) : 0)]));
  const H = P.map((row, r) => row.slice(0, COLS).map((p, c) => [(p[0] + row[c + 1][0]) / 2, (p[1] + row[c + 1][1]) / 2 + (r % ROWS ? j(0.07) : 0)]));
  const V = P.slice(0, ROWS).map((row, r) => row.map((p, c) => [(p[0] + P[r + 1][c][0]) / 2 + (c % COLS ? j(0.035) : 0), (p[1] + P[r + 1][c][1]) / 2]));
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const [x0, x1, y0, y1] = [c / COLS, (c + 1) / COLS, r / ROWS, (r + 1) / ROWS];
      const [xm, ym] = [(x0 + x1) / 2, (y0 + y1) / 2];
      const k = r * COLS + c;
      out.push({
        r, c, k, cx: xm, cy: ym,
        gx: (c - (COLS - 1) / 2) * GAP, gy: ((r - (ROWS - 1) / 2) * GAP) / RATIO, // split, still in the picture
        rx: k * (WIDE + GAP) + WIDE / 2 - xm, ry: SMALL / ROWS / 2 - ym, // in the row
        shard: polygon([P[r][c], H[r][c], P[r][c + 1], V[r][c + 1], P[r + 1][c + 1], H[r + 1][c], P[r + 1][c], V[r][c]]),
        square: polygon([[x0, y0], [xm, y0], [x1, y0], [x1, ym], [x1, y1], [xm, y1], [x0, y1], [x0, ym]]),
      });
    }
  }
  return out;
})();

// How each piece flies. Pieces near the blow leave first and go furthest.
const FLIGHT = (() => {
  const rand = rng(8);
  const [ix, iy] = [0.58, 0.45]; // where the blow lands
  return PIECES.map((p) => {
    const [vx, vy] = [p.cx - ix, (p.cy - iy) * RATIO]; // in widths
    const dist = Math.hypot(vx, vy) || 0.01;
    const near = 1 - Math.min(dist / 0.6, 1);
    const reach = 0.05 + 0.1 * near + rand() * 0.07; // uneven, so the pieces don't fly out as a ring
    return {
      bx: (vx / dist) * reach * (vx < 0 ? 0.45 : 1), // less to the left, where the words are
      by: (((vy / dist) * reach) / RATIO) * (vy < 0 ? 0.6 : 1) - 0.02, // less upward, where the step is named on a phone
      rot: (rand() < 0.5 ? -1 : 1) * (6 + 16 * rand()) * (0.6 + 0.6 * near),
      jolt: (rand() - 0.5) * 5,
      start: CRACK + 0.2 + dist * 0.15,
      settle: CRACK + 1 + (p.r + p.c) * 0.03 + rand() * 0.05,
      line: LINE + p.k * 0.04,
    };
  });
})();

const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
const IN_OUT = "cubic-bezier(0.6, 0, 0.2, 1)";
const SPRING = "cubic-bezier(0.25, 0, 0.15, 1.28)";
const IN = "cubic-bezier(0.5, 0, 1, 0.6)";
const STEP = "step-end";

// One property on one element over the whole timeline. keys: [seconds, value, easing to the next key].
const track = (el, prop, keys) => {
  const all = [...(keys[0][0] > 0 ? [[0, keys[0][1], "linear"]] : []), ...keys, ...(keys.at(-1)[0] < T ? [[T, keys.at(-1)[1]]] : [])];
  const a = el.animate(
    { [prop]: all.map((k) => k[1]), offset: all.map((k) => k[0] / T), easing: all.map((k) => k[2] ?? "linear") },
    { duration: T * 1000, fill: "both" },
  );
  a.pause();
  return a;
};

function animate(root, after) {
  const xs = [...root.querySelectorAll("[data-x]")];
  const ys = [...root.querySelectorAll("[data-y]")];
  const out = [
    track(root, "scale", [[CRACK - 0.24, "1", IN], [CRACK, "0.965", EXPO], [CRACK + 0.3, "1"]]), // it tenses before the break
    track(root.querySelector("[data-whole]"), "opacity", [[0, 1, STEP], [CRACK, 0]]),
    track(after, "opacity", [[LINE + 0.6, 0, "ease-out"], [LINE + 1, 1]]),
  ];
  PIECES.forEach((p, i) => {
    const f = FLIGHT[i];
    out.push(
      track(xs[i], "opacity", [[0, 0, STEP], [CRACK, 1]]),
      track(xs[i], "translate", [[f.start, "0% 0px", EXPO], [f.start + 0.5, `${pct(f.bx)} 0px`, "linear"], [f.settle, `${pct(f.bx * 1.07)} 0px`, IN_OUT], [f.settle + 0.75, `${pct(p.gx)} 0px`], [f.line, `${pct(p.gx)} 0px`, IN_OUT], [f.line + 0.6, `${pct(p.rx)} 0px`]]),
      track(ys[i], "translate", [[f.start, "0px 0%", EXPO], [f.start + 0.5, `0px ${pct(f.by)}`, "linear"], [f.settle, `0px ${pct(f.by * 1.07 + 0.02)}`, SPRING], [f.settle + 0.75, `0px ${pct(p.gy)}`], [f.line, `0px ${pct(p.gy)}`, SPRING], [f.line + 0.6, `0px ${pct(p.ry)}`]]),
      track(ys[i], "rotate", [[f.start - 0.2, "0deg", EXPO], [f.start - 0.06, `${f.jolt}deg`, "linear"], [f.start, `${f.jolt}deg`, EXPO], [f.start + 0.5, `${f.rot}deg`, "linear"], [f.settle, `${f.rot * 1.12}deg`, SPRING], [f.settle + 0.75, "0deg"], [f.line, "0deg", IN_OUT], [f.line + 0.3, `${p.rx < 0 ? 5 : -5}deg`, IN_OUT], [f.line + 0.6, "0deg"]]),
      track(ys[i], "scale", [[f.start - 0.2, "1", EXPO], [f.start - 0.06, "0.94", "linear"], [f.start, "0.94", EXPO], [f.start + 0.5, "1"], [f.line, "1", IN_OUT], [f.line + 0.6, String(SMALL)]]),
      track(ys[i], "clipPath", [[0, p.shard], [f.settle, p.shard, IN_OUT], [f.settle + 0.75, p.square]]),
    );
  });
  return out;
}

// `onBeat`: 1 while it breaks, 2 while the shares line up, 3 once the scroll has played it through.
// `caption` stays above the picture; `children` sit under the row and appear with it.
export default function Shatter({ onBeat, caption, children }) {
  const wrap = useRef(null);
  const pin = useRef(null);
  const root = useRef(null);
  const after = useRef(null);
  useLayoutEffect(() => {
    const run = matchMedia("(prefers-reduced-motion: reduce)").matches ? [] : animate(root.current, after.current);
    let shown = -1;
    let beat = 0;
    let frame = 0;
    // How far the page has scrolled through the stretch where the picture stays pinned.
    const scrolled = () => {
      const r = wrap.current.getBoundingClientRect();
      const range = r.height - pin.current.offsetHeight;
      return range > 1 ? Math.max(0, Math.min(1, (parseFloat(getComputedStyle(pin.current).top) - r.top) / range)) : 1;
    };
    const tick = () => {
      const q = scrolled();
      shown = shown < 0 ? q : shown + (q - shown) * 0.22; // eased, so a mouse wheel doesn't step
      if (Math.abs(q - shown) < 0.0005) shown = q;
      const t = Math.min(shown / PLAYED, 1) * T;
      run.forEach((a) => (a.currentTime = t * 1000));
      const b = shown > 0.97 ? 3 : t < LINE ? 1 : 2;
      if (b !== beat) onBeat?.((beat = b));
      frame = shown === q ? 0 : requestAnimationFrame(tick);
    };
    const on = () => (frame ||= requestAnimationFrame(tick));
    on();
    addEventListener("scroll", on, { passive: true });
    addEventListener("resize", on);
    return () => {
      removeEventListener("scroll", on);
      removeEventListener("resize", on);
      cancelAnimationFrame(frame);
      run.forEach((a) => a.cancel());
    };
  }, [onBeat]);
  const image = { backgroundImage: `url("${painting.image}")` };
  return (
    // Tall, so the picture stays in place while the scroll breaks it. The row is all that takes up room at the
    // end; until then the picture hangs below it, over the empty stretch. svh, not dvh: a phone's address bar
    // sliding away must not change the heights the scroll is measured against.
    <div className="min-h-[120svh] motion-reduce:min-h-0" ref={wrap}>
      {/* Narrower where it would fill its column (a phone, a small laptop), so the pieces that fly right stay on the screen. */}
      <div className="sticky top-[22svh] w-[86%] max-w-[520px] sm:w-full lg:top-[max(6rem,14svh)] lg:w-[86%] xl:w-full" ref={pin}>
        {caption}
        <div className="relative">
          <div style={{ aspectRatio: `1 / ${ROW}` }} />
          <div aria-label={`${painting.title}, split into ${SHARES} shares`} className="pointer-events-none absolute inset-x-0 top-0 aspect-[16/10]" ref={root} role="img">
            <div className="absolute inset-0 bg-muted bg-cover bg-center opacity-0" data-whole style={image} />
            {PIECES.map((p) => (
              <div className="absolute inset-0 drop-shadow-[0_1px_3px_rgb(0_0_0/0.22)]" data-x key={p.k} style={{ translate: `${pct(p.rx)} 0px` }}>
                <div className="absolute inset-0 bg-muted bg-cover bg-center" data-y style={{ ...image, translate: `0px ${pct(p.ry)}`, scale: String(SMALL), clipPath: p.square, transformOrigin: `${pct(p.cx)} ${pct(p.cy)}` }} />
              </div>
            ))}
          </div>
        </div>
        <div ref={after}>{children}</div>
      </div>
    </div>
  );
}
