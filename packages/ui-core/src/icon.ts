// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An icon component, as a toast or dialog carries it. Typed here without Solid, which ui-core never imports, so what it
 * renders is `unknown`. Every icon the UI packages export fits it, and the view that renders the store draws it.
 */
export type IconComponent = (props: { size?: number | undefined }) => unknown;
