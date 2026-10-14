// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { reportListener } from '@dotli/metrics';
import { createListenerSet, type ListenerSet } from '@dotli/shared';

/** The listeners of one protocol stream. A listener that throws is reported under `stream`, and the others still hear. */
export function protocolListeners<T>(stream: string): ListenerSet<T> {
  return createListenerSet<T>({ onListenerError: reportListener('protocol', `protocol.${stream}`) });
}
