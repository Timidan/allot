import { useEffect, useRef } from "react";
import { gaps } from "./ByteTiles.jsx";
import { useTheme } from "./theme.jsx";

// The backdrop: wind across the sea of "Walk on the Beach", streaked like the painting's veils, in Sorolla's
// blues, foam white and sand, laid in square tiles like an LED wall, so you see the colours, not the detail.
// The shader draws one pixel per tile (cheap on phones); CSS scales it up and draws the gaps.
// Pass `calm` (up to three refs) to keep the sea plain behind those elements so their text reads.
// Moving the pointer over the sea, or tapping it, drops rings that spread across the water.
// One still frame under reduced motion; without WebGL the page background shows instead.
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float; // the hash below falls apart at mediump, which is what phones give by default
#else
precision mediump float;
#endif
uniform vec2 uRes;      // canvas size in tiles
uniform float uTime;
uniform vec4 uCalm[3];  // up to three boxes kept plain for text: centre xy and half size zw, in tiles, origin bottom left
uniform vec3 uDrops[6]; // where the pointer touched the water (xy, tiles) and how long ago (z, seconds); z < 0 is empty
uniform vec3 uP0, uP1, uP2, uP3, uP4; // the theme's ramp: ground, two middle tones, the strongest, and its warm twin
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
void main() {
  vec2 c = gl_FragCoord.xy;
  // Each touch sends one ring across the water. The ring bends the streaks it passes and fades as it spreads.
  vec2 bend = vec2(0.0);
  float ring = 0.0;
  for (int i = 0; i < 6; i++) {
    vec3 k = uDrops[i];
    if (k.z < 0.0) continue;
    vec2 off = c - k.xy;
    float r = length(off) + 0.001;
    float x = r - k.z * 34.0; // distance from the ring's front, which spreads 34 tiles a second
    float w = exp(-x * x / 36.0) * (1.0 - k.z / 1.4);
    float wave = sin(x * 0.9) * w;
    bend += off / r * wave * 2.5;
    ring += wave;
  }
  vec2 uv = (c + bend) / 112.5; // the field is sized in tiles, so it looks the same on a phone and a monitor
  float t = uTime * 0.06;
  // Wind runs up and to the right; stretch the field along it so the noise becomes streaks.
  float a = 0.55;
  vec2 p = mat2(cos(a), -sin(a), sin(a), cos(a)) * uv;
  p *= vec2(0.9, 3.2);
  vec2 warp = vec2(fbm(p + vec2(t, 0.0)), fbm(p * 1.3 - vec2(0.0, t * 0.7) + 4.1));
  float n = fbm(p * 1.6 + warp * 1.4 + vec2(t * 1.6, 0.0));
  float warm = fbm(p * 0.8 + 9.0 - vec2(t * 0.5, 0.0));
  vec2 s = c / uRes;
  float lift = smoothstep(0.05, 1.1, s.x * 0.8 + s.y * 0.7); // light gathers to the upper right
  // Plain inside each text box and two tiles around it, fading back to the sea over the next five.
  float calm = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 d = max(abs(c - uCalm[i].xy) - uCalm[i].zw, 0.0);
    calm = max(calm, 1.0 - smoothstep(2.0, 7.0, length(d)));
  }
  float v = clamp((smoothstep(0.34, 0.9, n) + ring * 0.12) * (0.3 + 0.9 * lift) * (1.0 - calm), 0.0, 1.0);
  vec3 col = mix(uP0, uP1, smoothstep(0.0, 0.35, v));
  col = mix(col, uP2, smoothstep(0.3, 0.6, v));
  col = mix(col, mix(uP3, uP4, smoothstep(0.55, 0.75, warm)), smoothstep(0.55, 0.95, v));
  gl_FragColor = vec4(col, 1.0);
}`;
const VERT = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";
const CELL = 8; // tile size in CSS pixels
// Dark: the night sea, cobalt, foam and the sand's warmth. Light: paper, the beach's sand, the straw hat's
// ochre, and the lavender of Sorolla's shadows.
const PALETTES = {
  dark: [[0.02, 0.027, 0.055], [0.11, 0.24, 0.56], [0.23, 0.43, 0.84], [0.96, 0.97, 0.99], [0.95, 0.68, 0.36]],
  light: [[0.961, 0.949, 0.925], [0.886, 0.824, 0.706], [0.788, 0.624, 0.384], [0.58, 0.376, 0.102], [0.62, 0.58, 0.76]],
};

const NONE = []; // a stable default, so the effect below doesn't rebuild the shader on every render
export default function SeaShader({ calm = NONE }) {
  const ref = useRef(null);
  const theme = useTheme();
  const tint = useRef(null); // sets the theme's ramp on the running shader
  useEffect(() => {
    const canvas = ref.current;
    const box = canvas.parentElement;
    const gl = canvas.getContext("webgl", { antialias: false });
    if (!gl) return;
    const shader = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n) => gl.getUniformLocation(prog, n);
    const [uRes, uTime, uCalm, uDrops] = ["uRes", "uTime", "uCalm", "uDrops"].map(u);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    // A drop every 230ms at most and a 1.4s life keep it to six rings, so none is cut off early.
    const drops = [];
    const rings = new Float32Array(18);
    const draw = (ms) => {
      const now = performance.now();
      rings.fill(-1);
      drops.forEach((d, i) => { if (now - d.t < 1400) rings.set([d.x, d.y, (now - d.t) / 1000], i * 3); });
      gl.uniform3fv(uDrops, rings);
      gl.uniform1f(uTime, 30 + ms / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!still) frame = requestAnimationFrame(draw);
    };
    const ramp = ["uP0", "uP1", "uP2", "uP3", "uP4"].map(u);
    tint.current = (t) => {
      PALETTES[t].forEach((c, i) => gl.uniform3fv(ramp[i], c));
      if (still) draw(0);
    };
    tint.current(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    const resize = () => {
      const r = box.getBoundingClientRect();
      // Whole tiles only, so each canvas pixel is exactly one CSS tile and lines up with the gaps.
      canvas.width = Math.ceil(r.width / CELL);
      canvas.height = Math.ceil(r.height / CELL);
      canvas.style.width = `${canvas.width * CELL}px`;
      canvas.style.height = `${canvas.height * CELL}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      const boxes = calm.map((ref) => ref.current?.getBoundingClientRect()).filter(Boolean);
      const flat = new Float32Array(12).fill(-1e4); // unused slots sit far off screen
      boxes.slice(0, 3).forEach((e, i) => flat.set([(e.left + e.width / 2 - r.left) / CELL, (r.bottom - e.top - e.height / 2) / CELL, e.width / 2 / CELL, e.height / 2 / CELL], i * 4));
      gl.uniform4fv(uCalm, flat);
      if (still) draw(0);
    };
    const watch = new ResizeObserver(resize);
    watch.observe(box);
    for (const ref of calm) if (ref.current) watch.observe(ref.current);
    const drop = (e) => {
      const r = box.getBoundingClientRect();
      const d = { x: (e.clientX - r.left) / CELL, y: canvas.height - (e.clientY - r.top) / CELL, t: performance.now() };
      const last = drops.at(-1);
      if (e.type === "pointermove" && last && (d.t - last.t < 230 || Math.hypot(d.x - last.x, d.y - last.y) < 3)) return;
      drops.push(d);
      if (drops.length > 6) drops.shift();
    };
    if (!still) {
      frame = requestAnimationFrame(draw);
      box.addEventListener("pointermove", drop);
      box.addEventListener("pointerdown", drop);
    }
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      box.removeEventListener("pointermove", drop);
      box.removeEventListener("pointerdown", drop);
      tint.current = null;
    };
  }, [calm]);
  useEffect(() => tint.current?.(theme), [theme]);
  return (
    <>
      <canvas aria-hidden="true" className="absolute left-0 top-0 -z-10" ref={ref} style={{ imageRendering: "pixelated" }} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10" style={gaps(CELL)} />
    </>
  );
}
