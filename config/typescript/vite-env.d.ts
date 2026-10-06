// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The deployment variables the apps read through `import.meta.env`. Declaring
// them keeps dot access legal under `noPropertyAccessFromIndexSignature`, and
// dot access is what Vite replaces with a literal at build time: a bracketed
// read survives as a lookup, and the code behind it is never dropped.

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
