// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createReloadOffer } from './createReloadOffer.js';
import type { NotificationParams } from './createNotifier.js';

describe('createReloadOffer', () => {
  it('As a visitor after a deploy, I meet failures while the offer shows and get no second offer, and one after I close it offers again', () => {
    // Given
    const notices: NotificationParams[] = [];
    const offer = createReloadOffer({ notify: notice => notices.push(notice), reload: () => undefined });

    // When three failures land, I close the offer, and one more lands
    offer();
    offer();
    offer();
    const whileShowing = notices.length;
    notices[0]?.onDismiss?.();
    offer();

    // Then
    expect(whileShowing).toBe(1);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatchObject({ label: 'Asset failed to load', tone: 'err', dismissMs: 0 });
  });
});
