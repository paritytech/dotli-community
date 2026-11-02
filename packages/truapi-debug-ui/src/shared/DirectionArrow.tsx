// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import { IncomingIcon } from '../icons/IncomingIcon.js';
import { OutgoingIcon } from '../icons/OutgoingIcon.js';
import type { StoredTruapiEvent } from '../model/storedEvent.js';
import s from './DirectionArrow.module.css';

type Direction = StoredTruapiEvent['direction'];

/** Whether a TrUAPI message went to the product or came from it. */
export function DirectionArrow(props: { direction: Direction }): JSX.Element {
  const arrow = (): ReturnType<typeof getArrowLook> => getArrowLook(props.direction);
  return (
    <span class={[s['arrow'], arrow().className]} data-testid={arrow().testId} role="img" aria-label={arrow().label}>
      {arrow().renderIcon()}
    </span>
  );
}

/** What tells one direction's arrow from the other's. */
function getArrowLook(direction: Direction) {
  switch (direction) {
    case 'outgoing':
      return {
        className: s['out'],
        testId: 'td-arrow-out',
        label: 'outgoing',
        renderIcon: () => <OutgoingIcon size={10} />,
      };
    case 'incoming':
      return {
        className: s['in'],
        testId: 'td-arrow-in',
        label: 'incoming',
        renderIcon: () => <IncomingIcon size={10} />,
      };
  }
}
