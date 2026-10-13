// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The retry screen's view, loaded through src/lazy.ts, so it stays out of the sandbox's boot.

import type { JSX } from '@solidjs/web';
import { PetalMark } from '@dotli/ui/brand';
import type { ScreenSlot } from '@dotli/ui-widgets';
import { mountScreen } from '@dotli/ui-widgets/views';
import { RETRY_LINE, RETRY_STATUS } from './retry-screen.js';
import s from './RetryScreen.module.css';

/** The pulsing logo over what is happening, drawn here so the sandbox never loads the loading screen island. */
export function RetryScreen(props: { standalone: boolean }): JSX.Element {
  return (
    <div class={[s['screen'], props.standalone ? s['standalone'] : undefined]} data-testid="retry-screen">
      <div class={s['column']}>
        <PetalMark size={56} class={s['mark']} petalClass={s['petal']} testId="retry-screen-mark" />
        <p id="status" class={s['step']}>
          {RETRY_STATUS}
        </p>
        <p class={s['line']}>{RETRY_LINE}</p>
      </div>
    </div>
  );
}

export function mountRetryScreen(slot: ScreenSlot): void {
  mountScreen(slot, () => <RetryScreen standalone={slot.standalone} />);
}
