import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The chain's REST API sends no CORS headers, so the page reads it through a same-origin /rest path.
// The hosted site serves the same path from its own proxy.
const rest = {
  "/rest": {
    target: "https://api-testnet.qore.host",
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/rest/, ""),
  },
  "/api": { target: "http://localhost:8787" }, // the guest server (server/guest.mjs) when run locally
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { proxy: rest },
  preview: { proxy: rest },
});
