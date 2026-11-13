// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { browserBlockDialog } from './browserBlockDialog.js';
import { PERMISSION_CATALOG } from '../../runtime/permissionPolicy.js';

describe('browser block dialog', () => {
  it("As a dotli user, I see an app's permission blocked by my browser and can restrict it, retry or close the dialog", () => {
    // When
    const view = browserBlockDialog({ app: 'myapp.dot', permission: 'Camera', retried: false });

    // Then
    expect(view.fields).toEqual([
      { label: 'Application', value: 'myapp.dot' },
      { label: 'Permission', value: PERMISSION_CATALOG.Camera.description },
    ]);
    expect(view.buttons).toEqual([
      { label: 'Restrict access for product', variant: 'danger', result: 'restrict' },
      { label: 'Retry', variant: 'primary', result: 'retry' },
    ]);
    expect(view.dismissOnBackdrop).toBe(true);
    expect(view.dismissResult).toBe('dismissed');
  });

  it('As a dotli user, I retry while my browser still blocks it and the warning says so', () => {
    // When
    const first = browserBlockDialog({ app: 'myapp.dot', permission: 'Camera', retried: false });
    const again = browserBlockDialog({ app: 'myapp.dot', permission: 'Camera', retried: true });

    // Then
    expect(again.notice?.startsWith('Your browser still blocks it.')).toBe(true);
    expect(first.notice?.startsWith('Your browser still blocks it.')).toBe(false);
  });
});
