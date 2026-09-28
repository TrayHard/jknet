import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The API every production build talks to. Local modes use their test services. */
const DEFAULT_API = "https://api.jknet.app";
const MODE_APIS: Readonly<Record<string, string>> = {
  development: "http://127.0.0.1:8787",
  e2e: "http://127.0.0.1:8788",
};

const webRoot = fileURLToPath(new URL(".", import.meta.url));

function commit(): string {
  try {
    return execSync("git rev-parse --short=7 HEAD", { cwd: webRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/**
 * The headers of the hosting, with the API of the mode.
 *
 * `vite preview` serves the e2e build under the same Content-Security-Policy
 * the production site sends, so a markup change that needs an inline style or
 * script fails the e2e run instead of the live site.
 */
function headers(api: string): Record<string, string> {
  const origin = new URL(api).origin;
  const socket = origin.replace(/^http/, "ws");
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      `img-src 'self' blob: data: ${origin} https://cdn.discordapp.com https://jkhub.org https://i.ytimg.com`,
      "media-src 'self' blob:",
      `connect-src 'self' ${origin} ${socket}`,
      "frame-src https://www.youtube-nocookie.com",
      "font-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join("; "),
  };
}

/**
 * Writes the build's commit and time next to the Vite manifest, where
 * `build-sw.mjs` and `write-version.mjs` read them: the three steps of one
 * build then agree on its identity.
 */
function buildInfo(info: { commit: string; builtAt: string }): Plugin {
  return {
    name: "jknet-build-info",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: ".vite/build.json", source: JSON.stringify(info) });
    },
  };
}

/**
 * Records which modules went into which output chunk, as paths relative to
 * the repository, in `.vite/modules.json`: `check-bundle.mjs` reads it to
 * refuse a build that pulled in a launcher-only module.
 */
function moduleMap(): Plugin {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/");
  return {
    name: "jknet-module-map",
    apply: "build",
    generateBundle(_options, bundle) {
      const map: Record<string, string[]> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        const ids = output.moduleIds ?? Object.keys(output.modules ?? {});
        map[fileName] = ids.map((id) => {
          const clean = id.replace(/\\/g, "/").replace(/^\0/, "").split("?")[0];
          return clean.startsWith(repo) ? clean.slice(repo.length) : clean;
        });
      }
      this.emitFile({ type: "asset", fileName: ".vite/modules.json", source: JSON.stringify(map) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const api = MODE_APIS[mode] ?? DEFAULT_API;
  const info = { commit: commit(), builtAt: new Date().toISOString() };

  return {
    root: webRoot,
    plugins: [react(), tailwindcss(), buildInfo(info), moduleMap()],
    resolve: {
      alias: { "@app": fileURLToPath(new URL("../src", import.meta.url)) },
    },
    define: {
      __BUILD_COMMIT__: JSON.stringify(info.commit),
      __BUILD_AT__: JSON.stringify(info.builtAt),
      "import.meta.env.VITE_JKNET_API": JSON.stringify(api),
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      manifest: true,
      sourcemap: false,
      // The budget that counts is the gzipped first download, checked by
      // `check-bundle.mjs`; this only quiets the raw-size warning.
      chunkSizeWarningLimit: 800,
      // No `data:` fonts: the page runs under `font-src 'self'`, and a font
      // Vite inlined into the style sheet would be blocked.
      assetsInlineLimit: 0,
    },
    server: {
      host: "127.0.0.1",
      port: 5174,
      strictPort: true,
      fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
    },
    preview: {
      host: "127.0.0.1",
      port: 5175,
      strictPort: true,
      headers: headers(api),
    },
  };
});
