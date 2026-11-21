// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, onTestFinished } from 'vitest';
import { recordReports } from '@dotli/metrics/testing';
import { startKeyboardPin } from './startKeyboardPin.js';

describe('startKeyboardPin', () => {
  it('As a visitor whose landing markup lacks a page box, I see the missing box reported rather than thrown', () => {
    // Given
    const reports = recordReports({ onFinished: onTestFinished });
    const document = { querySelector: () => null };

    // When
    startKeyboardPin({ document });

    // Then
    expect(reports.exceptions).toMatchObject([{ step: 'find_boxes' }]);
  });
});
