// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindLogSink, type LogLevel } from '../log.js';

/** One line the shared log wrote. */
export interface LogLine {
  level: LogLevel;
  message: string;
  attrs: Record<string, unknown> | undefined;
  args: unknown[] | undefined;
}

/**
 * Every line the shared log writes, at `level` when one is given, until `onFinished` puts back the sink bound before.
 * A spec passes vitest's `onTestFinished`.
 */
export function recordLog(options: { onFinished: (restore: () => void) => void; level?: LogLevel }): LogLine[] {
  const lines: LogLine[] = [];
  options.onFinished(
    bindLogSink({
      emit: (level, message, attrs, args) => {
        if (options.level === undefined || level === options.level) {
          lines.push({ level, message, attrs, args });
        }
      },
    }),
  );
  return lines;
}
