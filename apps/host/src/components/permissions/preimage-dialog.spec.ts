// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { permissionIcon } from '@dotli/ui-entities';
import { preimageSubmitDialog } from './preimage-dialog.js';

describe('preimage submit dialog', () => {
  it('As a dotli user, I see the data size under the upload glyph', () => {
    // When
    const view = preimageSubmitDialog(2048);

    // Then
    expect(view.title).toBe('Submit Preimage');
    expect(view.icon).toBe(permissionIcon('PreimageSubmit'));
    expect(view.fields).toEqual([{ label: 'Data size', value: '2 kB' }]);
  });

  it('As a dotli user, a small preimage shows its bytes, and only Cancel or Allow answers it', () => {
    // When
    const view = preimageSubmitDialog(512);

    // Then
    expect(view.fields).toEqual([{ label: 'Data size', value: '512 B' }]);
    expect(view.buttons.map(b => [b.label, b.variant])).toEqual([
      ['Cancel', 'cancel'],
      ['Allow', 'primary'],
    ]);
    expect(view.dismissOnBackdrop).toBe(false);
  });
});
