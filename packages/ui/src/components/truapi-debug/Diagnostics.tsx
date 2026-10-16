// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, onCleanup, Show } from 'solid-js';
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
import { Button } from './shared/Button.js';
import { Code } from './shared/Code.js';
import { Column, Columns } from './shared/Columns.js';
import { CopyValue } from './shared/CopyValue.js';
import { KeyValue, KeyValueList, ListHeading } from './shared/KeyValueList.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';

const COPYABLE_ROWS = new Set(['Site', 'Relay node', 'AssetHub node', 'Bulletin Node']);
/** Shown while a value is unknown or loading, so there is nothing to copy. */
const PLACEHOLDERS = new Set(['', '…', 'n/a']);

function Row(props: { label: string; value: string; copyable?: boolean }): JSX.Element {
  return (
    <KeyValue name={props.label} testId="td-diag-row">
      <Show when={props.copyable === true && !PLACEHOLDERS.has(props.value)} fallback={<Code>{props.value}</Code>}>
        <CopyValue label={props.label} value={props.value} />
      </Show>
    </KeyValue>
  );
}

function PackageGroup(props: { title: string; packages: readonly PackageVersion[] }): JSX.Element {
  return (
    <Show when={props.packages.length > 0}>
      <ListHeading>{props.title}</ListHeading>
      <KeyValueList>
        <For each={props.packages}>{pkg => <Row label={pkg.name} value={pkg.version} />}</For>
      </KeyValueList>
    </Show>
  );
}

/** Read afresh each time the tab opens. */
export function DiagnosticsView(props: { active: boolean }): JSX.Element {
  return (
    <Pane testId="td-diagnostics" hidden={!props.active} padded>
      <Show when={props.active}>
        <Diagnostics />
      </Show>
    </Pane>
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
    <Stack gap="md">
      <Button onClick={share} title="Open a new issue on paritytech/dotli pre-filled with these diagnostics">
        Share diagnostic
      </Button>
      <Columns>
        <Column>
          <ListHeading>Page</ListHeading>
          <KeyValueList testId="td-diagnostics-rows">
            <For each={base}>
              {([label, value]) => (
                <Row
                  label={label}
                  value={label === 'AssetHub node' ? (assetHubNode() ?? value) : value}
                  copyable={COPYABLE_ROWS.has(label)}
                />
              )}
            </For>
          </KeyValueList>
        </Column>
        <Column testId="td-packages">
          <ListHeading>Light client</ListHeading>
          <KeyValueList>
            <Row label="@parity/truapi-provider" value={buildLightClientVersionLabel()} />
          </KeyValueList>
          <PackageGroup title="@polkadot-api" packages={polkadotApi} />
          <PackageGroup title="@parity/truapi" packages={parityTruapi} />
        </Column>
      </Columns>
    </Stack>
  );
}
