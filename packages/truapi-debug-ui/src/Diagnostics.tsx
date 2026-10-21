// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DiagnosticsSource, PackageVersion } from './host.js';
import { createDiagnosticsSharer } from './share-diagnostics.js';
import { Button } from './shared/Button.js';
import { Code } from './shared/Code.js';
import { Column, Columns } from './shared/Columns.js';
import { CopyValue } from './shared/CopyValue.js';
import { KeyValue, KeyValueList, ListHeading } from './shared/KeyValueList.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';

function Row(props: { label: string; value: string; copyable?: boolean }): JSX.Element {
  return (
    <KeyValue name={props.label} testId="td-diag-row">
      <Show when={props.copyable === true} fallback={<Code>{props.value}</Code>}>
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
export function DiagnosticsView(props: { active: boolean; source: DiagnosticsSource }): JSX.Element {
  return (
    <Pane testId="td-diagnostics" label="Diagnostics" hidden={!props.active} padded>
      <Show when={props.active}>
        <Diagnostics source={props.source} />
      </Show>
    </Pane>
  );
}

function Diagnostics(props: { source: DiagnosticsSource }): JSX.Element {
  const source = untrack(() => props.source);
  // The report is built from these same rows, so what is shared matches what is shown.
  const base = source.rows();
  const { polkadotApi, parityTruapi } = source.packages();

  const [sharing, setSharing] = createSignal(false);
  const sharer = createDiagnosticsSharer({ source, rows: base, onBusy: setSharing });

  return (
    <Stack gap="md">
      <Button
        disabled={sharing()}
        onClick={() => {
          void sharer.share();
        }}
        title="Open a new issue on paritytech/dotli pre-filled with these diagnostics"
      >
        Share diagnostic
      </Button>
      <Columns>
        <Column>
          <ListHeading>Page</ListHeading>
          <KeyValueList testId="td-diagnostics-rows">
            <For each={base}>
              {([label, value, copyable]) => <Row label={label} value={value} copyable={copyable === true} />}
            </For>
          </KeyValueList>
        </Column>
        <Column testId="td-packages">
          <ListHeading>Light client</ListHeading>
          <KeyValueList>
            <Row label="@parity/truapi-provider" value={source.lightClientVersion()} />
          </KeyValueList>
          <PackageGroup title="@polkadot-api" packages={polkadotApi} />
          <PackageGroup title="@parity/truapi" packages={parityTruapi} />
        </Column>
      </Columns>
    </Stack>
  );
}
