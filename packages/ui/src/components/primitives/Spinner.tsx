// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Spinner.module.css';

export interface SpinnerProps {
  /** A class of the consumer's own, for placement (margins, size). */
  class?: string;
  /** Rendered as `data-testid`. */
  testId?: string;
}

/** A ring that turns once every 0.8 s while something loads. */
export function Spinner(props: SpinnerProps): JSX.Element {
  return <div class={[s['spinner'], props.class]} data-testid={props.testId} />;
}
