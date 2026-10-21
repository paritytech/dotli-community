// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { Rolldown } from 'vite';
import { bundleClassicScript, classicScriptOf, inlineScriptFile } from './inline-script.js';

describe('inlineScriptFile', () => {
  it('As a dotli developer, I mark a module for inlining with the inline-script query', () => {
    // Given
    const ids = ['/src/head/theme.ts?inline-script', '/src/head/theme.ts', '/src/head/theme.ts?raw'];

    // When
    const files = ids.map(inlineScriptFile);

    // Then
    expect(files).toEqual(['/src/head/theme.ts', null, null]);
  });
});

describe('classicScriptOf', () => {
  it('As a dotli developer, I fail the build when a script would need more than its one inline tag', () => {
    // Given a bundle that also emitted an asset
    const output = [
      { type: 'chunk', fileName: 'theme.js', code: '', moduleIds: [] },
      { type: 'asset', fileName: 'theme.css', source: '' },
    ] as unknown as Rolldown.OutputChunk[];

    // When
    const pick = (): unknown => classicScriptOf('theme.ts', output);

    // Then
    expect(pick).toThrow('theme.ts must bundle to one script, got: theme.js, theme.css');
  });

  it('As a dotli developer, I fail the build when a script holds text that would end its inline tag', () => {
    // Given
    const output = [
      { type: 'chunk', fileName: 'banner.js', code: 'document.write("</script>")', moduleIds: [] },
    ] as unknown as Rolldown.OutputChunk[];

    // When
    const pick = (): unknown => classicScriptOf('banner.ts', output);

    // Then
    expect(pick).toThrow('would end its inline tag early');
  });
});

describe('bundleClassicScript', () => {
  let dir: string;

  beforeEach(() => {
    // Real, since the bundler names modules by their resolved path.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'inline-script-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('As a dotli developer, I get a module and its imports as one script that runs on its own', async () => {
    // Given an entry that imports a helper
    writeFileSync(
      join(dir, 'mark.ts'),
      'export function mark(page: { marks: string[] }, name: string): void { page.marks.push(name); }\n',
    );
    writeFileSync(
      join(dir, 'entry.ts'),
      "import { mark } from './mark.js';\ndeclare const page: { marks: string[] };\nmark(page, 'ran');\n",
    );

    // When it is bundled and run as a classic script, with nothing but its global
    const script = await bundleClassicScript(join(dir, 'entry.ts'), 'es2022');
    const page = { marks: [] as string[] };
    runInContext(script.code, createContext({ page }));

    // Then it ran the helper, and it names both modules for the rebuild
    expect(page.marks).toEqual(['ran']);
    expect(script.code).not.toMatch(/\bimport\b|\bexport\b/);
    expect(script.modules.sort()).toEqual([join(dir, 'entry.ts'), join(dir, 'mark.ts')].sort());
  });
});
