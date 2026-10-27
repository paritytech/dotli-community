// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink, type Flow } from '../captureException.js';

export type RecordedCapture = {
  /** The flow the page reported the failure under. */
  flow: Flow;
  /** The step the page reported the failure under. */
  step: string;
  /** The tags the page passed, undefined when it passed none. */
  tags: Record<string, string> | undefined;
};

type Params = {
  /** Given the restore of the sink bound before, to run when the test finishes, such as the runner's `onTestFinished`. */
  onFinished: (restore: () => void) => void;
  /** Each captured error is pushed here when given. */
  errors?: unknown[];
};

/**
 * Records each captured exception's flow, step and tags, until `onFinished` puts back the sink bound before. Each captured
 * error is also pushed to `errors` when given.
 */
export function recordCaptures({ onFinished, errors }: Params): RecordedCapture[] {
  const captured: RecordedCapture[] = [];
  onFinished(
    bindCaptureSink({
      exception: (error, context) => {
        captured.push({ flow: context.flow, step: context.step, tags: context.tags });
        errors?.push(error);
      },
      expected: () => undefined,
    }),
  );
  return captured;
}
