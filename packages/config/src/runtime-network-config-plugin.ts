// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Build-time plugin: inject the runtime network config script, but only into
// builds that opt in.
//
// The overridable fields are endpoints only — never `genesis` or `dotns`, see
// network.ts — so the blast radius of this hook is small by construction. The
// hosted deployments still have no use for it, so they do not carry it at all:
// injecting on opt-in rather than stripping on opt-out means a default build's
// HTML is byte-identical to one from before runtime config existed. The reader
// side is gated separately in network.ts, so neither half alone enables it.
//
// Import from the three vite configs, alongside `prodNoAnalyticsAliases`.

import type { Plugin } from "vite";

/** Path nginx serves from the container's generated config. */
const SCRIPT_SRC = "/dotli-network.js";

/**
 * The script body, from `$DOTLI_NETWORK` — the same variable the container
 * entrypoint reads, so a local run and a container run are configured
 * identically. Empty/unset means no overrides, i.e. the built-in networks.
 *
 * Exported so `scripts/preview-server.ts` serves the same bytes as the dev
 * servers. Something must serve this path: without it the injected tag hits
 * whatever the server does with an unknown path, and an SPA fallback answers 200
 * with HTML that the browser then tries to execute as JavaScript.
 */
export function runtimeNetworkConfigScriptBody(): string {
  const raw = process.env.DOTLI_NETWORK?.trim();
  const config = raw === undefined || raw === "" ? "{}" : raw;
  // Parsed only to fail early on a typo; the original text is what gets served.
  try {
    JSON.parse(config);
  } catch (err) {
    throw new Error("DOTLI_NETWORK is not valid JSON", { cause: err });
  }
  return `window.__DOTLI_NETWORK__ = ${config};\n`;
}

/**
 * Injects `<script src="/dotli-network.js">` at the top of <head> when
 * `VITE_RUNTIME_NETWORK_CONFIG === "true"`, and does nothing otherwise.
 *
 * Blocking and classic on purpose. It must set the global before the deferred
 * module bundle runs so every reader in `@dotli/config/network` can stay
 * synchronous — the same trick the apps already use to pre-open IndexedDB.
 */
export function runtimeNetworkConfigScript(): Plugin {
  const enabled = process.env.VITE_RUNTIME_NETWORK_CONFIG === "true";
  return {
    name: "dotli-runtime-network-config",
    transformIndexHtml() {
      if (!enabled) {
        return [];
      }
      return [
        {
          tag: "script",
          attrs: { src: SCRIPT_SRC },
          injectTo: "head-prepend" as const,
        },
      ];
    },
    // nginx serves this path in the container; under `vite dev` nothing would, so
    // the injected tag would 404 and the global would never be set. Serving it
    // here is what makes runtime config testable without building an image.
    configureServer(server) {
      if (!enabled) {
        return;
      }
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== SCRIPT_SRC) {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(runtimeNetworkConfigScriptBody());
      });
    },
  };
}
