// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ApiStoppedError, isApiStoppedError } from './apiStoppedError.js';

describe('isApiStoppedError', () => {
  it.each([
    ["the resolver's own error", new ApiStoppedError()],
    ['one with its cause', new ApiStoppedError(new Error('ChainHead stopped'))],
    ['a copy rebuilt under its name', Object.assign(new Error('Chain transport halted'), { name: 'ApiStoppedError' })],
  ])('As the host, I check %s and it reads as a stopped chain', (_name, error) => {
    // Given the row's error, named as a stopped follow, from the table

    // When it is checked
    const stopped = isApiStoppedError(error);

    // Then it reads as a stopped chain
    expect(stopped).toBe(true);
  });

  it.each([
    ['an error with its text and another name', new Error('chainHead follow stopped')],
    ['a plain object with its name', { name: 'ApiStoppedError' }],
    ['its name as a string', 'ApiStoppedError'],
    ['no error', undefined],
  ])('As the host, I check %s and it does not read as a stopped chain', (_name, error) => {
    // Given the row's value, which is not an error under that name, from the table

    // When it is checked
    const stopped = isApiStoppedError(error);

    // Then it does not read as a stopped chain
    expect(stopped).toBe(false);
  });
});
