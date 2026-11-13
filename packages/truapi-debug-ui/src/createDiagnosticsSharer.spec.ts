// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createDeferred } from '@dotli/shared';
import { createDiagnosticsSharer } from './createDiagnosticsSharer.js';
import { DIAGNOSTICS_SNAPSHOT as SNAPSHOT, fakeDiagnosticsSource } from './testing/fakeDiagnosticsSource.js';
import { recordShareReports } from './testing/recordShareReports.js';

describe('the Share diagnostic button', () => {
  it('As a dotli developer, I click Share diagnostic again while the report builds and one issue opens with the button busy until then', async () => {
    // Given
    recordShareReports();
    const built = createDeferred<string>();
    const source = fakeDiagnosticsSource({ report: () => built.promise });
    const busy: boolean[] = [];
    const sharer = createDiagnosticsSharer({ source });
    sharer.busy.listen(value => busy.push(value));

    // When
    const first = sharer.share(SNAPSHOT);
    const second = sharer.share(SNAPSHOT);

    // Then
    expect(busy).toEqual([true]);

    // When
    built.resolve('Site: app.dot.li');
    await Promise.all([first, second]);

    // Then
    expect(source.report).toHaveBeenCalledTimes(1);
    expect(source.openIssue).toHaveBeenCalledTimes(1);
    expect(busy).toEqual([true, false]);
  });

  it('As a dotli developer, I click after a share has ended and it shares again, even when that share failed', async () => {
    // Given
    recordShareReports();
    const source = fakeDiagnosticsSource();
    source.report.mockRejectedValueOnce(new Error('permissions read failed'));
    const sharer = createDiagnosticsSharer({ source });
    await sharer.share(SNAPSHOT);

    // When
    await sharer.share(SNAPSHOT);

    // Then
    expect(source.report).toHaveBeenCalledTimes(2);
    expect(source.openIssue).toHaveBeenCalledTimes(1);
  });
});
