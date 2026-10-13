// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Every unit test starts on its own empty mode store, so a network or backend stored on the machine running the tests
// never reaches a spec, and no spec leaks one into the next. A spec that needs stored settings binds its own.

import { beforeEach } from 'vitest';
import { configureModeStorage } from '@dotli/config';
import { memoryModeStorage } from '@dotli/config/testing';

beforeEach(() => configureModeStorage(memoryModeStorage()));
