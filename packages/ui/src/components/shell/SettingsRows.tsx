// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createSignal, onCleanup, untrack } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { KeyValue } from '../primitives/Well.js';

/** How long a copied row reads "Copied". */
const COPIED_MS = 1000;

/**
 * A diagnostics label and value, `dense` (24 px, a mono label) in the package
 * list. A copyable row copies its value on click (unless it is empty, "…" or
 * "n/a") and reads "Copied" for a second.
 */
export function InfoRow(props: { label: string; value: string; copyable?: boolean; dense?: boolean }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearTimeout(copiedTimer);
  });
  const copyable = untrack(() => props.copyable === true);
  // A dense row's name truncates, so its tooltip carries it in full.
  const title = (): string | undefined => {
    if (copyable) {
      return `Click to copy ${props.label}`;
    }
    return props.dense === true ? props.label : undefined;
  };
  return (
    <KeyValue
      k={props.label}
      v={copied() ? 'Copied' : props.value}
      dense={props.dense === true}
      monoKey={props.dense === true}
      copyable={copyable}
      title={title()}
      onClick={() => {
        if (!copyable) {
          return;
        }
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
      }}
      status={copied() ? 'Copied' : ''}
      testId="mode-info-row"
    />
  );
}
