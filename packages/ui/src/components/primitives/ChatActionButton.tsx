// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './ChatActionButton.module.css';

export type ChatActionButtonVariant = 'primary' | 'secondary' | 'text';

export interface ChatActionButtonProps {
  variant: ChatActionButtonVariant;
  /** Pulses while the app works on the action. A loading button is disabled. */
  loading?: boolean;
  disabled?: boolean;
  /** Carries the layout modifiers of a product's render tree. */
  style?: JSX.CSSProperties;
  class?: string;
  testId?: string;
  onClick: () => void;
  children: JSX.Element;
}

export function ChatActionButton(props: ChatActionButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class={[s['button'], props.class]}
      data-variant={props.variant}
      data-loading={props.loading === true ? '' : undefined}
      data-testid={props.testId}
      disabled={props.disabled === true || props.loading === true}
      style={props.style}
      onClick={() => {
        props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}
