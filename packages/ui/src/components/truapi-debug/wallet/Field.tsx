// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';

/** One labelled value of the Wallet view: `Label: value`. */
export function Field(props: { label: string; value: string }): JSX.Element {
  return (
    <p>
      <strong>{`${props.label}: `}</strong>
      {props.value}
    </p>
  );
}
