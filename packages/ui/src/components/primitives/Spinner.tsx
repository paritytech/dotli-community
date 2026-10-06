// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Spinner.module.css';

export interface SpinnerProps {
  class?: string | undefined;
  testId?: string;
}

export function Spinner(props: SpinnerProps): JSX.Element {
  return <div class={[s['spinner'], props.class]} data-testid={props.testId} />;
}
