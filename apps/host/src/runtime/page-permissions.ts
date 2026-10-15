// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one route to the core's permission store. The product frame fills it with each connection it opens.

import { createPermissionAuthorizations, type PermissionAuthorizations } from './permissions.js';

export const pagePermissions: PermissionAuthorizations = createPermissionAuthorizations();
