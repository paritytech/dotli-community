// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSections } from './updatePublicSuffixList.ts';

const ICANN = '// ===BEGIN ICANN DOMAINS===\ncom\n// ===END ICANN DOMAINS===\n';
const PRIVATE = '// ===BEGIN PRIVATE DOMAINS===\ngithub.io\n// ===END PRIVATE DOMAINS===\n';

/** Bodies the check refuses, each with what it lacks and the section its error names. */
const REFUSED_BODIES = [
  { lack: 'without the private section', body: ICANN, error: /PRIVATE DOMAINS/ },
  {
    lack: 'cut off inside the private section',
    body: ICANN + '// ===BEGIN PRIVATE DOMAINS===\ngithub.io\n',
    error: /END PRIVATE DOMAINS/,
  },
  {
    lack: 'without the ICANN section, such as an error page',
    body: '<html>Service unavailable</html>',
    error: /ICANN DOMAINS/,
  },
];

describe('checkSections', () => {
  it('As a dotli maintainer refreshing the Public Suffix List, I check a body with both sections and it is accepted', () => {
    // Given a body with the ICANN and private sections
    const body = ICANN + PRIVATE;

    // When its sections are checked
    const check = () => {
      checkSections(body);
    };

    // Then it passes
    assert.doesNotThrow(check);
  });

  for (const { lack, body, error } of REFUSED_BODIES) {
    it(`As a dotli maintainer refreshing the Public Suffix List, I check a body ${lack} and it is refused`, () => {
      // Given the row's body and the section its error names

      // When its sections are checked
      const check = () => {
        checkSections(body);
      };

      // Then it is refused
      assert.throws(check, error);
    });
  }
});
