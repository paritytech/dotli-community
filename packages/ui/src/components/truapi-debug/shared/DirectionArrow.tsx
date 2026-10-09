// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './DirectionArrow.module.css';

/** Whether a TrUAPI message went to the product or came from it. */
export function DirectionArrow(props: { direction: 'incoming' | 'outgoing' }): JSX.Element {
  const out = (): boolean => props.direction === 'outgoing';
  return (
    <span class={[s['arrow'], out() ? s['out'] : s['in']]} data-testid={out() ? 'td-arrow-out' : 'td-arrow-in'}>
      {out() ? '▶' : '◀'}
    </span>
  );
}
