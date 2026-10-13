// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { StatusTone } from '../../page/status-tone.js';
import s from './StatusDot.module.css';

/** A coloured dot with a soft halo, decorative unless a `label` names it. */
export function StatusDot(props: {
  tone: StatusTone;
  size?: 'md' | 'sm';
  /** Pulses while syncing. */
  pulse?: boolean;
  /** Names a dot that stands alone, with no text beside it. */
  label?: string;
  class?: string | undefined;
  testId?: string;
}): JSX.Element {
  return (
    <span
      aria-hidden={props.label === undefined ? 'true' : undefined}
      role={props.label === undefined ? undefined : 'img'}
      aria-label={props.label}
      class={[s['dot'], props.class]}
      data-tone={props.tone}
      data-size={props.size ?? 'md'}
      data-pulse={props.pulse === true ? '' : undefined}
      data-testid={props.testId}
    />
  );
}
