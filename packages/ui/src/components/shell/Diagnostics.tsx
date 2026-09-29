// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Backend } from '@dotli/config';
import {
  buildBaseDiagnosticsRows,
  buildLightClientVersionLabel,
  collectSmoldotInfo,
  formatDiagnosticsReport,
  isTruapiDebugEnabled,
  packageVersions,
} from '../../settings-actions.js';
import { InfoRow, SectionHeader } from './SettingsRows.js';
import { loadRpcResolve } from '@dotli/resolver';

/** The rows a click copies. */
const COPYABLE_ROWS = new Set(['Site', 'Relay node', 'AssetHub node', 'Bulletin Node']);

/**
 * The Diagnostics block of the settings popover, read when it mounts (each
 * time the popover opens): the base rows (some click-to-copy), the light
 * client and package versions, "Share diagnostic", which opens a GitHub
 * issue prefilled with the report, and the debug-mode switch, which reloads
 * the tab with `?debug=true` or `?debug=off`.
 *
 * Values come from places that are cheap to read synchronously so the
 * popover doesn't pop open with a spinner. "unknown" is a valid value, so
 * don't over-engineer fallbacks.
 */
export function Diagnostics(props: {
  /** The saved backend. */
  backend: Backend;
}): JSX.Element {
  const base = buildBaseDiagnosticsRows();
  const [assetHubNode, setAssetHubNode] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // When running in RPC chain mode, ask the live ws-provider which URI
  // it actually connected to. polkadot-api rotates across the curated
  // candidate list on failure, so the first entry of the config array
  // may not be the node currently answering. Lazy-imported so the
  // resolver bundle (polkadot-api and ws-provider) isn't pulled into the
  // popover's own chunk. By the time the popover opens under RPC mode,
  // `@dotli/resolver/rpc-resolve` is already warm because host main
  // imported it to resolve the name. Both the row and the base snapshot
  // are updated so the Share-diagnostic export stays honest.
  if (untrack(() => props.backend) === 'rpc-gateway') {
    void loadRpcResolve().then(({ getConnectedAssetHubRpcEndpoint }) => {
      const live = getConnectedAssetHubRpcEndpoint();
      if (live === null || disposed) {
        return;
      }
      setAssetHubNode(live);
      const row = base.find(r => r[0] === 'AssetHub node');
      if (row !== undefined) {
        row[1] = live;
      }
    });
  }

  const { polkadotApi, parityTruapi } = packageVersions();
  const debugOn = isTruapiDebugEnabled();

  const share = (): void => {
    void (async () => {
      // Block heights now live in the Network popover, so nothing has them
      // cached. Query them here, where a report is actually being made,
      // instead of keeping four chains awake for a panel nobody opened.
      const smoldotInfo = await collectSmoldotInfo();
      const report = await formatDiagnosticsReport(base, smoldotInfo, polkadotApi, parityTruapi);
      const body = [
        '<!-- Describe the issue above this line; the diagnostics below are auto-filled. -->',
        '',
        '## Diagnostics',
        '',
        '```',
        report,
        '```',
      ].join('\n');
      const url = new URL('https://github.com/paritytech/dotli/issues/new');
      url.searchParams.set('body', body);
      window.open(url.toString(), '_blank', 'noopener,noreferrer');
    })();
  };

  const toggleDebug = (): void => {
    const url = new URL(window.location.href);
    url.searchParams.set('debug', debugOn ? 'off' : 'true');
    window.location.assign(url.toString());
  };

  return (
    <>
      <For each={base}>
        {([label, value]) => (
          <InfoRow
            label={label}
            value={label === 'AssetHub node' ? (assetHubNode() ?? value) : value}
            copyable={COPYABLE_ROWS.has(label)}
          />
        )}
      </For>
      {/* Version only. The per-chain block heights live in the network
          popover, where they can be read live. */}
      <SectionHeader text="Light client" />
      <InfoRow label="@parity/truapi-provider" value={buildLightClientVersionLabel()} />
      {polkadotApi.length > 0 && (
        <>
          <SectionHeader text="@polkadot-api" />
          <For each={polkadotApi}>{pkg => <InfoRow label={pkg.name} value={pkg.version} />}</For>
        </>
      )}
      {parityTruapi.length > 0 && (
        <>
          <SectionHeader text="@parity/truapi" />
          <For each={parityTruapi}>{pkg => <InfoRow label={pkg.name} value={pkg.version} />}</For>
        </>
      )}
      <div class="mode-cache-row mode-diag-links-row">
        <button
          ref={el => {
            el.addEventListener('click', share);
          }}
          type="button"
          class="mode-clear-btn"
          title="Open a new issue on paritytech/dotli pre-filled with these diagnostics"
        >
          Share diagnostic
        </button>
        <button
          ref={el => {
            el.addEventListener('click', toggleDebug);
          }}
          type="button"
          class="mode-clear-btn"
          title={
            debugOn
              ? 'Reload this tab with the TrUAPI debug panel disabled'
              : 'Reload this tab with the TrUAPI debug panel enabled (off again on tab close)'
          }
        >
          {debugOn ? 'Exit debug mode' : 'Open in debug mode'}
        </button>
      </div>
    </>
  );
}
