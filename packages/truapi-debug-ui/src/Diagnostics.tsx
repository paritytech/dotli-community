// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, For, Show, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { DiagnosticsRow, DiagnosticsSource, PackageVersion } from './host.js';
import { createDiagnosticsSharer } from './createDiagnosticsSharer.js';
import { Button } from './shared/Button.js';
import { Code } from './shared/Code.js';
import { Column, Columns } from './shared/Columns.js';
import { CopyValue } from './shared/CopyValue.js';
import { KeyValue, KeyValueList, ListHeading } from './shared/KeyValueList.js';
import { Pane } from './shared/Pane.js';
import { Stack } from './shared/Stack.js';

/** Read afresh each time the tab opens. */
export function Diagnostics(props: { active: boolean; source: DiagnosticsSource }): JSX.Element {
  // The share lives here because the tab's content remounts on every show and a share outlives it.
  const [sharing, setSharing] = createSignal(false);
  const sharer = createDiagnosticsSharer({ source: untrack(() => props.source), onBusy: setSharing });

  return (
    <Pane testId="td-diagnostics" label="Diagnostics" hidden={!props.active} padded>
      <Show when={props.active}>
        <DiagnosticsContent
          source={props.source}
          sharing={sharing()}
          share={rows => {
            void sharer.share(rows);
          }}
        />
      </Show>
    </Pane>
  );
}

function DiagnosticsContent(props: {
  source: DiagnosticsSource;
  sharing: boolean;
  share: (rows: readonly DiagnosticsRow[]) => void;
}): JSX.Element {
  const source = untrack(() => props.source);
  // The report is built from these same rows, so what is shared matches what is shown.
  const base = source.rows();
  const { polkadotApi, parityTruapi } = source.packages();

  return (
    <Stack gap="md">
      <Button
        disabled={props.sharing}
        onClick={() => {
          props.share(base);
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
        <For each={props.packages}>
          {packageVersion => <Row label={packageVersion.name} value={packageVersion.version} />}
        </For>
      </KeyValueList>
    </Show>
  );
}
