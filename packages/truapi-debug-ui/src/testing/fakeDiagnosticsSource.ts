// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { vi, type Mock } from 'vitest';
import type { DiagnosticsSource } from '../host.js';

/** The page's report and issue opener, each recording its calls. */
export type FakeDiagnosticsSource = {
  /** Resolves or rejects as the test's `report` does, a fixed report unless the test gave one. */
  report: Mock<DiagnosticsSource['report']>;
  /** Opens nothing. Never throws unless a test makes it. */
  openIssue: Mock<DiagnosticsSource['openIssue']>;
};

type Params = {
  report?: DiagnosticsSource['report'];
};

/** The page's report and issue opener as a test sets them, each recording its calls. Never throws. */
export function fakeDiagnosticsSource({
  report = () => Promise.resolve('Site: app.dot.li\nPackages:\n  smoldot: 0.3.1'),
}: Params = {}): FakeDiagnosticsSource {
  return { report: vi.fn(report), openIssue: vi.fn<DiagnosticsSource['openIssue']>() };
}
