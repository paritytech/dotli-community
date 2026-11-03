// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The diagnostics report: build, transport, permissions, package versions and chain heights.

import { formatAppVersion } from './formatAppVersion.js';
import { getConnectedAssetHubRpcEndpoint } from '@dotli/chains';
import {
  getCacheSettings,
  getBackend,
  BACKEND_LABELS,
  type Backend,
  getNetwork,
  NETWORK_NAME_TO_SERVICES_CONFIG,
  getActiveServicesConfig,
} from '@dotli/config';
import type { DiagnosticsRow, DiagnosticsSource, PackageVersion } from '@dotli/truapi-debug-ui';
import { queryFinalizedBlock } from './createFinalizedBlockQuery.js';
import { pagePermissions } from './pagePermissions.js';
import type { PermissionAuthorizations } from './createPermissionAuthorizations.js';
import { ALL_PERMISSIONS } from './permissionPolicy.js';
import { getDotliVersion } from './createTruapiRuntimeConfig.js';
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
  /** The product's permission statuses, for the report. */
  permissionStatuses: PermissionAuthorizations['getStatuses'];
};

/** What the browser says about the page the report is from. */
export type DiagnosticsPage = {
  site: string;
  userAgent: string;
};

export type SmoldotInfo = {
  version: string;
  /** Null on trusted providers, which run no light client to ask. */
  blocks: { relay: string; assetHub: string; people: string } | null;
};

type FormatDiagnosticsReportParams = {
  /** The rows the panel shows, which open the report. */
  base: readonly DiagnosticsRow[];
  smoldot: SmoldotInfo;
  polkadotApi: { name: string; version: string }[];
  parityTruapi: { name: string; version: string }[];
  /** The product's permission statuses. */
  permissionStatuses: PermissionAuthorizations['getStatuses'];
};

type BuildBaseDiagnosticsRowsParams = {
  /** What the browser says about the page. The page's own by default. */
  page?: DiagnosticsPage;
};

/** Returns the debug panel's diagnostics over its params. Never throws. */
export function createPageDiagnostics({
  connectedAssetHubNode,
  finalizedBlock,
  openIssue,
  page,
  permissionStatuses,
}: PageDiagnosticsParams): DiagnosticsSource {
  return {
    rows(): DiagnosticsRow[] {
      const rows = buildBaseDiagnosticsRows({ page: page() });
      // polkadot-api rotates nodes on failure, so ask the live transport which one answers.
      const node = getBackend() === 'rpc-gateway' ? connectedAssetHubNode() : null;
      const assetHub = rows.find(([label]) => label === 'AssetHub node');
      if (node !== null && assetHub !== undefined) {
        assetHub[1] = node;
        assetHub[2] = true;
      }
      return rows;
    },
    lightClientVersion: buildLightClientVersionLabel,
    packages: getPackageVersions,
    async report(rows): Promise<string> {
      const { polkadotApi, parityTruapi } = getPackageVersions();
      return formatDiagnosticsReport({
        base: rows,
        smoldot: await collectSmoldotInfo(finalizedBlock),
        polkadotApi,
        parityTruapi,
        permissionStatuses,
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
  permissionStatuses: (label, names) => pagePermissions.getStatuses(label, names),
});

/** Plain text that reads cleanly in a GitHub issue code block and in a Slack message. */
async function formatDiagnosticsReport({
  base,
  smoldot,
  polkadotApi,
  parityTruapi,
  permissionStatuses,
}: FormatDiagnosticsReportParams): Promise<string> {
  const lines: string[] = [];
  for (const [label, value] of base) {
    lines.push(`${label}: ${value}`);
  }

  const cache = getCacheSettings();
  lines.push(
    '',
    'Cache:',
    `  dotNS cache: ${cache.skipCidCache ? 'off' : 'on'}`,
    `  Archive cache: ${cache.skipArchiveCache ? 'off' : 'on'}`,
    `  Worker cache: ${cache.skipWorkerCache ? 'off' : 'on'}`,
  );

  const product = productState.store.get();
  if (product.status === 'loaded') {
    const productLabel = product.label;
    lines.push('', 'Permissions:');
    const statuses = await permissionStatuses(
      productLabel,
      ALL_PERMISSIONS.map(({ name }) => name),
    );
    for (const [index, permission] of ALL_PERMISSIONS.entries()) {
      const status = statuses[index] ?? 'ask';
      lines.push(`  ${permission.label}: ${status === 'granted' ? 'on' : 'off'}`);
    }
  }

  // smoldot leads because most issues are ultimately about it.
  lines.push('', 'Packages:', `  smoldot: ${smoldot.version}`);
  for (const { name, version } of polkadotApi) {
    lines.push(`  ${name}: ${version}`);
  }
  for (const { name, version } of parityTruapi) {
    lines.push(`  ${name}: ${version}`);
  }
  if (smoldot.blocks !== null) {
    lines.push(
      '',
      'Finalized:',
      `  Relay: ${smoldot.blocks.relay}`,
      `  Asset Hub: ${smoldot.blocks.assetHub}`,
      `  People: ${smoldot.blocks.people}`,
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

function buildBaseDiagnosticsRows({ page = readBrowserPage() }: BuildBaseDiagnosticsRowsParams = {}): DiagnosticsRow[] {
  const sha = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

  const backend = getBackend();
  const network = getNetwork();

  const rows: DiagnosticsRow[] = [
    toCopyableRow('Site', page.site),
    ['Build', `${getDotliVersion()} (${shortenSha(sha)})`],
    ['Network', NETWORK_NAME_TO_SERVICES_CONFIG[network].label],
    ['Transport', getBackendLabel(backend)],
    ...buildTransportRows(backend, sha),
  ];

  const product = productState.store.get();
  if (product.status === 'loaded' && product.manifestVersion !== undefined) {
    rows.push(['Manifest', `v${String(product.manifestVersion)}`]);
  }
  if (product.status === 'loaded' && product.appVersion !== undefined) {
    rows.push(['App version', formatAppVersion(product.appVersion)]);
  }

  rows.push(['Browser', summarizeUserAgent(page.userAgent)]);
  return rows;
}

/**
 * The rows that tell how the transport runs. A Worker SHA that diverges from Build is the tell-tale of a stale cached
 * SharedWorker. RPC rows show the first candidate, which the page diagnostics replace with the endpoint actually
 * connected.
 */
function buildTransportRows(backend: Backend, sha: string): DiagnosticsRow[] {
  switch (backend) {
    case 'smoldot-direct':
      return [];
    case 'smoldot-shared-worker':
      return [['Worker', typeof SharedWorker === 'undefined' ? 'unavailable' : shortenSha(sha)]];
    case 'rpc-gateway': {
      const servicesConfig = getActiveServicesConfig();
      return [
        toCopyableRow('Relay node', servicesConfig.relay.rpcs[0] ?? 'n/a'),
        toCopyableRow('AssetHub node', servicesConfig.assethub.rpcs[0] ?? 'n/a'),
        toCopyableRow('Bulletin Node', servicesConfig.bulletin.rpcs[0] ?? 'n/a'),
      ];
    }
  }
}

function getBackendLabel(backend: Backend): string {
  return BACKEND_LABELS[backend];
}

async function collectSmoldotInfo(
  finalizedBlock: (genesisHash: string) => Promise<number | null>,
): Promise<SmoldotInfo> {
  const version = buildLightClientVersionLabel();
  if (getBackend() === 'rpc-gateway') {
    return { version, blocks: null };
  }
  const servicesConfig = getActiveServicesConfig();
  const [relay, assetHub, people] = await Promise.all([
    finalizedBlock(servicesConfig.relay.genesis),
    finalizedBlock(servicesConfig.assethub.genesis),
    finalizedBlock(servicesConfig.people.genesis),
  ]);
  return {
    version,
    blocks: { relay: formatBlock(relay), assetHub: formatBlock(assetHub), people: formatBlock(people) },
  };
}

// smoldot is compiled into truapi-provider's wasm, so the provider version identifies the build.
function buildLightClientVersionLabel(): string {
  return typeof __LIGHT_CLIENT_VERSION__ === 'string' ? __LIGHT_CLIENT_VERSION__ : 'unknown';
}

function formatBlock(blockNumber: number | null): string {
  return blockNumber === null ? 'n/a' : `#${blockNumber.toLocaleString('en-US')}`;
}

function shortenSha(sha: string): string {
  if (sha === 'dev' || sha.length <= 7) {
    return sha;
  }
  return sha.slice(0, 7);
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

  let os = 'Unknown';
  if (userAgent.includes('Mac OS X') || userAgent.includes('Macintosh')) {
    os = 'macOS';
  } else if (userAgent.includes('Windows')) {
    os = 'Windows';
  } else if (userAgent.includes('Android')) {
    os = 'Android';
  } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
    os = 'iOS';
  } else if (userAgent.includes('Linux')) {
    os = 'Linux';
  }

  return `${browser} (${os})`;
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
