<!--
Copyright 2026 Parity Technologies (UK) Ltd.
SPDX-License-Identifier: AGPL-3.0-only
-->

# Changelog

All notable changes to `@dotli/host-cli`. This package versions
independently of the dotli app (see README, "Versioning and releases").

## 0.1.0 (unreleased)

Initial release: a terminal host for `@parity/truapi-host` 0.6.0.

- The full typed platform callback surface (12 groups), bridged through the
  package's own generated adapter (no hand-written SCALE), including the
  RFC-0026 `supportedChains` advertisement (role-mapped from the endpoint
  map) and confirm prompts for the RFC-0023 `SignVrf` and
  `StatementStoreProductSign` reviews.
- In-process wasm boot (`initSync`) and an in-process loopback wire for
  same-process products.
- Terminal presenter: pairing QR (offline, instant), progress through the
  silent `Authenticating` window, deliberately modest confirm prompts that
  defer content verification to the paired wallet, auto-deny on non-TTY.
- Owner-only (0600) JSON file storage for core and product state; product
  storage cleared on logout and on identity change.
- Chain-connection pool keyed by genesis hash: per-lease request-id
  rewriting, subscription routing, capped leases per socket,
  order-preserving delivery.
- `serializeOperationStarts`: the load-bearing product-side shim for the
  chain-head operation-ordering hazard.
- `explainProductError` / `isProbableSsoTimeout`: translate the untyped 180s
  SSO timeout into actionable guidance.
