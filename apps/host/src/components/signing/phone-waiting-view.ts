// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Component } from 'solid-js';
import type { ModalView } from '@dotli/ui';
import type { PhoneAsk } from '../../runtime/phone-methods.js';
import { PhoneWaiting } from './PhoneWaiting.js';

export const WAITING_BACKGROUND = 'background';

// One body per ask, so the step a review hands off to names its ask by which body it draws.
const BODIES: Record<PhoneAsk, Component> = {
  sign: () => PhoneWaiting({ ask: 'sign' }),
  approve: () => PhoneWaiting({ ask: 'approve' }),
};

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
    body: BODIES[args.ask],
  };
}
