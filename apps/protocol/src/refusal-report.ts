// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How the protocol iframe reports a request its router refused, for operators reading logs and the rejection counts.

import { spans as S, type m } from '@dotli/metrics';

import type { FrameRefusal, FrameRoute } from './frame-router.js';

export interface RefusalReportDeps {
  warn: (...args: unknown[]) => void;
  count: typeof m.count;
}

const REFUSED_ROUTE_LABELS: Record<FrameRoute, string> = {
  auth: 'shared-auth ',
  mode: 'shared-mode ',
  wallet: 'local wallet ',
  chain: '',
};

export function createRefusalReporter({ warn, count }: RefusalReportDeps): (refusal: FrameRefusal) => void {
  return refusal => {
    const { route } = refusal;
    if (refusal.reason === 'origin') {
      warn(
        `[dot.li protocol] Rejected ${REFUSED_ROUTE_LABELS[route]}request from disallowed origin: ${refusal.origin}`,
      );
      if (route !== 'chain') {
        count(S.SHARED_STORAGE_REJECTED, { store: route, reason: 'origin' });
      }
      return;
    }
    if (route === 'auth' || route === 'mode') {
      count(S.SHARED_STORAGE_REJECTED, { store: route, reason: 'validation' });
      return;
    }
    // The host rebuilds this failure from the response and reports it.
    warn(`[dot.li protocol] ${refusal.request.method} failed`, refusal.error);
  };
}
