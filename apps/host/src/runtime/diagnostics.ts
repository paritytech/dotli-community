// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The diagnostics report: build, transport, permissions, package versions and chain heights.

import { captureException, m, reportExpected, spans as S } from '@dotli/metrics';
import { errorName, log, named, withTimeout } from '@dotli/shared';
import { formatAppVersion } from './manifest-facts.js';
import { isRemoteChainSupported, type RemoteChainProvider } from '@dotli/protocol';
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
import { loadBridge, loadPolkadotApi } from '../lazy.js';
import { pagePermissions } from './page-permissions.js';
import { ALL_PERMISSIONS, type PermissionAuthorizations } from './permissions.js';
import { dotliVersion } from './runtime-config.js';
import { getProductState } from './state/product.js';

// Defined in the host's Astro config, so undefined in tests and other bundles.
declare const __LIGHT_CLIENT_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSION__: string | undefined;
declare const __POLKADOT_API_VERSIONS__: { name: string; version: string }[] | undefined;
declare const __PARITY_TRUAPI_VERSIONS__: { name: string; version: string }[] | undefined;

export interface PageDiagnosticsDeps {
  /** The AssetHub node the trusted provider answers on, or null before it connects. */
  connectedAssetHubNode: () => string | null;
  finalizedBlock: (genesisHash: string) => Promise<number | null>;
  openIssue: (url: string) => void;
  page: () => DiagnosticsPage;
  /** The product's permission statuses, for the report. */
  permissionStatuses: PermissionAuthorizations['statuses'];
}

/** What the browser says about the page the report is from. */
export interface DiagnosticsPage {
  site: string;
  userAgent: string;
}

export function createPageDiagnostics(deps: PageDiagnosticsDeps): DiagnosticsSource {
  return {
    rows: () => {
      const rows = buildBaseDiagnosticsRows(deps.page());
      // polkadot-api rotates nodes on failure, so ask the live transport which one answers.
      const node = getBackend() === 'rpc-gateway' ? deps.connectedAssetHubNode() : null;
      const assetHub = rows.find(([label]) => label === 'AssetHub node');
      if (node !== null && assetHub !== undefined) {
        assetHub[1] = node;
        assetHub[2] = true;
      }
      return rows;
    },
    lightClientVersion: buildLightClientVersionLabel,
    packages: packageVersions,
    report: async rows => {
      const { polkadotApi, parityTruapi } = packageVersions();
      return formatDiagnosticsReport(
        rows,
        await collectSmoldotInfo(deps.finalizedBlock),
        polkadotApi,
        parityTruapi,
        deps.permissionStatuses,
      );
    },
    openIssue: deps.openIssue,
  };
}

/** Plain text that reads cleanly in a GitHub issue code block and in a Slack message. */
async function formatDiagnosticsReport(
  base: readonly DiagnosticsRow[],
  smoldot: SmoldotInfo,
  polkadotApi: { name: string; version: string }[],
  parityTruapi: { name: string; version: string }[],
  permissionStatuses: PermissionAuthorizations['statuses'],
): Promise<string> {
  const lines: string[] = [];
  for (const [k, v] of base) {
    lines.push(`${k}: ${v}`);
  }

  const cache = getCacheSettings();
  lines.push(
    '',
    'Cache:',
    `  dotNS cache: ${cache.skipCidCache ? 'off' : 'on'}`,
    `  Archive cache: ${cache.skipArchiveCache ? 'off' : 'on'}`,
    `  Worker cache: ${cache.skipWorkerCache ? 'off' : 'on'}`,
  );

  const product = getProductState();
  if (product.status === 'loaded') {
    const productLabel = product.label;
    lines.push('', 'Permissions:');
    const statuses = await permissionStatuses(
      productLabel,
      ALL_PERMISSIONS.map(({ name }) => name),
    );
    for (const [index, perm] of ALL_PERMISSIONS.entries()) {
      const status = statuses[index] ?? 'ask';
      lines.push(`  ${perm.label}: ${status === 'granted' ? 'on' : 'off'}`);
    }
  }

  // smoldot leads because most issues are ultimately about it.
  lines.push('', 'Packages:', `  smoldot: ${smoldot.version}`);
  for (const p of polkadotApi) {
    lines.push(`  ${p.name}: ${p.version}`);
  }
  for (const p of parityTruapi) {
    lines.push(`  ${p.name}: ${p.version}`);
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

function browserPage(): DiagnosticsPage {
  return { site: window.location.host, userAgent: navigator.userAgent };
}

/** A row worth pasting elsewhere, unless it holds no value yet. */
function copyableRow(label: string, value: string): DiagnosticsRow {
  return value === '' || value === 'n/a' ? [label, value] : [label, value, true];
}

function buildBaseDiagnosticsRows(page: DiagnosticsPage = browserPage()): DiagnosticsRow[] {
  const sha = import.meta.env.VITE_COMMIT_SHA ?? 'dev';

  const backend = getBackend();
  const network = getNetwork();

  const rows: DiagnosticsRow[] = [
    copyableRow('Site', page.site),
    ['Build', `${dotliVersion()} (${shortSha(sha)})`],
    ['Network', NETWORK_NAME_TO_SERVICES_CONFIG[network].label],
    ['Transport', backendLabel(backend)],
  ];

  // A Worker SHA that diverges from Build is the tell-tale of a stale cached SharedWorker. RPC rows show
  // the first candidate, which the page diagnostics replace with the endpoint actually connected.
  if (backend === 'smoldot-shared-worker') {
    if (typeof SharedWorker === 'undefined') {
      rows.push(['Worker', 'unavailable']);
    } else {
      rows.push(['Worker', shortSha(sha)]);
    }
  } else if (backend === 'rpc-gateway') {
    const cfg = getActiveServicesConfig();
    rows.push(copyableRow('Relay node', cfg.relay.rpcs[0] ?? 'n/a'));
    rows.push(copyableRow('AssetHub node', cfg.assethub.rpcs[0] ?? 'n/a'));
    rows.push(copyableRow('Bulletin Node', cfg.bulletin.rpcs[0] ?? 'n/a'));
  }

  const product = getProductState();
  if (product.status === 'loaded' && product.manifestVersion !== undefined) {
    rows.push(['Manifest', `v${String(product.manifestVersion)}`]);
  }
  if (product.status === 'loaded' && product.appVersion !== undefined) {
    rows.push(['App version', formatAppVersion(product.appVersion)]);
  }

  rows.push(['Browser', summarizeUserAgent(page.userAgent)]);
  return rows;
}

function backendLabel(b: Backend): string {
  return BACKEND_LABELS[b];
}

async function collectSmoldotInfo(
  finalizedBlock: (genesisHash: string) => Promise<number | null>,
): Promise<SmoldotInfo> {
  const version = buildLightClientVersionLabel();
  if (getBackend() === 'rpc-gateway') {
    return { version, blocks: null };
  }
  const cfg = getActiveServicesConfig();
  const [relay, assetHub, people] = await Promise.all([
    finalizedBlock(cfg.relay.genesis),
    finalizedBlock(cfg.assethub.genesis),
    finalizedBlock(cfg.people.genesis),
  ]);
  return {
    version,
    blocks: { relay: formatBlock(relay), assetHub: formatBlock(assetHub), people: formatBlock(people) },
  };
}

export interface SmoldotInfo {
  version: string;
  /** Null on trusted providers, which run no light client to ask. */
  blocks: { relay: string; assetHub: string; people: string } | null;
}

// smoldot is compiled into truapi-provider's wasm, so the provider version identifies the build.
function buildLightClientVersionLabel(): string {
  return typeof __LIGHT_CLIENT_VERSION__ === 'string' ? __LIGHT_CLIENT_VERSION__ : 'unknown';
}

export interface FinalizedBlockClient {
  getFinalizedBlock: () => Promise<{ number: number }>;
  destroy: () => void;
}

export interface FinalizedBlockSource {
  /** The host's provider for the chain, or null when the active backend does not serve it. */
  provider: (genesisHash: string) => Promise<RemoteChainProvider | null>;
  createClient: (provider: RemoteChainProvider) => Promise<FinalizedBlockClient>;
}

const FINALIZED_BLOCK_LIMIT_MS = 10_000;

/** Null when the chain is not served, does not answer, or the query times out. Reports its own failures. */
export function createFinalizedBlockQuery(
  source: FinalizedBlockSource,
): (genesisHash: string) => Promise<number | null> {
  return async genesisHash => {
    const timeout = named(new Error(`No finalized block within ${String(FINALIZED_BLOCK_LIMIT_MS)}ms`), 'TimeoutError');
    try {
      const provider = await source.provider(genesisHash);
      if (provider === null) {
        return null;
      }
      const client = await source.createClient(provider);
      let block: { number: number };
      try {
        block = await withTimeout(client.getFinalizedBlock(), FINALIZED_BLOCK_LIMIT_MS, () => timeout);
      } finally {
        client.destroy();
      }
      // After the close, so a close that throws counts as the one error instead of after an ok.
      m.count(S.DIAGNOSTICS_FINALIZED_BLOCK, { outcome: 'ok' });
      return block.number;
    } catch (err) {
      if (err === timeout) {
        // A slow chain is the network's state rather than a fault, and the report says n/a for it.
        reportExpected(err, {
          flow: 'ui',
          step: 'diagnostics_block',
          metric: S.DIAGNOSTICS_FINALIZED_BLOCK,
          outcome: 'timeout',
          reason: 'timeout',
          message: '[dot.li diagnostics] finalized block query timed out:',
        });
      } else {
        const reason = errorName(err) ?? 'unknown';
        log.error('[dot.li diagnostics] finalized block query failed:', err);
        captureException(err, { flow: 'ui', step: 'diagnostics_block', tags: { reason } });
        m.count(S.DIAGNOSTICS_FINALIZED_BLOCK, { outcome: 'error', reason });
      }
      return null;
    }
  };
}

// The bridge and `polkadot-api` chunks load only when a report asks for chain heights.
const queryFinalizedBlock = createFinalizedBlockQuery({
  provider: async genesisHash =>
    isRemoteChainSupported(genesisHash) ? (await loadBridge()).hostChainProvider(genesisHash) : null,
  createClient: async provider => (await loadPolkadotApi()).createClient(provider),
});

function formatBlock(n: number | null): string {
  return n === null ? 'n/a' : `#${n.toLocaleString('en-US')}`;
}

function shortSha(sha: string): string {
  if (sha === 'dev' || sha.length <= 7) {
    return sha;
  }
  return sha.slice(0, 7);
}

/** A heuristic like "Chrome 147 (macOS)", not a real UA parser. */
function summarizeUserAgent(ua: string): string {
  let browser = 'Unknown';
  const chromeVersion = /(Chrome|CriOS)\/(\d+)/.exec(ua)?.[2];
  const firefoxVersion = /Firefox\/(\d+)/.exec(ua)?.[1];
  const safariVersion = /Version\/(\d+)[^)]+Safari/.exec(ua)?.[1];
  const edgeVersion = /Edg\/(\d+)/.exec(ua)?.[1];
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
  if (ua.includes('Mac OS X') || ua.includes('Macintosh')) {
    os = 'macOS';
  } else if (ua.includes('Windows')) {
    os = 'Windows';
  } else if (ua.includes('Android')) {
    os = 'Android';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    os = 'iOS';
  } else if (ua.includes('Linux')) {
    os = 'Linux';
  }

  return `${browser} (${os})`;
}

/** The unscoped `polkadot-api` package is listed with its `@polkadot-api/*` siblings. */
function packageVersions(): {
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

/** The page's diagnostics, over the host's chains and the trusted provider's live node. */
export const pageDiagnostics: DiagnosticsSource = createPageDiagnostics({
  connectedAssetHubNode: getConnectedAssetHubRpcEndpoint,
  finalizedBlock: queryFinalizedBlock,
  openIssue: url => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  page: browserPage,
  permissionStatuses: (label, names) => pagePermissions.statuses(label, names),
});
