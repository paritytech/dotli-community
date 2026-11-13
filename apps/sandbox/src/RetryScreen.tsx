// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The retry screen's view.

import type { JSX } from '@solidjs/web';
import { PetalMark } from '@dotli/ui/brand';
import s from './RetryScreen.module.css';

/** The pulsing logo over what is happening, drawn here so the sandbox never loads the loading screen island. */
export function RetryScreen(props: { standalone: boolean }): JSX.Element {
  return (
    <div class={[s['screen'], props.standalone ? s['standalone'] : undefined]} data-testid="retry-screen">
      <div class={s['column']}>
        <PetalMark size={56} class={s['mark']} pulse testId="retry-screen-mark" />
        <p id="status" class={s['step']}>
          Retrying…
        </p>
        <p class={s['line']}>The app's connection dropped, so it is starting again</p>
      </div>
    </div>
  );
}
