// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isSmoldotEvent } from './isSmoldotEvent.js';

describe('isSmoldotEvent', () => {
  it.each([
    {
      origin: 'a smoldot CrashError',
      event: {
        exception: {
          values: [{ type: 'CrashError', value: 'anything' }],
        },
      },
    },
    {
      origin: 'a Rust panic from the smoldot repo',
      event: {
        exception: {
          values: [
            {
              type: 'Error',
              value:
                'panicked at /__w/smoldot/smoldot/light-base/src/json_rpc_service/background.rs:4713:38:\ncalled `Option::unwrap()` on a `None` value',
            },
          ],
        },
      },
    },
    {
      origin: 'an error thrown inside the Bun-versioned smoldot package',
      event: {
        exception: {
          values: [
            {
              type: 'Error',
              value: 'something else',
              stacktrace: {
                frames: [
                  {
                    filename: 'app:///node_modules/.bun/smoldot@2.0.40/node_modules/smoldot/dist/mjs/public-types.js',
                  },
                ],
              },
            },
          ],
        },
      },
    },
    {
      origin: 'an error from a smoldot frame known only by its abs_path',
      event: {
        exception: {
          values: [
            {
              stacktrace: {
                frames: [{ abs_path: '/vendor/smoldot/dist/mjs/client.js' }],
              },
            },
          ],
        },
      },
    },
  ])('As an operator, I read $origin and see it tagged as a smoldot event', ({ event }) => {
    // When
    const tagged = isSmoldotEvent(event);

    // Then
    expect(tagged).toBe(true);
  });

  it('As an operator, I read an unrelated browser error and see it left untagged', () => {
    // Given
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'foo')",
            stacktrace: {
              frames: [{ filename: 'app:///src/main.ts' }, { filename: 'app:///node_modules/react/index.js' }],
            },
          },
        ],
      },
    };

    // When
    const tagged = isSmoldotEvent(event);

    // Then
    expect(tagged).toBe(false);
  });

  it('As an operator, I read an event without an exception and see it left untagged', () => {
    // When
    const tagged = [isSmoldotEvent({}), isSmoldotEvent({ exception: { values: [] } })];

    // Then
    expect(tagged).toEqual([false, false]);
  });
});
