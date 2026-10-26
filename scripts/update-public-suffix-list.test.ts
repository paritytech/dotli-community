// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkSections } from './update-public-suffix-list.ts';

const ICANN = '// ===BEGIN ICANN DOMAINS===\ncom\n// ===END ICANN DOMAINS===\n';
const PRIVATE = '// ===BEGIN PRIVATE DOMAINS===\ngithub.io\n// ===END PRIVATE DOMAINS===\n';

describe('checkSections', () => {
  it('As a dotli maintainer refreshing the Public Suffix List, I accept a body with both sections', () => {
    // Given a body with the ICANN and private sections
    const body = ICANN + PRIVATE;

    // When its sections are checked
    const check = () => {
      checkSections(body);
    };

    // Then it passes
    assert.doesNotThrow(check);
  });

  it('As a dotli maintainer refreshing the Public Suffix List, I refuse a body without the private section', () => {
    // Given a body with the ICANN section only
    const body = ICANN;

    // When its sections are checked
    const check = () => {
      checkSections(body);
    };

    // Then it is refused
    assert.throws(check, /PRIVATE DOMAINS/);
  });

  it('As a dotli maintainer refreshing the Public Suffix List, I refuse a body cut off inside the private section', () => {
    // Given a body whose download stopped before the private section ends
    const body = ICANN + '// ===BEGIN PRIVATE DOMAINS===\ngithub.io\n';

    // When its sections are checked
    const check = () => {
      checkSections(body);
    };

    // Then it is refused
    assert.throws(check, /END PRIVATE DOMAINS/);
  });

  it('As a dotli maintainer refreshing the Public Suffix List, I refuse a body without the ICANN section', () => {
    // Given a page that is not the list, such as an error page
    const body = '<html>Service unavailable</html>';

    // When its sections are checked
    const check = () => {
      checkSections(body);
    };

    // Then it is refused
    assert.throws(check, /ICANN DOMAINS/);
  });
});
