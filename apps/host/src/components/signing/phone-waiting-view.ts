// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ModalView } from '@dotli/ui';
import { PhoneWaiting } from './PhoneWaiting.js';

/** What the phone is asked to do, which words the lead line. */
export type PhoneAsk = 'sign' | 'approve';

/** The result of every way out of the waiting step. */
export const WAITING_BACKGROUND = 'background';

/**
 * The waiting step for a review titled `title`. Every way out answers WAITING_BACKGROUND, since it only moves the
 * wait out of sight and rejects nothing.
 */
export function phoneWaitingView(args: {
  title: string;
  icon?: ModalView<string>['icon'];
  ask: PhoneAsk;
}): ModalView<typeof WAITING_BACKGROUND> {
  return {
    title: args.title,
    ...(args.icon === undefined ? {} : { icon: args.icon }),
    fields: [],
    buttons: [{ label: 'Wait in background', variant: 'secondary', result: WAITING_BACKGROUND }],
    dismissOnBackdrop: true,
    dismissResult: WAITING_BACKGROUND,
    closable: false,
    body: () => PhoneWaiting({ ask: args.ask }),
  };
}
