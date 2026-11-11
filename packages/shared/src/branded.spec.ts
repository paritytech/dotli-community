// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expectTypeOf, it } from 'vitest';
import type { Branded } from './branded.js';

describe('Branded', () => {
  it('As a module author, I brand a plain value and the compiler refuses a plain one where the brand is expected', () => {
    // Given
    type AccountId = Branded<string, 'AccountId'>;
    type SessionId = Branded<string, 'SessionId'>;

    // Then
    expectTypeOf<string>().not.toExtend<AccountId>();
    expectTypeOf<SessionId>().not.toExtend<AccountId>();
  });
});
