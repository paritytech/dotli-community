// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportExpected, spans as S } from '@dotli/metrics';
import type { PanelEffects } from '../effects.js';

export type CopyOutcome = 'copied' | 'failed';

/**
 * Writes `text` to the clipboard and says how it went. A refusal is the browser's policy, which the control shows, so
 * it is reported as expected rather than as a fault.
 */
export function copyText(writeClipboard: PanelEffects['writeClipboard'], text: string): Promise<CopyOutcome> {
  return writeClipboard(text).then(
    (): CopyOutcome => 'copied',
    (err: unknown): CopyOutcome => {
      reportExpected(err, { flow: 'ui', step: 'debug_panel_copy', metric: S.DEBUG_PANEL_COPY });
      return 'failed';
    },
  );
}
