// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ModalView } from '@dotli/ui-core';
import { closeAnswer, scrimAnswer } from './prompt-answer.js';

type Choice = 'deny' | 'allow' | 'once' | 'dismissed';

function permissionLike(overrides: Partial<ModalView<Choice>> = {}): ModalView<Choice> {
  return {
    title: 'Permission Request',
    fields: [],
    buttons: [
      { label: 'Deny', variant: 'danger', result: 'deny' },
      { label: 'Always allow', variant: 'secondary', result: 'allow' },
      { label: 'Allow once', variant: 'primary', result: 'once' },
    ],
    dismissOnBackdrop: true,
    dismissResult: 'dismissed',
    fallbackResult: 'dismissed',
    ...overrides,
  };
}

const passwordView: ModalView<'cancel' | 'unlock'> = {
  title: 'Encrypted Content',
  fields: [],
  input: { kind: 'password', placeholder: 'Password' },
  buttons: [
    { label: 'Cancel', variant: 'cancel', result: 'cancel' },
    { label: 'Unlock', variant: 'primary', result: 'unlock' },
  ],
  dismissOnBackdrop: false,
  fallbackResult: 'cancel',
};

describe('prompt answers', () => {
  it('As a dotli user, the scrim and Escape answer a dismissable prompt with its dismissal, and the close button too', () => {
    // Given
    const view = permissionLike();

    // When / Then
    expect(scrimAnswer(view)).toBe('dismissed');
    expect(closeAnswer(view)).toBe('dismissed');
  });

  it('As a dotli user, the scrim and Escape leave a prompt that must be answered alone', () => {
    // Given / When / Then
    expect(scrimAnswer(passwordView)).toBeUndefined();
    expect(scrimAnswer(permissionLike({ dismissOnBackdrop: false }))).toBeUndefined();
  });

  it('As a phone user, the close button on a prompt that must be answered answers it with its Cancel', () => {
    // Given / When / Then
    expect(closeAnswer(passwordView)).toBe('cancel');
  });

  it('As a phone user, the close button on a prompt with no Cancel and no scrim answer answers it with its danger reject', () => {
    // Given / When / Then
    expect(closeAnswer(permissionLike({ dismissOnBackdrop: false }))).toBe('deny');
  });

  it('As a phone user, the close button on a scrim-dismissable prompt with no scrim answer answers it with its danger reject', () => {
    // Given
    const { dismissResult: _unused, ...view } = permissionLike();

    // When / Then
    expect(scrimAnswer(view)).toBeUndefined();
    expect(closeAnswer(view)).toBe('deny');
  });
});
