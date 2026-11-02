// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindLogSink } from '@dotli/shared';

/** Collects the warnings logged while `run` runs, then puts back the sink bound before. */
export function collectWarningsDuring(run: () => void): string[] {
  const warnings: string[] = [];
  const restore = bindLogSink({
    emit: ({ level, message }) => {
      if (level === 'warn') {
        warnings.push(message);
      }
    },
  });
  try {
    run();
  } finally {
    restore();
  }
  return warnings;
}
