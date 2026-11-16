// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Spinner.module.css';

export type SpinnerProps = {
  class?: string | undefined;
  testId?: string;
};

/**
 * A ring that spins while something loads. Assistive technology skips it, so its caller names the wait, as a status or
 * `aria-busy`.
 */
export function Spinner(props: SpinnerProps): JSX.Element {
  return <div class={[s['spinner'], props.class]} aria-hidden="true" data-testid={props.testId} />;
}
