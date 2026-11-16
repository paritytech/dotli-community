// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { For } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { NETWORK_NAME_TO_SERVICES_CONFIG, type Network } from '@dotli/config';
import { Choice, Stack } from '@dotli/ui';

export type NetworkChoicesProps = {
  networks: readonly Network[];
  /** The chosen network, drawn as selected. */
  value: Network;
  /** A network was picked. */
  onChoose: (network: Network) => void;
};

/** The network choice: a radio list of the deployment's networks, which the caller heads with a label where it needs one. */
export function NetworkChoices(props: NetworkChoicesProps): JSX.Element {
  return (
    <Stack role="radiogroup" aria-label="Network">
      <For each={props.networks}>
        {value => (
          <Choice
            title={NETWORK_NAME_TO_SERVICES_CONFIG[value].label}
            description={NETWORK_NAME_TO_SERVICES_CONFIG[value].description}
            selected={props.value === value}
            radio={{
              name: 'dotli-network',
              value,
              onChoose: () => {
                props.onChoose(value);
              },
            }}
          />
        )}
      </For>
    </Stack>
  );
}
