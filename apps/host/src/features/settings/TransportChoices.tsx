// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { BACKEND_FACTS, hasSharedWorker, type Backend } from '@dotli/config';
import { Chip, Choice, SectionLabel, Stack } from '@dotli/ui';

/** The order the transport choices are listed in. */
const TRANSPORT_ORDER: readonly Backend[] = ['smoldot-direct', 'smoldot-shared-worker', 'rpc-gateway'];

/** What the transport choice for each backend says. */
const TRANSPORT_FACTS = {
  'smoldot-direct': { description: 'Verified in your browser, separate for each tab', recommended: true },
  'smoldot-shared-worker': { description: 'Verified in your browser, shared across tabs', recommended: false },
  'rpc-gateway': { description: 'Fetched from trusted servers. Fastest, but less private', recommended: false },
} satisfies Record<Backend, { description: string; recommended: boolean }>;

export type TransportChoicesProps = {
  /** The chosen backend, drawn as selected. */
  value: Backend;
  /** Whether this browser can run a SharedWorker. A backend that needs one is disabled without it. */
  sharedWorkerAvailable: boolean;
  /** A backend was picked. */
  onChoose: (backend: Backend) => void;
};

/** The network transport choice: a labelled radio list of the backends a page reaches the chains through. */
export function TransportChoices(props: TransportChoicesProps): JSX.Element {
  const unavailable = (value: Backend): boolean => hasSharedWorker(value) && !props.sharedWorkerAvailable;
  return (
    <Stack>
      <SectionLabel text="Network transport" />
      <Stack role="radiogroup" aria-label="Network transport">
        <For each={TRANSPORT_ORDER}>
          {value => (
            <Choice
              title={BACKEND_FACTS[value].label}
              description={
                unavailable(value)
                  ? 'Unavailable in this browser or private window'
                  : TRANSPORT_FACTS[value].description
              }
              chip={TRANSPORT_FACTS[value].recommended ? <Chip tone="ok">Recommended</Chip> : undefined}
              selected={props.value === value}
              radio={{
                name: 'dotli-backend',
                value,
                disabled: unavailable(value),
                onChoose: () => {
                  props.onChoose(value);
                },
              }}
            />
          )}
        </For>
      </Stack>
    </Stack>
  );
}
