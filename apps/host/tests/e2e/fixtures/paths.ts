// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { resolve } from 'node:path';

// The once-per-run pairing artifacts, shared by globalSetup, the worker fixture and globalTeardown. Gitignored.
export const AUTH_DIR = resolve(import.meta.dirname, '..', '.auth');
export const STATE_FILE = resolve(AUTH_DIR, 'state.json');
export const SESSION_FILE = resolve(AUTH_DIR, 'session.json');
// Persists across runs so local runs reuse one test account instead of burning allowance on a new username.
export const SIGNING_HOST_STATE_DIR = resolve(AUTH_DIR, 'signing-host');

export interface PersistedSession {
  pid: number;
  username: string;
  network: string;
  basePath: string;
}
