// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { IncomingIcon } from '../icons/IncomingIcon.js';
import { OutgoingIcon } from '../icons/OutgoingIcon.js';
import s from './DirectionArrow.module.css';

/** Whether a TrUAPI message went to the product or came from it. */
export function DirectionArrow(props: { direction: 'incoming' | 'outgoing' }): JSX.Element {
  const out = (): boolean => props.direction === 'outgoing';
  return (
    <span
      class={[s['arrow'], out() ? s['out'] : s['in']]}
      data-testid={out() ? 'td-arrow-out' : 'td-arrow-in'}
      role="img"
      aria-label={out() ? 'outgoing' : 'incoming'}
    >
      {out() ? <OutgoingIcon size={10} /> : <IncomingIcon size={10} />}
    </span>
  );
}
