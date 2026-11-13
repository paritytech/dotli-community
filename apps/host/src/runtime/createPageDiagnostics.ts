// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The diagnostics report: build, transport, permissions, package versions and chain heights.

import { formatAppVersion } from './formatAppVersion.js';
import { getConnectedAssetHubRpcEndpoint } from '@dotli/chains';
import {
  getCacheSettings,
  getBackend,
  BACKEND_FACTS,
  hasLightClient,
  type Backend,
  type CacheSettings,
  getNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  getActiveServicesConfig,
} from '@dotli/config';
import type { DiagnosticsRow, DiagnosticsSource, PackageVersion } from '@dotli/truapi-debug-ui';
import { queryFinalizedBlock } from './createFinalizedBlockQuery.js';
import { pagePermissions } from './pagePermissions.js';
import type { PermissionAuthorizations } from './createPermissionAuthorizations.js';
import { ALL_PERMISSIONS, type PermissionStatus } from './permissionPolicy.js';
import { getDotliVersion } from './getDotliVersion.js';
import { getOperatingSystem } from './getOperatingSystem.js';
import { productState } from './state/productState.js';

// Defined in the host's Astro config, so undefined in tests and other bundles.
declare const __LIGHT_CLIENT_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__: { name: string; version: string }[] | undefined;
declare const __PARITY_TRUAPI_VERSIONS__: { name: string; version: string }[] | undefined;

export type PageDiagnosticsParams = {
  /** The AssetHub node the trusted provider answers on, or null before it connects. */
  connectedAssetHubNode: () => string | null;
  /** The chain's finalized block height, or null when it has none to give. Never rejects. */
  finalizedBlock: (genesisHash: string) => Promise<number | null>;
  /** Opens the issue form at `url`. */
  openIssue: (url: string) => void;
  /** What the browser says about the page now. */
  page: () => DiagnosticsPage;
  /** The product's permission statuses, for the report. Its rejection rejects the report. */
  permissionStatuses: PermissionAuthorizations['getStatuses'];
};

/** What the browser says about the page the report is from. */
type DiagnosticsPage = {
  site: string;
  userAgent: string;
};

/** Each chain's finalized height, as the report prints it. */
type FinalizedBlocks = { relay: string; assetHub: string; people: string };

type FormatDiagnosticsReportParams = {
  /** The rows the panel shows, which open the report. */
  base: readonly DiagnosticsRow[];
  cache: CacheSettings;
  /** The loaded product's status of each permission, in menu order, or null while no product is loaded. */
  statuses: readonly PermissionStatus[] | null;
  lightClientVersion: string;
  packages: ReturnType<typeof getPackageVersions>;
  /** Null on trusted providers, which run no light client to ask. */
  blocks: FinalizedBlocks | null;
};

/**
 * Returns the debug panel's diagnostics over its params. Building it never throws, and its report rejects only when the
 * permission statuses do.
 */
export function createPageDiagnostics({
  connectedAssetHubNode,
  finalizedBlock,
  openIssue,
  page,
  permissionStatuses,
}: PageDiagnosticsParams): DiagnosticsSource {
  return {
    rows(): DiagnosticsRow[] {
      return buildBaseDiagnosticsRows(page(), connectedAssetHubNode);
    },
    lightClientVersion: buildLightClientVersionLabel,
    packages: getPackageVersions,
    async report(rows): Promise<string> {
      // Read before any wait, so a product switch while the chains answer does not change whose permissions are read.
      const product = productState.store.get();
      const [blocks, statuses] = await Promise.all([
        readFinalizedBlocks(finalizedBlock),
        product.status === 'loaded'
          ? permissionStatuses(
              product.label,
              ALL_PERMISSIONS.map(({ name }) => name),
            )
          : null,
      ]);
      return formatDiagnosticsReport({
        base: rows,
        cache: getCacheSettings(),
        statuses,
        lightClientVersion: buildLightClientVersionLabel(),
        packages: getPackageVersions(),
        blocks,
      });
    },
    openIssue,
  };
}

/** The page's diagnostics, over the host's chains and the trusted provider's live node. */
export const pageDiagnostics: DiagnosticsSource = createPageDiagnostics({
  connectedAssetHubNode: getConnectedAssetHubRpcEndpoint,
  finalizedBlock: queryFinalizedBlock,
  openIssue: url => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  page: readBrowserPage,
  permissionStatuses: pagePermissions.getStatuses,
});

/** Plain text that reads cleanly in a GitHub issue code block and in a Slack message. */
function formatDiagnosticsReport({
  base,
  cache,
  statuses,
  lightClientVersion,
  packages,
  blocks,
}: FormatDiagnosticsReportParams): string {
  const lines: string[] = [];
  for (const [label, value] of base) {
    lines.push(`${label}: ${value}`);
  }

  lines.push(
    '',
    'Cache:',
    `  dotNS cache: ${cache.skipCidCache ? 'off' : 'on'}`,
    `  Archive cache: ${cache.skipArchiveCache ? 'off' : 'on'}`,
    `  Worker cache: ${cache.skipWorkerCache ? 'off' : 'on'}`,
  );

  if (statuses !== null) {
    lines.push('', 'Permissions:');
    for (const [index, permission] of ALL_PERMISSIONS.entries()) {
      lines.push(`  ${permission.label}: ${statuses[index] === 'granted' ? 'on' : 'off'}`);
    }
  }

  // smoldot leads because most issues are ultimately about it.
  lines.push('', 'Packages:', `  smoldot: ${lightClientVersion}`);
  for (const { name, version } of [...packages.polkadotApi, ...packages.parityTruapi]) {
    lines.push(`  ${name}: ${version}`);
  }
  if (blocks !== null) {
    lines.push(
      '',
      'Finalized:',
      `  Relay: ${blocks.relay}`,
      `  Asset Hub: ${blocks.assetHub}`,
      `  People: ${blocks.people}`,
    );
  }
  return lines.join('\n');
}

function readBrowserPage(): DiagnosticsPage {
  return { site: window.location.host, userAgent: navigator.userAgent };
}

/** A row worth pasting elsewhere, unless it holds no value yet. */
function toCopyableRow(label: string, value: string): DiagnosticsRow {
  return value === '' || value === 'n/a' ? [label, value] : [label, value, true];
}

function buildBaseDiagnosticsRows(
  page: DiagnosticsPage,
  connectedAssetHubNode: PageDiagnosticsParams['connectedAssetHubNode'],
): DiagnosticsRow[] {
  const sha = (import.meta.env.VITE_COMMIT_SHA ?? 'dev').slice(0, 7);
  const backend = getBackend();

  const rows: DiagnosticsRow[] = [
    toCopyableRow('Site', page.site),
    ['Build', `${getDotliVersion()} (${sha})`],
    ['Network', NETWORK_NAME_TO_SERVICES_CONFIG[getNetwork()].label],
    ['Transport', BACKEND_FACTS[backend].label],
    ...buildTransportRows(backend, sha, connectedAssetHubNode),
  ];

  const product = productState.store.get();
  if (product.status === 'loaded') {
    const { manifestVersion, appVersion } = product.facts;
    if (manifestVersion !== undefined) {
      rows.push(['Manifest', `v${String(manifestVersion)}`]);
    }
    if (appVersion !== undefined) {
      rows.push(['App version', formatAppVersion(appVersion)]);
    }
  }

  rows.push(['Browser', summarizeUserAgent(page.userAgent)]);
  return rows;
}

/**
 * The rows that tell how the transport runs. A Worker SHA that diverges from Build is the tell-tale of a stale cached
 * SharedWorker. RPC rows show the first candidate, except AssetHub's, which names the node the client is connected to
 * once it is.
 */
function buildTransportRows(
  backend: Backend,
  sha: string,
  connectedAssetHubNode: PageDiagnosticsParams['connectedAssetHubNode'],
): DiagnosticsRow[] {
  switch (backend) {
    case 'smoldot-direct':
      return [];
    case 'smoldot-shared-worker':
      return [['Worker', typeof SharedWorker === 'undefined' ? 'unavailable' : sha]];
    case 'rpc-gateway': {
      const servicesConfig = getActiveServicesConfig();
      // polkadot-api rotates nodes on failure, so ask the live transport which one answers.
      const assetHubNode = connectedAssetHubNode() ?? servicesConfig.assethub.rpcs[0] ?? 'n/a';
      return [
        toCopyableRow('Relay node', servicesConfig.relay.rpcs[0] ?? 'n/a'),
        toCopyableRow('AssetHub node', assetHubNode),
        toCopyableRow('Bulletin Node', servicesConfig.bulletin.rpcs[0] ?? 'n/a'),
      ];
    }
  }
}

/** Each chain's finalized height, or null on trusted providers, which run no light client to ask. */
async function readFinalizedBlocks(
  finalizedBlock: PageDiagnosticsParams['finalizedBlock'],
): Promise<FinalizedBlocks | null> {
  if (!hasLightClient(getBackend())) {
    return null;
  }
  const servicesConfig = getActiveServicesConfig();
  const [relay, assetHub, people] = await Promise.all([
    finalizedBlock(servicesConfig.relay.genesis),
    finalizedBlock(servicesConfig.assethub.genesis),
    finalizedBlock(servicesConfig.people.genesis),
  ]);
  return { relay: formatBlock(relay), assetHub: formatBlock(assetHub), people: formatBlock(people) };
}

// smoldot is compiled into truapi-provider's wasm, so the provider version identifies the build.
function buildLightClientVersionLabel(): string {
  return typeof __LIGHT_CLIENT_VERSION__ === 'string' ? __LIGHT_CLIENT_VERSION__ : 'unknown';
}

function formatBlock(blockNumber: number | null): string {
  return blockNumber === null ? 'n/a' : `#${blockNumber.toLocaleString('en-US')}`;
}

/** A heuristic like "Chrome 147 (macOS)", not a real UA parser. */
function summarizeUserAgent(userAgent: string): string {
  let browser = 'Unknown';
  const chromeVersion = /(Chrome|CriOS)\/(\d+)/.exec(userAgent)?.[2];
  const firefoxVersion = /Firefox\/(\d+)/.exec(userAgent)?.[1];
  const safariVersion = /Version\/(\d+)[^)]+Safari/.exec(userAgent)?.[1];
  const edgeVersion = /Edg\/(\d+)/.exec(userAgent)?.[1];
  if (edgeVersion !== undefined) {
    browser = `Edge ${edgeVersion}`;
  } else if (firefoxVersion !== undefined) {
    browser = `Firefox ${firefoxVersion}`;
  } else if (chromeVersion !== undefined) {
    browser = `Chrome ${chromeVersion}`;
  } else if (safariVersion !== undefined) {
    browser = `Safari ${safariVersion}`;
  }
  return `${browser} (${getOperatingSystem(userAgent)})`;
}

/** The unscoped `polkadot-api` package is listed with its `@polkadot-api/*` siblings. */
function getPackageVersions(): {
  polkadotApi: PackageVersion[];
  parityTruapi: PackageVersion[];
} {
  const polkadotApi: PackageVersion[] = [];
  if (typeof __POLKADOT_API_VERSION__ === 'string') {
    polkadotApi.push({
      name: 'polkadot-api',
      version: __POLKADOT_API_VERSION__,
    });
  }
  if (typeof __POLKADOT_API_VERSIONS__ !== 'undefined') {
    polkadotApi.push(...__POLKADOT_API_VERSIONS__);
  }
  const parityTruapi = typeof __PARITY_TRUAPI_VERSIONS__ === 'undefined' ? [] : __PARITY_TRUAPI_VERSIONS__;
  return { polkadotApi, parityTruapi };
}
