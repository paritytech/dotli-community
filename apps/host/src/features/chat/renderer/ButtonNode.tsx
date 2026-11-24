// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSX } from '@solidjs/web';
import type { ButtonVariant } from '@parity/truapi';
import { InlineActionButton, type InlineActionButtonVariant } from '../InlineActionButton.js';
import { modifierStyle } from './customStyles.js';
import type { CustomActionHandler, KindValue } from './types.js';

/** A product's button, which reports its click action. Primary when the product names no variant. */
export function ButtonNode(props: { value: KindValue<'Button'>; onAction: CustomActionHandler }): JSX.Element {
  return (
    <InlineActionButton
      variant={buttonVariant(props.value.props.variant)}
      loading={props.value.props.loading === true}
      // A button with nothing to report draws as disabled, so it never looks pressable.
      disabled={props.value.props.enabled === false || props.value.props.clickAction === undefined}
      style={modifierStyle(props.value.modifiers)}
      testId="chat-custom-btn"
      onClick={() => {
        const action = props.value.props.clickAction;
        if (action !== undefined) {
          props.onAction(action);
        }
      }}
    >
      {props.value.props.text}
    </InlineActionButton>
  );
}

function buttonVariant(variant: ButtonVariant | undefined): InlineActionButtonVariant {
  if (variant === 'Primary' || variant === undefined) {
    return 'primary';
  }
  return variant === 'Secondary' ? 'secondary' : 'text';
}
