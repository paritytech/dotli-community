// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { excludeBrowserApiErrorsIntegration, isSmoldotEvent } from './sentry.js';

describe('excludeBrowserApiErrorsIntegration', () => {
  it('As a host user, my callbacks remain intact when Sentry starts', () => {
    // Given
    const defaults = [{ name: 'GlobalHandlers' }, { name: 'BrowserApiErrors' }, { name: 'Breadcrumbs' }];

    // When
    const integrations = excludeBrowserApiErrorsIntegration(defaults);

    // Then
    expect(integrations).toEqual([{ name: 'GlobalHandlers' }, { name: 'Breadcrumbs' }]);
    expect(defaults).toHaveLength(3);
  });
});

describe('isSmoldotEvent', () => {
  it('As an operator, I see a smoldot CrashError tagged as a smoldot event', () => {
    // When / Then
    expect(
      isSmoldotEvent({
        exception: {
          values: [{ type: 'CrashError', value: 'anything' }],
        },
      }),
    ).toBe(true);
  });

  it('As an operator, I see a Rust panic from the smoldot repo tagged as a smoldot event', () => {
    // When / Then
    expect(
      isSmoldotEvent({
        exception: {
          values: [
            {
              type: 'Error',
              value:
                'panicked at /__w/smoldot/smoldot/light-base/src/json_rpc_service/background.rs:4713:38:\ncalled `Option::unwrap()` on a `None` value',
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it('As an operator, I see an error thrown inside the Bun-versioned smoldot package tagged as a smoldot event', () => {
    // When / Then
    expect(
      isSmoldotEvent({
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
      }),
    ).toBe(true);
  });

  it('As an operator, I see an error from a smoldot frame known only by its abs_path tagged as a smoldot event', () => {
    // When / Then
    expect(
      isSmoldotEvent({
        exception: {
          values: [
            {
              stacktrace: {
                frames: [{ abs_path: '/vendor/smoldot/dist/mjs/client.js' }],
              },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it('As an operator, I see an unrelated browser error left untagged', () => {
    // When / Then
    expect(
      isSmoldotEvent({
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
      }),
    ).toBe(false);
  });

  it('As an operator, I see an event without an exception left untagged', () => {
    // When / Then
    expect(isSmoldotEvent({})).toBe(false);
    expect(isSmoldotEvent({ exception: { values: [] } })).toBe(false);
  });
});
