// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { getBackend } from '@dotli/config';
import { loadRpcResolve } from '@dotli/resolver';
import {
  buildBaseDiagnosticsRows,
  buildLightClientVersionLabel,
  collectSmoldotInfo,
  formatDiagnosticsReport,
  packageVersions,
  type PackageVersion,
} from '../../settings-actions.js';
import s from './Diagnostics.module.css';

const COPIED_MS = 1000;

const COPYABLE_ROWS = new Set(['Site', 'Relay node', 'AssetHub node', 'Bulletin Node']);

function Value(props: { label: string; value: string; copyable: boolean }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(copiedTimer);
  });
  const copy = (): void => {
    const value = untrack(() => props.value);
    if (value === '' || value === '…' || value === 'n/a') {
      return;
    }
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        setCopied(false);
        copiedTimer = undefined;
      }, COPIED_MS);
    });
  };
  return (
    <dd class={s['value']}>
      <Show when={props.copyable} fallback={<code class={s['code']}>{props.value}</code>}>
        <button
          class={s['copy']}
          type="button"
          title={`Click to copy ${props.label}`}
          aria-label={`Copy ${props.label}`}
          data-copied={copied() ? '' : undefined}
          onClick={copy}
        >
          <code class={s['code']}>{copied() ? 'Copied' : props.value}</code>
        </button>
      </Show>
    </dd>
  );
}

function Row(props: { label: string; value: string; copyable?: boolean }): JSX.Element {
  return (
    <div class={s['row']} data-testid="td-diag-row">
      <dt class={s['name']}>{props.label}</dt>
      <Value label={props.label} value={props.value} copyable={props.copyable === true} />
    </div>
  );
}

function PackageGroup(props: { title: string; packages: readonly PackageVersion[] }): JSX.Element {
  return (
    <Show when={props.packages.length > 0}>
      <h3 class={s['group']}>{props.title}</h3>
      <dl class={s['fields']}>
        <For each={props.packages}>{pkg => <Row label={pkg.name} value={pkg.version} />}</For>
      </dl>
    </Show>
  );
}

/** Read afresh each time the tab opens. */
export function DiagnosticsView(props: { active: boolean }): JSX.Element {
  return (
    <div class={s['view']} data-testid="td-diagnostics" hidden={!props.active}>
      <Show when={props.active}>
        <Diagnostics />
      </Show>
    </div>
  );
}

function Diagnostics(): JSX.Element {
  const base = buildBaseDiagnosticsRows();
  const [assetHubNode, setAssetHubNode] = createSignal<string | null>(null);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  // polkadot-api rotates nodes on failure, so ask the live provider which one answers, and patch the base rows
  // so the shared report agrees. Lazy to keep the resolver out of the panel's chunk.
  if (getBackend() === 'rpc-gateway') {
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

  const share = (): void => {
    void (async () => {
      // Queried only here, rather than keeping four chains awake for a tab nobody opened.
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

  return (
    <>
      <div class={s['bar']}>
        <button
          class={s['btn']}
          type="button"
          onClick={share}
          title="Open a new issue on paritytech/dotli pre-filled with these diagnostics"
        >
          Share diagnostic
        </button>
      </div>
      <div class={s['sections']}>
        <section class={s['section']}>
          <h3 class={s['group']}>Page</h3>
          <dl class={s['fields']} data-testid="td-diagnostics-rows">
            <For each={base}>
              {([label, value]) => (
                <Row
                  label={label}
                  value={label === 'AssetHub node' ? (assetHubNode() ?? value) : value}
                  copyable={COPYABLE_ROWS.has(label)}
                />
              )}
            </For>
          </dl>
        </section>
        <section class={s['section']} data-testid="td-packages">
          <h3 class={s['group']}>Light client</h3>
          <dl class={s['fields']}>
            <Row label="@parity/truapi-provider" value={buildLightClientVersionLabel()} />
          </dl>
          <PackageGroup title="@polkadot-api" packages={polkadotApi} />
          <PackageGroup title="@parity/truapi" packages={parityTruapi} />
        </section>
      </div>
    </>
  );
}
