// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { scopedClassName } from '../src/css-modules.js';

const FILE = '/repo/packages/ui/src/components/primitives/Spinner.module.css';

describe('scopedClassName', () => {
  it('As a developer, a dev class name reads as the module, the class and a short hash', () => {
    expect(scopedClassName('spinner', FILE, false)).toMatch(/^Spinner_spinner_[A-Za-z0-9_-]{4}$/);
  });

  it('As a user, a production class name is a short valid identifier', () => {
    expect(scopedClassName('spinner', FILE, true)).toMatch(/^_[A-Za-z0-9_-]{6}$/);
  });

  it('As a build, the same class in the same file always gets the same name', () => {
    expect(scopedClassName('spinner', FILE, true)).toBe(scopedClassName('spinner', FILE, true));
  });

  it('As a build, the same class in two files gets two names', () => {
    const other = FILE.replace('Spinner', 'Other');
    expect(scopedClassName('root', FILE, true)).not.toBe(scopedClassName('root', other, true));
  });

  it('As a build, a query string on the module id does not change the name', () => {
    expect(scopedClassName('spinner', `${FILE}?used`, false)).toBe(scopedClassName('spinner', FILE, false));
  });
});
