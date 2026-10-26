// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindLogSink, type LogEntry, type LogLevel } from '../log.js';

/** One line the shared log wrote. */
export type LogLine = LogEntry;

type Params = {
  onFinished: (restore: () => void) => void;
  level?: LogLevel;
};

/**
 * Every line the shared log writes, at `level` when one is given, until `onFinished` puts back the sink bound before.
 * A spec passes vitest's `onTestFinished`.
 */
export function recordLog({ onFinished, level }: Params): LogLine[] {
  const lines: LogLine[] = [];
  onFinished(
    bindLogSink({
      emit: entry => {
        if (level === undefined || entry.level === level) {
          lines.push(entry);
        }
      },
    }),
  );
  return lines;
}
