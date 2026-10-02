// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import s from './ChatActionButton.module.css';

/** How much a chat action button stands out: filled, tinted, or bare text. */
export type ChatActionButtonVariant = 'primary' | 'secondary' | 'text';

export interface ChatActionButtonProps {
  variant: ChatActionButtonVariant;
  /** Pulses while the app works on the action. A loading button is disabled. */
  loading?: boolean;
  disabled?: boolean;
  /** Inline style, for the layout modifiers of a product's render tree. */
  style?: JSX.CSSProperties;
  /** A class of the consumer's own, for placement (margins, size). */
  class?: string;
  /** Rendered as `data-testid`. */
  testId?: string;
  onClick: () => void;
  children: JSX.Element;
}

/**
 * A button inside a chat message: an action under an app's message, or a
 * button in its custom render tree.
 *
 * The variant and the loading state are on the element as `data-variant`
 * and `data-loading`.
 */
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
