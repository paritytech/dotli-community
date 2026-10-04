// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, Show, untrack } from 'solid-js';
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
import { Button } from '../primitives/Button.js';
import { SectionLabel } from '../primitives/SectionLabel.js';
import { Well } from '../primitives/Well.js';
import { InfoRow } from './SettingsRows.js';
import { loadRpcResolve } from '@dotli/resolver';
import s from './Diagnostics.module.css';

/** The rows a click copies. */
const COPYABLE_ROWS = new Set(['Site', 'Relay node', 'AssetHub node', 'Bulletin Node']);

function CopyIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TerminalIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </svg>
  );
}

/**
 * The Diagnostics block of the settings popover, read when it mounts (each
 * time the popover opens): the base rows (some click-to-copy), the light
 * client and package versions behind a Packages disclosure (closed at each
 * opening), "Share diagnostic", which opens a GitHub
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
  const [packagesOpen, setPackagesOpen] = createSignal(false);
  // The light client's own row and every listed package.
  const packageCount = 1 + polkadotApi.length + parityTruapi.length;

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
    <div class={s['diagnostics']}>
      <SectionLabel text="Diagnostics" />
      <Well layout="kv" testId="mode-diagnostics">
        <For each={base}>
          {([label, value]) => (
            <InfoRow
              label={label}
              value={label === 'AssetHub node' ? (assetHubNode() ?? value) : value}
              copyable={COPYABLE_ROWS.has(label)}
            />
          )}
        </For>
      </Well>
      {/* Version only. The per-chain block heights live in the network
          popover, where they can be read live. */}
      <Well layout="flush" testId="mode-packages-well">
        <button
          onClick={() => {
            setPackagesOpen(open => !open);
          }}
          type="button"
          class={s['disclosure']}
          data-testid="mode-packages-toggle"
          aria-expanded={packagesOpen() ? 'true' : 'false'}
          aria-controls="mode-packages"
        >
          <span class={s['disclosureLabel']}>Packages</span>
          <span class={s['count']}>{packageCount}</span>
          <svg
            class={s['chevron']}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div class={s['packages']} id="mode-packages" data-testid="mode-packages" hidden={!packagesOpen()}>
          <SectionLabel text="Light client" class={s['packagesLabel']} />
          <InfoRow label="@parity/truapi-provider" value={buildLightClientVersionLabel()} dense />
          <Show when={polkadotApi.length > 0}>
            <SectionLabel text="@polkadot-api" class={s['packagesLabel']} />
            <For each={polkadotApi}>{pkg => <InfoRow label={pkg.name} value={pkg.version} dense />}</For>
          </Show>
          <Show when={parityTruapi.length > 0}>
            <SectionLabel text="@parity/truapi" class={s['packagesLabel']} />
            <For each={parityTruapi}>{pkg => <InfoRow label={pkg.name} value={pkg.version} dense />}</For>
          </Show>
        </div>
      </Well>
      <div class={s['actions']} data-testid="mode-diagnostic-actions">
        <Button block onClick={share} title="Open a new issue on paritytech/dotli pre-filled with these diagnostics">
          <CopyIcon />
          Share diagnostic
        </Button>
        <Button
          block
          onClick={toggleDebug}
          title={
            debugOn
              ? 'Reload this tab with the TrUAPI debug panel disabled'
              : 'Reload this tab with the TrUAPI debug panel enabled (off again on tab close)'
          }
        >
          <TerminalIcon />
          {debugOn ? 'Exit debug mode' : 'Debug mode'}
        </Button>
      </div>
    </div>
  );
}
