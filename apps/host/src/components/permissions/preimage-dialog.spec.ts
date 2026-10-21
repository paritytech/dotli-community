// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { permissionIcon } from './permission-icons.js';
import { preimageSubmitDialog } from './preimage-dialog.js';

describe('preimage submit dialog', () => {
  it('As a dotli user, I see which app asks and the data size under the upload glyph', () => {
    // When
    const view = preimageSubmitDialog({ app: 'myapp.dot', dataSize: 2048 });

    // Then
    expect(view.title).toBe('Submit Preimage');
    expect(view.icon).toBe(permissionIcon('PreimageSubmit'));
    expect(view.fields).toEqual([
      { label: 'Application', value: 'myapp.dot' },
      { label: 'Data size', value: '2 kB' },
    ]);
  });

  it('As a dotli user, a small preimage shows its bytes, and only Cancel or Allow answers it', () => {
    // When
    const view = preimageSubmitDialog({ app: 'myapp.dot', dataSize: 512 });

    // Then
    expect(view.fields.at(-1)).toEqual({ label: 'Data size', value: '512 B' });
    expect(view.buttons.map(b => [b.label, b.variant])).toEqual([
      ['Cancel', 'cancel'],
      ['Allow', 'primary'],
    ]);
    expect(view.dismissOnBackdrop).toBe(false);
  });
});
