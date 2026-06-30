// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The Diagnostics panel of the top bar's settings popover: the live rows, the
// per-chain finalized-block lookups, and the "Share diagnostic" report. Split
// out of topbar.ts so the panel is a self-contained unit. It reads the active
// product label as a parameter rather than topbar module state.

import {
  getActiveServicesConfig,
  getNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
} from "@dotli/config/network";
import { getBackend, getCacheSettings } from "@dotli/config/mode";
import {
  formatAppVersion,
  getActiveAppManifest,
  getActiveRootManifest,
} from "@dotli/shared/active-manifest";
import {
  createRemoteChainProvider,
  isRemoteChainSupported,
} from "@dotli/protocol/client";
import { ALL_PERMISSIONS, getPermissionStatus } from "./permissions";
import { appendSectionHeader } from "./topbar-dom";
import {
  backendLabel,
  formatBlock,
  isTruapiDebugEnabled,
  shortSha,
  summarizeUserAgent,
} from "./topbar-format";

// Baked at build time by `apps/host/vite.config.ts` (`define.*`). The
// topbar only ever renders in the host shell so these will always be
// present in practice. `undefined` fallbacks are defensive for tests and
// for any future caller that imports this module from a different bundle.
declare const __DOTLI_VERSION__: string | undefined;
declare const __SMOLDOT_VERSION__: string | undefined;
declare const __SMOLDOT_COMMIT__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__:
  | { name: string; version: string }[]
  | undefined;
declare const __NOVASAMATECH_VERSIONS__:
  | { name: string; version: string }[]
  | undefined;

/**
 * Render the Diagnostics block at the bottom of the settings popover. Rows
 * are static (no click-to-copy). The "Share diagnostic" button at the end
 * exports the whole block at once, so individual-row copy would be noise.
 *
 * Values come from places that are cheap to read synchronously so the
 * popover doesn't pop open with a spinner. "unknown" is a valid value, so
 * don't over-engineer fallbacks.
 *
 * `productLabel` is the active product's label (or null on landing), used to
 * scope the permission rows in the shared report.
 */
export function renderDiagnostics(
  parent: HTMLElement,
  productLabel: string | null,
): void {
  const base = buildBaseDiagnosticsRows();
  const rowHandles = new Map<string, InfoRowHandle>();
  const COPYABLE_ROWS = new Set([
    "Site",
    "Relay node",
    "AssetHub node",
    "Bulletin Node",
  ]);
  for (const entry of base) {
    rowHandles.set(
      entry[0],
      renderInfoRow(parent, entry[0], entry[1], {
        copyable: COPYABLE_ROWS.has(entry[0]),
      }),
    );
  }

  // When running in RPC chain mode, ask the live ws-provider which URI
  // it actually connected to. polkadot-api rotates across the curated
  // candidate list on failure, so the first entry of the config array
  // may not be the node currently answering. Lazy-imported so the
  // resolver bundle (polkadot-api and ws-provider) isn't pulled into the
  // popover's own chunk. By the time the popover opens under RPC mode,
  // `@dotli/resolver/rpc-resolve` is already warm because host main
  // imported it to resolve the name. Both the DOM row and the base
  // snapshot are updated so the Share-diagnostic export stays honest.
  if (getBackend() === "rpc-gateway") {
    void import("@dotli/resolver/rpc-resolve").then(
      ({ getConnectedAssetHubRpcEndpoint }) => {
        const live = getConnectedAssetHubRpcEndpoint();
        if (live === null) {
          return;
        }
        rowHandles.get("AssetHub node")?.update(live);
        const row = base.find((r) => r[0] === "AssetHub node");
        if (row !== undefined) {
          row[1] = live;
        }
      },
    );
  }

  // Version is static and cheap. Block numbers are async so the rows start
  // with an ellipsis placeholder and get swapped in when `chainConnect`
  // rounds-trip back with a finalized-block header. When the user is on
  // the RPC chain backend, smoldot isn't running, so hide the per-chain
  // block rows entirely (the endpoints already appear under Chain) and
  // keep only the smoldot version so the dependency is still visible.
  const smoldotInfo: SmoldotInfo = {
    version: buildSmoldotVersionLabel(),
    blocks: { relay: "…", assetHub: "…", people: "…" },
  };
  const smoldotActive = getBackend() !== "rpc-gateway";
  appendSectionHeader(parent, "@smoldot");
  renderInfoRow(parent, "smoldot", smoldotInfo.version);
  if (smoldotActive) {
    const relayRow = renderInfoRow(parent, "Relay Chain", "…");
    const assetHubRow = renderInfoRow(parent, "Asset Hub", "…");
    const peopleRow = renderInfoRow(parent, "People Chain", "…");

    // Fire all queries. They update their own rows and the shared snapshot
    // (so the "Share diagnostic" button captures whatever resolved in time).
    const cfg = getActiveServicesConfig();
    void queryFinalizedBlock(cfg.relay.genesis).then((n) => {
      const v = formatBlock(n);
      relayRow.update(v);
      smoldotInfo.blocks.relay = v;
    });
    void queryFinalizedBlock(cfg.assethub.genesis).then((n) => {
      const v = formatBlock(n);
      assetHubRow.update(v);
      smoldotInfo.blocks.assetHub = v;
    });
    void queryFinalizedBlock(cfg.people.genesis).then((n) => {
      const v = formatBlock(n);
      peopleRow.update(v);
      smoldotInfo.blocks.people = v;
    });
  } else {
    // Keep the snapshot tagged as n/a so the Share-diagnostic report is
    // coherent: smoldot wasn't consulted, don't claim a block height.
    smoldotInfo.blocks.relay = "n/a";
    smoldotInfo.blocks.assetHub = "n/a";
    smoldotInfo.blocks.people = "n/a";
  }

  // The unscoped `polkadot-api` package lives in the same visual section as
  // `@polkadot-api/*`. Same ecosystem, same release cadence, users expect
  // to see it with its siblings rather than at the top of the popover.
  const polkadotApi: { name: string; version: string }[] = [];
  if (typeof __POLKADOT_API_VERSION__ === "string") {
    polkadotApi.push({
      name: "polkadot-api",
      version: __POLKADOT_API_VERSION__,
    });
  }
  if (typeof __POLKADOT_API_VERSIONS__ !== "undefined") {
    polkadotApi.push(...__POLKADOT_API_VERSIONS__);
  }

  // @novasamatech/* versions move in lockstep, so showing every single
  // package is noise. Keep only the two that are independently meaningful:
  // host-api (the host runtime) and sdk-statement (the statement store
  // client). Everything else in the scope tracks host-api's version.
  const NOVASAMATECH_ALLOWLIST = new Set([
    "@novasamatech/host-api",
    "@novasamatech/sdk-statement",
  ]);
  const novasamatech = (
    typeof __NOVASAMATECH_VERSIONS__ === "undefined"
      ? []
      : __NOVASAMATECH_VERSIONS__
  ).filter((p) => NOVASAMATECH_ALLOWLIST.has(p.name));

  if (polkadotApi.length > 0) {
    appendSectionHeader(parent, "@polkadot-api");
    for (const pkg of polkadotApi) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }
  if (novasamatech.length > 0) {
    appendSectionHeader(parent, "@triangle-sdk");
    for (const pkg of novasamatech) {
      renderInfoRow(parent, pkg.name, pkg.version);
    }
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "mode-cache-row mode-diag-links-row";

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "mode-clear-btn";
  shareBtn.textContent = "Share diagnostic";
  shareBtn.title =
    "Open a new issue on paritytech/dotli pre-filled with these diagnostics";
  shareBtn.addEventListener("click", () => {
    const report = formatDiagnosticsReport(
      base,
      smoldotInfo,
      polkadotApi,
      novasamatech,
      productLabel,
    );
    const body = [
      "<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->",
      "",
      "## Diagnostics",
      "",
      "```",
      report,
      "```",
    ].join("\n");
    const url = new URL("https://github.com/paritytech/dotli/issues/new");
    url.searchParams.set("body", body);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  });

  const debugOn = isTruapiDebugEnabled();
  const debugBtn = document.createElement("button");
  debugBtn.type = "button";
  debugBtn.className = "mode-clear-btn";
  debugBtn.textContent = debugOn ? "Exit debug mode" : "Open in debug mode";
  debugBtn.title = debugOn
    ? "Reload this tab with the TrUAPI debug panel disabled"
    : "Reload this tab with the TrUAPI debug panel enabled (off again on tab close)";
  debugBtn.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("debug", debugOn ? "off" : "true");
    window.location.assign(url.toString());
  });

  actionsRow.appendChild(shareBtn);
  actionsRow.appendChild(debugBtn);
  parent.appendChild(actionsRow);
}

/** Flatten the diagnostics tree into a plain-text block that reads cleanly
 *  both inside a GitHub issue code block and in a Slack message.
 *
 *  Structure (one blank line between sections):
 *    1. Base rows (Site, Build, Chain[, Worker|RPC Node], Content, Browser)
 *    2. Cache: every toggle as on/off. Sourced from persisted settings
 *              so the snapshot matches what's actually live right now.
 *    3. Permissions: per-product, omitted on landing where we don't have
 *                    a scoped label to query.
 *    4. Packages: flat list of smoldot, polkadot-api, and novasamatech. The
 *                 live block heights from the @smoldot popover section
 *                 aren't included here because they're noise in a bug
 *                 report. The popover already shows them live. */
function formatDiagnosticsReport(
  base: [label: string, value: string][],
  smoldot: SmoldotInfo,
  polkadotApi: { name: string; version: string }[],
  novasamatech: { name: string; version: string }[],
  productLabel: string | null,
): string {
  const lines: string[] = [];
  for (const [k, v] of base) {
    lines.push(`${k}: ${v}`);
  }

  // Cache
  const cache = getCacheSettings();
  lines.push(
    "",
    "Cache:",
    `  dotNS cache: ${cache.skipCidCache ? "off" : "on"}`,
    `  Archive cache: ${cache.skipArchiveCache ? "off" : "on"}`,
    `  Worker cache: ${cache.skipWorkerCache ? "off" : "on"}`,
  );

  // Permissions, only when we know which product label to scope against.
  if (productLabel !== null) {
    lines.push("", "Permissions:");
    for (const perm of ALL_PERMISSIONS) {
      const status = getPermissionStatus(productLabel, perm.name);
      lines.push(`  ${perm.label}: ${status === "granted" ? "on" : "off"}`);
    }
  }

  // Packages, one flat list. smoldot leads because it's the heaviest
  // dependency and the one most issues are ultimately about.
  lines.push("", "Packages:", `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  for (const p of novasamatech) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  return lines.join("\n");
}

function buildBaseDiagnosticsRows(): [label: string, value: string][] {
  const version =
    typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : "0.0.0";
  const sha = (import.meta.env.VITE_COMMIT_SHA as string | undefined) ?? "dev";

  const backend = getBackend();
  const network = getNetwork();

  const rows: [string, string][] = [
    // `location.host` includes the port when non-default. Useful on
    // localhost (`hackme3.localhost:5173`), transparent on production
    // (`hackme3.dot.li`).
    ["Site", window.location.host],
    ["Build", `${version} (${shortSha(sha)})`],
    ["Network", NETWORK_NAME_TO_SERVICES_CONFIG[network].label],
    ["Backend", backendLabel(backend)],
  ];

  // Sub-row attached to the Backend row:
  //   - smoldot-shared-worker: "Worker" label and build SHA. The SharedWorker
  //     is a cached script. If it's running an older bundle than the current
  //     page, this SHA diverges from Build, which is the tell-tale for a stale
  //     worker. (Today the Worker ships embedded in the same bundle, so
  //     the two match. The row still lets us spot a divergence in the
  //     field.)
  //   - smoldot-direct: no sub-row. smoldot is torn down every page load.
  //   - rpc-gateway: both WSS endpoints (Relay and Asset Hub). The curated
  //     lists are candidate endpoints. polkadot-api's ws-provider rotates
  //     on failure, so `renderDiagnostics` later replaces the Asset Hub
  //     entry with the one the provider is actually connected to. Relay
  //     isn't dialed at all in rpc mode today (dotNS is Asset Hub only),
  //     so it just shows the first candidate for reference.
  if (backend === "smoldot-shared-worker") {
    if (typeof SharedWorker === "undefined") {
      rows.push(["Worker", "unavailable"]);
    } else {
      rows.push(["Worker", shortSha(sha)]);
    }
  } else if (backend === "rpc-gateway") {
    const cfg = getActiveServicesConfig();
    rows.push(["Relay node", cfg.relay.rpcs[0] ?? "n/a"]);
    rows.push(["AssetHub node", cfg.assethub.rpcs[0] ?? "n/a"]);
    rows.push(["Bulletin Node", cfg.bulletin.rpcs[0] ?? "n/a"]);
  }

  // Product manifest snapshot.
  const root = getActiveRootManifest();
  if (root !== null) {
    rows.push(["Manifest", `v${String(root.schemaVersion)}`]);
  }
  const app = getActiveAppManifest();
  if (app !== null) {
    rows.push(["App version", formatAppVersion(app.appVersion)]);
  }

  rows.push(["Browser", summarizeUserAgent(navigator.userAgent)]);
  return rows;
}

interface SmoldotInfo {
  /** Human-facing version label, e.g. "3.0.0 (c33c647)". */
  version: string;
  /** Mutable block readouts for the share report. */
  blocks: { relay: string; assetHub: string; people: string };
}

function buildSmoldotVersionLabel(): string {
  const smoldot =
    typeof __SMOLDOT_VERSION__ === "string" ? __SMOLDOT_VERSION__ : "unknown";
  // Smoldot's upstream commit is resolved at build time by the host's
  // vite.config against paritytech/smoldot's release tags. Degrades to
  // just `<version>` when the lookup wasn't possible (offline build).
  const commit =
    typeof __SMOLDOT_COMMIT__ === "string" && __SMOLDOT_COMMIT__.length > 0
      ? ` (${shortSha(__SMOLDOT_COMMIT__)})`
      : "";
  return `${smoldot}${commit}`;
}

/**
 * Query the finalized block number for a given chain through the protocol
 * iframe's `chainConnect` bridge. Works across all chain backends:
 *   - smoldot-shared-worker / smoldot-direct: goes through smoldot
 *   - rpc: goes through the curated WSS endpoint
 *
 * Returns `null` if the chain isn't supported by the active backend (e.g.
 * asking for relay in rpc mode, which only supports Asset Hub) or if the
 * query doesn't resolve within the timeout. The heavy `polkadot-api` import
 * stays dynamic so opening the popover is cheap when the user doesn't care
 * about blocks.
 */
async function queryFinalizedBlock(
  genesisHash: string,
): Promise<number | null> {
  try {
    if (!isRemoteChainSupported(genesisHash)) {
      return null;
    }
    const provider = createRemoteChainProvider(genesisHash);
    if (provider === null) {
      return null;
    }
    const papi = await import("polkadot-api");
    const client = papi.createClient(provider);
    try {
      const block = await Promise.race([
        client.getFinalizedBlock(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("timeout"));
          }, 10_000);
        }),
      ]);
      return block.number;
    } finally {
      client.destroy();
    }
  } catch {
    return null;
  }
}

/**
 * Static label/value row used by the Diagnostics block. No click-to-copy.
 * The "Share diagnostic" button at the bottom exports the full report at
 * once, so per-row copy would just be noise.
 *
 * Returns an `update(value)` handle so callers can fill the row later when
 * an async lookup finishes (used by the @smoldot block queries).
 */
interface InfoRowHandle {
  update: (value: string) => void;
}
function renderInfoRow(
  parent: HTMLElement,
  label: string,
  value: string,
  options: { copyable?: boolean } = {},
): InfoRowHandle {
  const row = document.createElement("div");
  row.className = "mode-endpoint-row mode-info-row";
  const labelEl = document.createElement("span");
  labelEl.className = "mode-endpoint-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("code");
  valueEl.className = "mode-endpoint-value";
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  parent.appendChild(row);

  let currentValue = value;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  if (options.copyable === true) {
    row.classList.add("mode-info-row-copyable");
    row.title = `Click to copy ${label}`;
    row.addEventListener("click", () => {
      if (
        currentValue === "" ||
        currentValue === "…" ||
        currentValue === "n/a"
      ) {
        return;
      }
      void navigator.clipboard.writeText(currentValue).then(() => {
        valueEl.textContent = "Copied";
        row.classList.add("copied");
        if (copiedTimer !== undefined) {
          clearTimeout(copiedTimer);
        }
        copiedTimer = setTimeout(() => {
          valueEl.textContent = currentValue;
          row.classList.remove("copied");
          copiedTimer = undefined;
        }, 1000);
      });
    });
  }

  return {
    update: (next) => {
      currentValue = next;
      if (copiedTimer === undefined) {
        valueEl.textContent = next;
      }
    },
  };
}
