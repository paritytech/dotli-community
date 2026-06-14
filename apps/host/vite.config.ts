// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import wasm from "vite-plugin-wasm";
import { VitePWA } from "vite-plugin-pwa";
import { prodNoAnalyticsAliases } from "../../packages/metrics/src/prod-no-analytics-aliases";

// Local builds don't get `VITE_COMMIT_SHA` injected by CI. Fall back to the
// git HEAD so Diagnostics shows a real commit identifier in dev too. The
// literal "dev" is only used when we're not in a git checkout at all (e.g. a
// tarball).
if (!process.env.VITE_COMMIT_SHA) {
  try {
    process.env.VITE_COMMIT_SHA = execSync("git rev-parse HEAD", {
      cwd: import.meta.dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    // Not a git checkout, so leave it unset. topbar.ts treats that as "dev".
  }
}

const OUT_DIR = "dist";

/**
 * Walk every workspace member's `package.json` and collect its direct
 * `dependencies` entries. devDependencies and peerDependencies are ignored, so
 * only what dot.li code actually imports appears in Diagnostics. Returns a map
 * keyed by package name whose value is the set of workspace directories that
 * depend on it.
 */
function collectWorkspaceDependencies(): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  const roots = [
    resolve(import.meta.dirname, "../../apps"),
    resolve(import.meta.dirname, "../../packages"),
  ];
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const wsDir = resolve(root, dir);
      let pkg: { dependencies?: Record<string, string> };
      try {
        pkg = JSON.parse(
          readFileSync(resolve(wsDir, "package.json"), "utf8"),
        ) as { dependencies?: Record<string, string> };
      } catch {
        continue;
      }
      for (const depName of Object.keys(pkg.dependencies ?? {})) {
        let set = deps.get(depName);
        if (!set) {
          set = new Set<string>();
          deps.set(depName, set);
        }
        set.add(wsDir);
      }
    }
  }
  return deps;
}

/**
 * For every direct dependency whose name starts with `scope`, resolve the
 * actually-installed version via the depending workspace's own
 * `node_modules/<name>/package.json`. Ignores transitive dependencies, which
 * would otherwise balloon the version list to 80+ rows.
 */
function collectDirectScopedDeps(
  scope: string,
): { name: string; version: string }[] {
  const wsDeps = collectWorkspaceDependencies();
  const result = new Map<string, string>();
  for (const [name, usedBy] of wsDeps) {
    if (!name.startsWith(scope)) {
      continue;
    }
    for (const wsDir of usedBy) {
      try {
        const depPkg = JSON.parse(
          readFileSync(
            resolve(wsDir, "node_modules", name, "package.json"),
            "utf8",
          ),
        ) as { version?: string };
        if (depPkg.version) {
          result.set(name, depPkg.version);
          break;
        }
      } catch {
        // Not hoisted into this workspace's node_modules, so try the next one.
      }
    }
  }
  return [...result]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, version]) => ({ name, version }));
}

function readSmoldotVersion(): string {
  const direct = collectDirectScopedDeps("smoldot");
  return direct.find((p) => p.name === "smoldot")?.version ?? "unknown";
}

function readPolkadotApiVersion(): string {
  const direct = collectDirectScopedDeps("polkadot-api");
  return direct.find((p) => p.name === "polkadot-api")?.version ?? "unknown";
}

function readHostVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Look up the paritytech/smoldot commit SHA for the npm-published `smoldot`
 * version we bundle. Smoldot's git repo tags its JS releases with the
 * `light-js-deno-v<version>` prefix, and the JS binding's published version
 * tracks that tag directly, so the commit behind `light-js-deno-v3.0.0` is the
 * commit that produced `smoldot@3.0.0` on npm.
 *
 * Neither `bun.lock` nor smoldot's package.json carries a commit. The
 * lockfile only stores the tarball integrity hash, so the GitHub API is
 * the only build-time source of truth. Failures are silent: if the build
 * host can't reach github.com (offline dev, locked-down CI), the
 * Diagnostics row degrades to just `<version>` instead of `<version>
 * (sha)` rather than failing the build.
 */
async function resolveSmoldotCommit(version: string): Promise<string> {
  if (version === "" || version === "unknown") {
    return "";
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(
      `https://api.github.com/repos/paritytech/smoldot/git/refs/tags/light-js-deno-v${version}`,
      {
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    clearTimeout(timer);
    if (!res.ok) {
      return "";
    }
    const data = (await res.json()) as { object?: { sha?: string } };
    return data.object?.sha ?? "";
  } catch {
    return "";
  }
}

const SMOLDOT_COMMIT = await resolveSmoldotCommit(readSmoldotVersion());

/**
 * Extract unique WSS bootnode hostnames from a chain spec JSON file.
 */
function extractBootnodeHosts(specPath: string): string[] {
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as {
      bootNodes?: string[];
    };
    const hosts = new Set<string>();
    for (const bn of spec.bootNodes ?? []) {
      if (bn.includes("/wss/") || bn.includes("/tls/ws/")) {
        const match = /\/dns[46]?\/([^/]+)/.exec(bn);
        if (match?.[1]) hosts.add(match[1]);
      }
    }
    return [...hosts];
  } catch {
    return [];
  }
}

/**
 * Vite plugin that injects <link rel="preconnect"> for smoldot relay chain
 * and Asset Hub bootnode hostnames.
 */
function preconnectBootnodes(): Plugin {
  return {
    name: "preconnect-bootnodes",
    transformIndexHtml(html) {
      const specDir = resolve(
        import.meta.dirname,
        "../../packages/resolver/src/chain-specs",
      );
      const hosts = [
        ...extractBootnodeHosts(resolve(specDir, "paseo.smol.json")),
        ...extractBootnodeHosts(resolve(specDir, "paseo-asset-hub.smol.json")),
      ];
      const unique = [...new Set(hosts)];
      const links = unique
        .map(
          (host) =>
            `<link rel="preconnect" href="https://${host}" crossorigin />`,
        )
        .join("\n    ");
      return html.replace("</head>", `    ${links}\n  </head>`);
    },
  };
}

/**
 * Vite plugin that injects conditional <link rel="modulepreload"> for
 * critical chunks on subdomain pages.
 */
function preloadCriticalAssets(): Plugin {
  let resolvedBase = "/";
  return {
    name: "preload-critical-assets",
    configResolved(config) {
      resolvedBase = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];

        const bundleKeys = Object.keys(ctx.bundle);
        const findChunk = (pattern: RegExp) =>
          bundleKeys.find((name) => pattern.test(name));

        const resolveChunk = findChunk(/^assets\/resolve-.*\.js$/);
        const fetchChunk = findChunk(/^assets\/fetch-.*\.js$/);
        const renderChunk = findChunk(/^assets\/render-.*\.js$/);
        const wasmAsset = findChunk(/^assets\/.*\.wasm$/);
        const metadataAsset = findChunk(/^assets\/ah-.*\.scale$/);

        const chunks = [resolveChunk, fetchChunk, renderChunk].filter(Boolean);
        if (chunks.length === 0) return [];

        const b = resolvedBase;

        const fetchPreloads = [wasmAsset, metadataAsset]
          .filter(Boolean)
          .map(
            (a) =>
              `l=document.createElement("link");l.rel="preload";l.as="fetch";l.crossOrigin="anonymous";l.href="${b}${a}";document.head.appendChild(l);`,
          )
          .join("");

        const preloadStatements = chunks
          .map(
            (c) =>
              `l=document.createElement("link");l.rel="modulepreload";l.href="${b}${c}";document.head.appendChild(l);`,
          )
          .join("");
        const script = [
          "(function(){",
          "var h=location.hostname,l;",
          'if(h==="dot.li"||h==="localhost")return;',
          'if(!h.endsWith(".dot.li")&&!h.endsWith(".localhost"))return;',
          fetchPreloads,
          preloadStatements,
          "})()",
        ].join("");

        return [
          {
            tag: "script",
            children: script,
            injectTo: "head",
          },
        ];
      },
    },
  };
}

/**
 * Mirror nginx scoping: COEP/COOP/CORP only apply to /__preview, not the
 * whole host build. Applying them server-wide breaks the legacy
 * /localhost:<port> proxy iframe in browsers that enforce COEP, because
 * arbitrary localhost dev servers don't ship CORP/COEP.
 */
function previewCoepHeaders(): Plugin {
  return {
    name: "preview-coep-headers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/__preview")) {
          res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        }
        next();
      });
    },
  };
}

/**
 * Sentry sourcemap upload. Skipped on prod (runtime SDK is aliased to a
 * no-op, nothing to attribute) and locally without SENTRY_AUTH_TOKEN
 * (preserves source maps for debugging).
 */
function sentry(): Plugin | false {
  if (process.env.VITE_APP_ENV === "production") return false;
  if (!process.env.SENTRY_AUTH_TOKEN) return false;
  return sentryVitePlugin({
    org: "paritytech",
    project: "dotli",
    telemetry: false,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: { name: process.env.VITE_COMMIT_SHA },
    sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
  });
}

const PACKAGES = resolve(import.meta.dirname, "../../packages");
const SANDBOX_CHECKER_SRC = resolve(PACKAGES, "sandbox-checker/src");

export default defineConfig({
  envDir: resolve(import.meta.dirname, "../.."),
  base: process.env.VITE_APP_URL
    ? new URL(process.env.VITE_APP_URL).pathname
    : "/",
  plugins: [
    wasm(),
    preconnectBootnodes(),
    preloadCriticalAssets(),
    previewCoepHeaders(),
    sentry(),
    // Host shell PWA. Scope-locked to the host origin (myapp.dot.li). The
    // protocol iframe on host.dot.li and the app iframe on *.app.dot.li are
    // cross-origin and outside this SW's reach by design. Smoldot.wasm lives
    // in the protocol build; browser HTTP cache (immutable, hashed filename)
    // already prevents redownload on revisit, so the precache list excludes
    // wasm entirely. `registerType: "prompt"` defers update activation to
    // the user via workbox-window in src/pwa.ts.
    VitePWA({
      injectRegister: false,
      registerType: "prompt",
      filename: "host-sw.js",
      manifest: {
        name: "Polkadot Web",
        short_name: "Polkadot Web",
        description: "Decentralized web browser for Polkadot",
        theme_color: "#000000",
        background_color: "#000000",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        cleanupOutdatedCaches: true,
        // skipWaiting/clientsClaim stay false: prompt-style updates require
        // the waiting SW to sit idle until the user opts in.
        skipWaiting: false,
        clientsClaim: false,
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Bypass the SW for /__preview so nginx's COEP/COOP/CORP headers
        // reach the browser.
        navigateFallbackDenylist: [/^\/__preview(\?|$|\/)/],
      },
    }),
  ],
  resolve: {
    alias: {
      ...prodNoAnalyticsAliases(process.env.VITE_APP_ENV === "production"),
      "@dotli/config": resolve(PACKAGES, "config/src"),
      "@dotli/metrics": resolve(PACKAGES, "metrics/src"),
      "@dotli/shared": resolve(PACKAGES, "shared/src"),
      "@dotli/storage": resolve(PACKAGES, "storage/src"),
      "@dotli/resolver": resolve(PACKAGES, "resolver/src"),
      "@dotli/protocol": resolve(PACKAGES, "protocol/src"),
      "@dotli/content": resolve(PACKAGES, "content/src"),
      "@dotli/auth": resolve(PACKAGES, "auth/src"),
      "@dotli/ui": resolve(PACKAGES, "ui/src"),
      "@dotli/sandbox-checker": SANDBOX_CHECKER_SRC,
    },
  },
  define: {
    __BUILD_TARGET__: JSON.stringify("host"),
    // Baked once at build time, read lazily at the declaration site so a
    // missing package (shouldn't happen given the monorepo overrides)
    // falls back to empty/"unknown" rather than failing the build.
    __DOTLI_VERSION__: JSON.stringify(readHostVersion()),
    __SMOLDOT_VERSION__: JSON.stringify(readSmoldotVersion()),
    __SMOLDOT_COMMIT__: JSON.stringify(SMOLDOT_COMMIT),
    __POLKADOT_API_VERSION__: JSON.stringify(readPolkadotApiVersion()),
    __POLKADOT_API_VERSIONS__: JSON.stringify(
      collectDirectScopedDeps("@polkadot-api/"),
    ),
    __NOVASAMATECH_VERSIONS__: JSON.stringify(
      collectDirectScopedDeps("@novasamatech/"),
    ),
  },
  optimizeDeps: {
    exclude: ["@polkadot-api/wasm-executor"],
  },
  build: {
    target: "esnext",
    modulePreload: { polyfill: false },
    outDir: OUT_DIR,
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@novasamatech/scale")) {
            return "nova-scale";
          }
        },
      },
    },
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
      "Access-Control-Allow-Origin": "*",
    },
  },
});
