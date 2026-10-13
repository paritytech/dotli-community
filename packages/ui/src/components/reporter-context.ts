// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext } from 'solid-js';
import type { Reporter } from '@dotli/ui-core';

/**
 * How the surfaces below report a failed render or preload. mountRoot provides it from its own option, an island
 * provides it itself. It has no default, so a surface rendered without one throws on its first render.
 */
export const ReporterContext = createContext<Reporter>();
