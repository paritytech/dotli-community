// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// dot.li Local chain specifications.
//
// Fresh chain specs fetched as separate static files at runtime.
// Using ?url lets Vite hash them for cache-busting while keeping
// the ~150KB Paseo JSON out of the JS bundle entirely.
//
// Fetches start immediately when the getter is first called,
// running in parallel with smoldot worker initialization.
//
// Paseo Next runs two co-existing testnets (V1 = current "next", V2 =
// newer "next" system chains). The relay is shared between them. The
// system parachains diverge. The active getter routes to the right URL
// based on the user-selected `Network` from `@dotli/config/mode`.
//
// NO silent retry. A rejected fetch is cached as a rejected promise, so
// every subsequent call sees the same failure. Use `resetChainSpecCaches()`
// to opt in to a retry (e.g., from a user-driven "Retry" UI affordance).
// Fetches also explicitly check `r.ok` so a 404/500 HTML body cannot be
// fed to smoldot's chain-spec parser as if it were valid JSON.
//
// To refresh these specs, run:
//   npm run update-chain-specs

import paseoUrl from "./paseo.smol.json?url";
import assetHubPaseoV1Url from "./paseo-asset-hub.smol.json?url";
import assetHubPaseoV2Url from "./paseo-asset-hub-next.smol.json?url";
import bulletinPaseoV1Url from "./paseo-bulletin.smol.json?url";
import bulletinPaseoV2Url from "./paseo-bulletin-next.smol.json?url";
import peoplePaseoV1Url from "./paseo-people-next.smol.json?url";
import peoplePaseoV2Url from "./paseo-people-next-system.smol.json?url";
import previewnetRelayUrl from "./previewnet.smol.json?url";
import assetHubPreviewnetUrl from "./previewnet-asset-hub.smol.json?url";
import bulletinPreviewnetUrl from "./previewnet-bulletin-local.smol.json?url";
import peoplePreviewnetUrl from "./previewnet-people.smol.json?url";
import { m } from "@dotli/metrics/metrics";
import * as S from "@dotli/metrics/spans";
import { SS_RELAY_CHAIN } from "@dotli/config/config";
import { getNetwork, type Network } from "@dotli/config/network";

// Vite glob import: all chain specs (used for the optional custom relay
// override via `SS_RELAY_CHAIN`).
const allChainSpecs = import.meta.glob<string>("./*.json", {
  query: "?url",
  import: "default",
  eager: true,
});

// Paseo-next V1 and V2 share the Paseo relay. Previewnet runs its own Paseo
// Local relay. Exhaustive, so any new network must declare its relay rather
// than silently inheriting Paseo.
function relayUrlFor(network: Network): string {
  switch (network) {
    case "paseo-next-v1":
    case "paseo-next-v2":
      return paseoUrl;
    case "previewnet":
      return previewnetRelayUrl;
  }
}

function assetHubUrlFor(network: Network): string {
  switch (network) {
    case "paseo-next-v1":
      return assetHubPaseoV1Url;
    case "paseo-next-v2":
      return assetHubPaseoV2Url;
    case "previewnet":
      return assetHubPreviewnetUrl;
  }
}

function bulletinUrlFor(network: Network): string {
  switch (network) {
    case "paseo-next-v1":
      return bulletinPaseoV1Url;
    case "paseo-next-v2":
      return bulletinPaseoV2Url;
    case "previewnet":
      return bulletinPreviewnetUrl;
  }
}

function peopleUrlFor(network: Network): string {
  switch (network) {
    case "paseo-next-v1":
      return peoplePaseoV1Url;
    case "paseo-next-v2":
      return peoplePaseoV2Url;
    case "previewnet":
      return peoplePreviewnetUrl;
  }
}

async function fetchChainSpec(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(
      `Chain spec fetch failed: ${String(r.status)} ${r.statusText} (${url})`,
    );
  }
  return r.text();
}

// Cached promises. Rejections are NOT cleared. A failure is sticky until
// `resetChainSpecCaches()` is invoked explicitly. The network selection
// is stable for the lifetime of a page load (switching it triggers a
// wipe and reload), so we don't key these caches by network.
let paseoPromise: Promise<string> | null = null;
let assetHubPromise: Promise<string> | null = null;
let bulletinPaseoPromise: Promise<string> | null = null;
let peopleChainSpecPromise: Promise<string> | null = null;
let customRelayPromise: Promise<string> | null = null;

export function getPaseoChainSpec(): Promise<string> {
  if (paseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_PASEO);
    paseoPromise = fetchChainSpec(relayUrlFor(getNetwork())).then((text) => {
      stop();
      return text;
    });
  }
  return paseoPromise;
}

export function getAssetHubPaseoChainSpec(): Promise<string> {
  if (assetHubPromise === null) {
    const stop = m.timer(S.CHAINSPEC_ASSETHUB);
    assetHubPromise = fetchChainSpec(assetHubUrlFor(getNetwork())).then(
      (text) => {
        stop();
        return text;
      },
    );
  }
  return assetHubPromise;
}

export function getBulletinPaseoChainSpec(): Promise<string> {
  if (bulletinPaseoPromise === null) {
    const stop = m.timer(S.CHAINSPEC_BULLETIN);
    bulletinPaseoPromise = fetchChainSpec(bulletinUrlFor(getNetwork())).then(
      (text) => {
        stop();
        return text;
      },
    );
  }
  return bulletinPaseoPromise;
}

export function getPeopleChainSpec(): Promise<string> {
  peopleChainSpecPromise ??= fetchChainSpec(peopleUrlFor(getNetwork()));
  return peopleChainSpecPromise;
}

export function getCustomRelayChainSpec(): Promise<string> {
  if (customRelayPromise === null) {
    const key = `./${String(SS_RELAY_CHAIN)}.json`;
    const url = allChainSpecs[key];
    if (!url) {
      throw new Error(
        `Unknown relay chain spec "${String(SS_RELAY_CHAIN)}". ` +
          `Available: ${Object.keys(allChainSpecs).join(", ")}`,
      );
    }
    customRelayPromise = fetchChainSpec(url);
  }
  return customRelayPromise;
}
