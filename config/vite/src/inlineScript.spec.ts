// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import type { Rolldown } from 'vite';
import { bundleClassicScript, toClassicScript, getInlineScriptFile } from './inlineScript.js';

/** A bundler output file with only the fields the script conversion reads. */
type OutputFile =
  | { type: 'chunk'; fileName: string; code: string; moduleIds: string[] }
  | { type: 'asset'; fileName: string; source: string };

/** Returns `files` typed as the bundler's output, with only the fields the script conversion reads. */
function toBundlerOutput(files: OutputFile[]): (Rolldown.OutputChunk | Rolldown.OutputAsset)[] {
  // The conversion reads only each file's type, name, code and modules, so the bundler's other fields stay out.
  return files as (Rolldown.OutputChunk | Rolldown.OutputAsset)[];
}

describe('getInlineScriptFile', () => {
  it('As a dotli developer, I add the inline-script query to a module id and only that id is marked for inlining', () => {
    // Given
    const ids = ['/src/head/theme.ts?inline-script', '/src/head/theme.ts', '/src/head/theme.ts?raw'];

    // When
    const files = ids.map(getInlineScriptFile);

    // Then
    expect(files).toEqual(['/src/head/theme.ts', null, null]);
  });
});

describe('toClassicScript', () => {
  it('As a dotli developer, I inline a script that would need more than its one inline tag and the build fails', () => {
    // Given a bundle that also emitted an asset
    const output = toBundlerOutput([
      { type: 'chunk', fileName: 'theme.js', code: '', moduleIds: [] },
      { type: 'asset', fileName: 'theme.css', source: '' },
    ]);

    // When
    const pick = (): unknown => toClassicScript('theme.ts', output);

    // Then
    expect(pick).toThrow('theme.ts must bundle to one script, got: theme.js, theme.css');
  });

  it('As a dotli developer, I inline a script holding text that would end its inline tag and the build fails', () => {
    // Given
    const output = toBundlerOutput([
      { type: 'chunk', fileName: 'banner.js', code: 'document.write("</script>")', moduleIds: [] },
    ]);

    // When
    const pick = (): unknown => toClassicScript('banner.ts', output);

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

  it('As a dotli developer, I bundle a module that imports a helper and get one classic script that runs on its own', async () => {
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
    const page: { marks: string[] } = { marks: [] };
    runInContext(script.code, createContext({ page }));

    // Then it ran the helper, and it names both modules for the rebuild
    expect(page.marks).toEqual(['ran']);
    expect(script.code).not.toMatch(/\bimport\b|\bexport\b/);
    expect(script.modules.sort()).toEqual([join(dir, 'entry.ts'), join(dir, 'mark.ts')].sort());
  });
});
