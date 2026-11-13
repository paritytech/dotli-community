// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { ModalView } from '../../page/state/createModals.js';
import { getCloseAnswer, getScrimAnswer } from './promptAnswer.js';

type Choice = 'deny' | 'allow' | 'once' | 'dismissed';

const passwordView: ModalView<'cancel' | 'unlock'> = {
  title: 'Encrypted Content',
  fields: [],
  input: { kind: 'password', placeholder: 'Password' },
  buttons: [
    { label: 'Cancel', variant: 'cancel', result: 'cancel' },
    { label: 'Unlock', variant: 'primary', result: 'unlock' },
  ],
  dismissOnBackdrop: false,
};

describe('prompt answers', () => {
  it('As a dotli user, I press the scrim, Escape or the close button on a dismissable prompt and each answers it with its dismissal', () => {
    // Given
    const view = buildPermissionView();

    // When
    const scrim = getScrimAnswer(view);
    const close = getCloseAnswer(view);

    // Then
    expect(scrim).toBe('dismissed');
    expect(close).toBe('dismissed');
  });

  it('As a dotli user, I press the scrim or Escape on a prompt that must be answered and it stays unanswered', () => {
    // Given
    const permissionView = buildPermissionView({ dismissOnBackdrop: false });

    // When
    const passwordScrim = getScrimAnswer(passwordView);
    const permissionScrim = getScrimAnswer(permissionView);

    // Then
    expect(passwordScrim).toBeUndefined();
    expect(permissionScrim).toBeUndefined();
  });

  it('As a phone user, I press the close button on a prompt that must be answered and it answers with its Cancel', () => {
    // When
    const close = getCloseAnswer(passwordView);

    // Then
    expect(close).toBe('cancel');
  });

  it('As a phone user, I press the close button on a scrim-dismissable prompt with no scrim answer and it answers with its danger reject', () => {
    // Given
    const { dismissResult: _unused, ...view } = buildPermissionView();

    // When
    const scrim = getScrimAnswer(view);
    const close = getCloseAnswer(view);

    // Then
    expect(scrim).toBeUndefined();
    expect(close).toBe('deny');
  });
});

function buildPermissionView(overrides: Partial<ModalView<Choice>> = {}): ModalView<Choice> {
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
    ...overrides,
  };
}
