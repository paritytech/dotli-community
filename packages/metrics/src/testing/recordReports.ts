// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { bindCaptureSink } from '../captureException.js';

/** One failure the code under test reported. */
export type RecordedReport = {
  /** The step it was reported under. */
  step: string;
  /** The error it was reported with. */
  error: unknown;
  /** The tags it carried, undefined when it carried none. */
  tags: Record<string, string> | undefined;
};

/** The failures the code under test reported, in order. */
export type RecordedReports = {
  /** Each failure captured as an issue. */
  exceptions: RecordedReport[];
  /** Each expected failure recorded as a breadcrumb. */
  expected: RecordedReport[];
};

type Params = {
  /** Given the restore of the sink bound before, to run when the test finishes, such as the runner's `onTestFinished`. */
  onFinished: (restore: () => void) => void;
};

/**
 * Records each reported failure's step, error and tags, never its flow, until `onFinished` puts back the sink bound
 * before. A spec asserts the steps with a partial match.
 *
 * @example
 * const reports = recordReports({ onFinished: onTestFinished });
 * expect(reports.exceptions).toMatchObject([{ step: 'qr_render' }]);
 */
export function recordReports({ onFinished }: Params): RecordedReports {
  const reports: RecordedReports = { exceptions: [], expected: [] };
  onFinished(
    bindCaptureSink({
      exception: (error, context) => {
        reports.exceptions.push({ step: context.step, error, tags: context.tags });
      },
      expected: (error, context) => {
        reports.expected.push({ step: context.step, error, tags: undefined });
      },
    }),
  );
  return reports;
}
