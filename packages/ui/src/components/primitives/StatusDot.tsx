// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './StatusDot.module.css';

/** The status colours every chrome mark shares: dots, the capsule bar, badges and toast tiles. */
export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'idle';

/** A coloured dot with a soft halo. Decorative: the text beside it carries the meaning. */
export function StatusDot(props: {
  tone: StatusTone;
  size?: 'md' | 'sm';
  /** Pulses (syncing), off under reduced motion. */
  pulse?: boolean;
  class?: string | undefined;
  testId?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      class={[s['dot'], props.class]}
      data-tone={props.tone}
      data-size={props.size ?? 'md'}
      data-pulse={props.pulse === true ? '' : undefined}
      data-testid={props.testId}
    />
  );
}
