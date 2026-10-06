// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './Switch.module.css';

export interface SwitchProps {
  checked: boolean;
  /** Called with the value the user asked for. The switch shows `checked` until its owner updates it. */
  onChange: (checked: boolean) => void;
  /** The accessible name, since the visible label is the row beside it. */
  label: string;
  class?: string | undefined;
  testId?: string;
}

export function Switch(props: SwitchProps): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked ? 'true' : 'false'}
      aria-label={props.label}
      onClick={() => {
        props.onChange(!props.checked);
      }}
      class={[s['switch'], props.class]}
      data-testid={props.testId}
    />
  );
}
