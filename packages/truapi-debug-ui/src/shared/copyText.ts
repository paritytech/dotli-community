// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createReporter, defineCount } from '@dotli/metrics';
import type { PanelEffects } from '../panelEffects.js';

const report = createReporter({ flow: 'ui' });

/**
 * A clipboard write the debug panel's copy controls could not make, mostly the browser's refusal. Tagged `outcome`
 * (error) and `reason` (the error's name), as the control then shows a cross.
 */
const debugPanelCopyMetric = defineCount<'error'>('debug_panel.copy');

export type CopyOutcome = 'copied' | 'failed';

const COPY_STATUS: Readonly<Record<CopyOutcome, string>> = { copied: 'Copied', failed: 'Copy failed' };

/**
 * Writes `text` to the clipboard and says how it went, never rejecting. A refusal is the browser's policy, which the
 * control shows, so it is reported as expected rather than as a fault.
 */
export function copyText(writeClipboard: PanelEffects['writeClipboard'], text: string): Promise<CopyOutcome> {
  return writeClipboard(text).then(
    (): CopyOutcome => 'copied',
    (error: unknown): CopyOutcome => {
      report.expected(error, { step: 'debug_panel_copy', metric: debugPanelCopyMetric });
      return 'failed';
    },
  );
}

/** What a copy control says when it is done, shown and spoken, or nothing before an outcome. Never throws. */
export function formatCopyStatus(outcome: CopyOutcome | null): string {
  return outcome === null ? '' : COPY_STATUS[outcome];
}
