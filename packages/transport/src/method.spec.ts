// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResultPayload } from 'scale-ts';
import { describe, expectTypeOf, it } from 'vitest';
import type { CallError } from './callError.js';
import type { DomainError, MethodTypes } from './method.js';
import type { changes, ended, owner, reload, status } from './testing/methodFixtures.js';

describe('MethodTypes and DomainError', () => {
  it('As a schema author, I read what each side of a method sends, and its own error, from the method', () => {
    // Given
    type Owner = MethodTypes<typeof owner>;
    type Changes = MethodTypes<typeof changes>;
    type FrameFailure = { tag: 'fatal'; value: undefined } | { tag: 'released'; value: undefined };

    // Then
    expectTypeOf<Owner>().toEqualTypeOf<{
      request: { label: string };
      response: ResultPayload<string, CallError<undefined>>;
    }>();
    expectTypeOf<Changes>().toEqualTypeOf<{
      start: { label: string };
      receive: string;
      interrupt: undefined;
      stop: undefined;
    }>();
    expectTypeOf<MethodTypes<typeof status>['interrupt']>().toEqualTypeOf<FrameFailure>();
    expectTypeOf<MethodTypes<typeof ended>['interrupt']>().toEqualTypeOf<
      ResultPayload<undefined, CallError<FrameFailure>>
    >();
    expectTypeOf<DomainError<typeof status>>().toEqualTypeOf<FrameFailure>();
    expectTypeOf<DomainError<typeof ended>>().toEqualTypeOf<ResultPayload<undefined, CallError<FrameFailure>>>();
    expectTypeOf<DomainError<typeof reload>>().toEqualTypeOf<FrameFailure>();
    expectTypeOf<DomainError<typeof owner>>().toBeUndefined();
  });
});
