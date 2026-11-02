// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one route to the core's permission store, and the one store of the product's permissions over it. The
// product frame fills the route with each connection it opens. Built here only and passed to the rest, so the frame,
// the store, the prompt and the diagnostics all reach the same registry.

import { createPermissionAuthorizations } from './createPermissionAuthorizations.js';
import { createProductPermissions, type ProductPermissions } from './state/productPermissions.js';
import { productState } from './state/productState.js';

/** The page's one registry of the connections that read and write product permissions. */
export const pagePermissions = createPermissionAuthorizations();

/** The permissions of the product on show, for the menu, the prompts and the frame. */
export const productPermissions: ProductPermissions = createProductPermissions({
  registry: pagePermissions,
  product: productState.store,
});
