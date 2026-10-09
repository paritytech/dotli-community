// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Declared so dot access passes `noPropertyAccessFromIndexSignature`. Vite inlines only dot reads, a bracketed read
// stays a runtime lookup and keeps the code behind it from being dropped.

interface ImportMetaEnv {
  readonly VITE_APP_DEBUG?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_COMMIT_SHA?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_DESKTOP_DOWNLOAD_URL?: string;
  readonly VITE_METRICS?: string;
  readonly VITE_NETWORKS?: string;
  readonly VITE_RESOLUTION_SAMPLE_RATE?: string;
  readonly VITE_RUNTIME_NETWORK_CONFIG?: string;
  readonly VITE_SANDBOX_CHECKER?: string;
  readonly VITE_SENTRY_DSN?: string;
}
