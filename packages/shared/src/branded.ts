// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** A `Value` the compiler tells apart from other values of its base type by `Name`, made only by its constructor. */
export type Branded<Value, Name extends string> = Value & { readonly __brand: Name };
