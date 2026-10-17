// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The functional suite's global setup bundles this into the classic script that fakes and recorders load in a page,
// where it is the global `dotliWire`.

export { ProtocolFatalError, ProtocolInitFailedError } from '@dotli/protocol';
export { createServingTransport, createWindowProvider, describeWireMessage } from '@dotli/protocol/testing';
