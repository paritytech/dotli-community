// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './InlineActionButton.module.css';

export type InlineActionButtonVariant = 'primary' | 'secondary' | 'text';

export type InlineActionButtonProps = {
  variant: InlineActionButtonVariant;
  /** Pulses while the app works on the action. A loading button is disabled. */
  loading?: boolean;
  disabled?: boolean;
  /** Carries the layout modifiers of a product's render tree. */
  style?: JSX.CSSProperties;
  class?: string;
  testId?: string;
  onClick: () => void;
  children: JSX.Element;
};

/** The action button of a chat bubble and of a product's custom body, drawn in the chat's colours. */
export function InlineActionButton(props: InlineActionButtonProps): JSX.Element {
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
