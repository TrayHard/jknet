import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Writes the build's commit, time and mode next to the Vite manifest, where
 * `build-sw.mjs` and `write-version.mjs` read them: the three steps of one
 * build then agree on its identity, and the worker of the e2e build knows
 * it is one.
 */
function buildInfo(info: { commit: string; builtAt: string; mode: string }): Plugin {
  return {
    name: "jknet-build-info",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: ".vite/build.json", source: JSON.stringify(info) });
    },
  };
}

/**
 * The launcher's editors and 3D previews, stood in for by empty components
 * in the web build.
 *
 * Shared chat cards and bundle views reach them by static imports: **Apply**
 * of a config card opens the config editor (CodeMirror), **Save as profile**
 * of a profile card the skin preview (three.js), **Contents** and **Edit**
 * of a bundle file the file preview and the pk3 editor. On the web those
 * buttons are hidden or disabled by the platform's capabilities, so the
 * editors never render; this keeps their libraries out of every chunk,
 * which `check-bundle.mjs` requires. The launcher's build is untouched.
 */
const LAUNCHER_ONLY: Record<string, string> = {
  "src/components/ConfigCodeEditor.tsx": "web/src/stubs/ConfigCodeEditor.tsx",
  "src/components/ModelPreview.tsx": "web/src/stubs/ModelPreview.tsx",
  "src/components/library/FilePreviewDialog.tsx": "web/src/stubs/FilePreviewDialog.tsx",
  "src/components/pk3/Pk3EditorDialog.tsx": "web/src/stubs/Pk3EditorDialog.tsx",
};

function launcherOnly(): Plugin {
  const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/");
  return {
    name: "jknet-launcher-only",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (importer === undefined || !source.startsWith(".")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) return null;
      const path = resolved.id.replace(/\\/g, "/").split("?")[0];
      const relative = path.startsWith(repo) ? path.slice(repo.length) : null;
      const stub = relative === null ? undefined : LAUNCHER_ONLY[relative];
      return stub === undefined ? null : `${repo}${stub}`;
    },
  };
}

/**
 * The chat sounds of the launcher, `src-tauri/resources/sounds/<set>/<kind>.wav`,
 * copied to `web/public/sounds/<set>-<kind>.wav` before every build and dev
 * server start, so the web app plays the very files the launcher does and
 * the service worker caches them with the shell. A copy that already holds
 * the same bytes is left alone.
 */
function chatSounds(): Plugin {
  const source = fileURLToPath(new URL("../src-tauri/resources/sounds", import.meta.url));
  const target = fileURLToPath(new URL("./public/sounds", import.meta.url));
  const copy = () => {
    mkdirSync(target, { recursive: true });
    for (const set of readdirSync(source, { withFileTypes: true })) {
      if (!set.isDirectory()) continue;
      for (const file of readdirSync(join(source, set.name))) {
        if (!file.endsWith(".wav")) continue;
        const bytes = readFileSync(join(source, set.name, file));
        const to = join(target, `${set.name}-${file}`);
        if (existsSync(to) && readFileSync(to).equals(bytes)) continue;
        writeFileSync(to, bytes);
      }
    }
  };
  return { name: "jknet-chat-sounds", buildStart: copy };
}

/**
 * The engine marks of the launcher, `public/brand/engines/<engineId>.png`,
 * copied to `web/public/brand/engines/` the same way: `EngineLogo` asks for
 * them by that path on the bundle screens, and without them every card falls
 * back to the engine's initials.
 */
function engineIcons(): Plugin {
  const source = fileURLToPath(new URL("../public/brand/engines", import.meta.url));
  const target = fileURLToPath(new URL("./public/brand/engines", import.meta.url));
  const copy = () => {
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(source)) {
      if (!file.endsWith(".png")) continue;
      const bytes = readFileSync(join(source, file));
      const to = join(target, file);
      if (existsSync(to) && readFileSync(to).equals(bytes)) continue;
      writeFileSync(to, bytes);
    }
  };
  return { name: "jknet-engine-icons", buildStart: copy };
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
  const info = { commit: commit(), builtAt: new Date().toISOString(), mode };

  return {
    root: webRoot,
    plugins: [launcherOnly(), chatSounds(), engineIcons(), react(), tailwindcss(), buildInfo(info), moduleMap()],
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
