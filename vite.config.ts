/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * pdf.js needs a few static resource folders at runtime (CMaps for CJK text, the standard
 * fonts, WASM image decoders, ICC profiles and annotation icons). Copy them from the installed
 * pdfjs-dist package into `public/pdfjs` so they are served in dev and bundled on build.
 * The copy is skipped when the installed version did not change.
 */
function pdfjsAssets(): Plugin {
  const copy = () => {
    const root = resolve(here, "node_modules/pdfjs-dist");
    const out = resolve(here, "public/pdfjs");
    const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version as string;
    const stamp = resolve(out, ".version");
    if (existsSync(stamp) && readFileSync(stamp, "utf8") === version) return;
    mkdirSync(out, { recursive: true });
    for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
      cpSync(resolve(root, dir), resolve(out, dir), { recursive: true });
    }
    cpSync(resolve(root, "web/images"), resolve(out, "images"), { recursive: true });
    writeFileSync(stamp, version);
  };
  return { name: "yapr:pdfjs-assets", buildStart: copy, configureServer: copy };
}

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5175 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 / WKWebView are evergreen; pdf.js relies on modern syntax.
    target: "esnext",
    minify: process.env.TAURI_ENV_DEBUG ? false : true,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
