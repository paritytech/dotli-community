// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkPlanNames, formatReport, parsePlan, type Disk, type Tree } from './checkPlanNames.ts';

const TOP_LEVEL = new Set(['apps', 'packages', 'docs']);

const NO_BRANCHES = new Set<string>();

function createFakeTree(files: Record<string, string>): Tree {
  const isWordIn = (text: string, word: string): boolean =>
    new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`).test(text);
  return {
    hasPath: path => Object.keys(files).some(file => file === path || file.startsWith(`${path}/`)),
    readFile: path => files[path],
    listFilesWithWord: word =>
      Object.entries(files)
        .filter(([, text]) => isWordIn(text, word))
        .map(([file]) => file)
        .sort(),
    listFilesNamed: name =>
      Object.keys(files)
        .filter(file => file === name || file.endsWith(`/${name}`))
        .sort(),
  };
}

function createFakeDisk(ignored: Record<string, boolean>): Disk {
  return {
    isIgnored: path => path in ignored,
    exists: path => ignored[path] === true,
  };
}

const NO_DISK = createFakeDisk({});

function check(text: string, files: Record<string, string>, disk: Disk = NO_DISK) {
  const tree = createFakeTree(files);
  return checkPlanNames(parsePlan(text, TOP_LEVEL, NO_BRANCHES), tree, tree, disk);
}

describe('parsePlan', () => {
  it('As a plan reviewer, I check a plan whose task lists its files and context and get each declared file, read file, bare file name and symbol', () => {
    // Given
    const text = [
      '### Task 1: Pool teardown',
      '',
      '**Files:**',
      '',
      '- Modify: `packages/chains/src/createChainPool.ts`, `createChainBroker.ts`',
      '- Create: `packages/chains/src/closePool.ts`',
      '',
      '**Context:**',
      '',
      '- **Read:** `packages/chains/src/createChainPool.ts`: `destroy`, `ChainPool.close()`, and `halt` in',
      '  `createChainBroker.ts`.',
      '- Rules: (docs/code/style.md § Errors)',
    ].join('\n');

    // When
    const plan = parsePlan(text, TOP_LEVEL, NO_BRANCHES);

    // Then
    assert.deepEqual(
      plan.declared.map(file => `${file.verb} ${file.path}`),
      [
        'Modify packages/chains/src/createChainPool.ts',
        'Modify packages/chains/src/createChainBroker.ts',
        'Create packages/chains/src/closePool.ts',
      ],
    );
    assert.deepEqual(
      plan.reads.map(entry => ({
        files: entry.files,
        bareNames: entry.bareNames,
        symbols: entry.symbols.map(symbol => symbol.name),
      })),
      [
        {
          files: ['packages/chains/src/createChainPool.ts'],
          bareNames: ['createChainBroker.ts'],
          symbols: ['destroy', 'close', 'halt'],
        },
      ],
    );
    assert.deepEqual(plan.tasks, [{ line: 1, task: 'Task 1', hasRead: true }]);
  });

  it('As a plan reviewer, I check a plan that names a branch, a glob and code in a fence and none of them is looked up as a path', () => {
    // Given
    const text = [
      '- Branch: `apps/feature-x`. Out of scope: `docs/**`.',
      '',
      '```ts',
      "import { x } from 'apps/host/src/fenced.ts';",
      '```',
    ].join('\n');

    // When
    const plan = parsePlan(text, TOP_LEVEL, new Set(['apps/feature-x']));

    // Then
    assert.deepEqual(plan.paths, []);
    assert.deepEqual(
      plan.skipped.map(item => `${item.token} is ${item.reason}`),
      ['apps/feature-x is a branch name', 'docs/** is a pattern, not a path'],
    );
    assert.ok(plan.planWords.has('fenced'));
  });

  it('As a plan reviewer, I check a citation that a line break splits and get it whole, on the line it starts', () => {
    // Given
    const text = ['- Rules: (docs/code/style.md § Throw errors, catch at the', '  boundary).'].join('\n');

    // When
    const plan = parsePlan(text, TOP_LEVEL, NO_BRANCHES);

    // Then
    assert.deepEqual(plan.citations, [
      { line: 1, task: 'preamble', file: 'docs/code/style.md', heading: 'Throw errors, catch at the boundary' },
    ]);
  });
});

describe('checkPlanNames', () => {
  it('As a plan reviewer, I check a plan whose files are wrong and get each one as not found', () => {
    // Given
    const text = [
      '### Task 1: Files',
      '',
      '- Modify: `apps/host/src/missing.ts`',
      '- Create: `apps/host/src/present.ts`',
      '- Read: `apps/host/src/present.ts`',
    ].join('\n');

    // When
    const report = check(text, { 'apps/host/src/present.ts': '' });

    // Then
    assert.deepEqual(
      report.notFound.map(item => item.text),
      [
        'Modify `apps/host/src/missing.ts` exists neither at the base commit nor at HEAD, and no earlier task creates it.',
        'Create `apps/host/src/present.ts` already exists at the base commit.',
      ],
    );
  });

  it('As a plan reviewer, I check a plan that modifies a file an earlier task creates and it is found as added by the plan', () => {
    // Given
    const text = [
      '### Task 1: Add',
      '',
      '- Create: `apps/host/src/added.ts`',
      '- Read: `apps/host/src/base.ts`: `base`',
      '',
      '### Task 2: Use',
      '',
      '- Modify: `apps/host/src/added.ts`',
      '- Read: `apps/host/src/base.ts`: `base`',
    ].join('\n');

    // When
    const report = check(text, { 'apps/host/src/base.ts': 'export const base = 1;' });

    // Then
    assert.deepEqual(report.notFound, []);
    assert.equal(report.found.addedByPlan, 2);
  });

  it('As a plan reviewer, I check Read symbols and get each as found in the entry, added by the plan, found elsewhere or not found', () => {
    // Given
    const text = [
      '### Task 1: Symbols',
      '',
      '- Modify: `apps/host/src/a.ts`',
      '- Read: `apps/host/src/a.ts`: `inA`, `inB` in `b.ts`, `planned`, `inOther`, `nowhere`.',
      '',
      '```ts',
      'export function planned() {}',
      '```',
    ].join('\n');
    const files = {
      'apps/host/src/a.ts': 'export const inA = 1;',
      'apps/host/src/b.ts': 'export const inB = 2;',
      'packages/shared/src/other.ts': 'export const inOther = 3;',
    };

    // When
    const report = check(text, files);

    // Then
    assert.equal(report.found.symbols, 2);
    assert.equal(report.found.addedByPlan, 1);
    assert.deepEqual(
      report.foundElsewhere.map(item => item.text),
      [
        '`inOther`, in the entry at line 4, is a word in none of the files it names (`apps/host/src/a.ts`, `apps/host/src/b.ts`). It is in `packages/shared/src/other.ts`.',
      ],
    );
    assert.deepEqual(
      report.notFound.map(item => item.text),
      [
        "`nowhere`, in the entry at line 4, is a word in no tracked file at the base commit or HEAD, and not in the plan's code blocks, Interfaces or Produces lines.",
      ],
    );
  });

  it('As a plan reviewer, I check bare file names written relative to another folder and they resolve to every tracked file of that name', () => {
    // Given
    const text = [
      '### Task 1: Bare names',
      '',
      '- Create: `packages/ui/src/added.ts`, `packages/ui/src/added.spec.ts`',
      '- Modify: `packages/ui/src/useStore.ts`, `page/runWhenIdle.ts`, `page/missing.ts`',
      '- Read: `createToasts.ts` (`createToasts`, `clear`). `added.ts` (`brandNew`).',
    ].join('\n');
    const files = {
      'packages/ui/src/useStore.ts': '',
      'packages/ui/src/page/runWhenIdle.ts': '',
      'packages/ui/src/page/state/createToasts.ts': 'export function createToasts() { const clear = () => {}; }',
    };

    // When
    const report = check(text, files);

    // Then
    assert.equal(report.found.symbols, 2);
    assert.deepEqual(
      report.notFound.map(item => item.text),
      [
        'Modify `page/missing.ts` matches no tracked file name, and no earlier task creates it.',
        "`brandNew`, in the entry at line 5, is a word in no tracked file at the base commit or HEAD, and not in the plan's code blocks, Interfaces or Produces lines.",
      ],
    );
  });

  it('As a plan reviewer, I check a plan that names ignored files and get the one on disk as found and the other as not on disk', () => {
    // Given
    const text = [
      '### Task 1: Docs',
      '',
      '- Modify: `apps/host/src/a.ts`',
      '- Read: `docs/_plans/x-design.md`, `docs/_plans/gone-design.md`',
    ].join('\n');
    const disk = createFakeDisk({ 'docs/_plans/x-design.md': true, 'docs/_plans/gone-design.md': false });

    // When
    const report = check(text, { 'apps/host/src/a.ts': '' }, disk);

    // Then
    assert.deepEqual(
      report.notFound.map(item => item.text),
      ['`docs/_plans/gone-design.md` is ignored by git and is not on disk, and no task creates it.'],
    );
  });

  it('As a plan reviewer, I check citations of a heading, a label line and a quoted rule, and only the missing heading is not found', () => {
    // Given
    const text = [
      '### Task 1: Rules',
      '',
      '- Modify: `apps/host/src/a.ts`',
      '- Read: `apps/host/src/a.ts`',
      '- Rules: (docs/code/style.md § Errors: "never match messages"), (docs/code/style.md § Code style, Tests:),',
      '  (docs/code/style.md § No such heading).',
    ].join('\n');
    const files = {
      'apps/host/src/a.ts': '',
      'docs/code/style.md': ['# Style', '', '## Errors', '', '## Code style', '', 'Tests:', ''].join('\n'),
    };

    // When
    const report = check(text, files);

    // Then
    assert.equal(report.found.citations, 2);
    assert.deepEqual(
      report.notFound.map(item => item.text),
      ['`docs/code/style.md` has no heading or label line that "No such heading" starts with, at HEAD.'],
    );
  });

  it('As a plan reviewer, I check a task with no Read entry and get it as not found', () => {
    // Given
    const text = ['### Task 1: Bare', '', '- Modify: `apps/host/src/a.ts`'].join('\n');

    // When
    const report = check(text, { 'apps/host/src/a.ts': '' });

    // Then
    assert.deepEqual(
      report.notFound.map(item => `${String(item.line)} ${item.text}`),
      ['1 Task 1 has no Read entry.'],
    );
  });

  it('As a plan reviewer, I check a plan that names one missing path twice and get one entry with both lines', () => {
    // Given
    const text = [
      '### Task 1: Twice',
      '',
      '- Modify: `apps/host/src/a.ts`',
      '- Read: `apps/host/src/a.ts`, `apps/host/src/gone.ts`',
      '- See `apps/host/src/gone.ts` again.',
    ].join('\n');

    // When
    const report = check(text, { 'apps/host/src/a.ts': '' });

    // Then
    assert.deepEqual(
      report.notFound.map(item => [item.line, item.also]),
      [[4, [5]]],
    );
  });
});

describe('formatReport', () => {
  it('As a plan reviewer, I read a report and get its commits, its result line and every section in a fixed order', () => {
    // Given
    const report = check(
      ['### Task 1: One', '', '- Modify: `apps/host/src/a.ts`', '- Read: `apps/host/src/a.ts`'].join('\n'),
      {
        'apps/host/src/a.ts': '',
      },
    );

    // When
    const text = formatReport(report, { plan: 'docs/_plans/x-plan.md', base: 'aaaa', head: 'bbbb' });

    // Then
    assert.match(text, /^- Base commit: `aaaa`\. HEAD: `bbbb`\./m);
    assert.match(text, /^- Result: 0 not found, 0 found elsewhere, 2 found\.$/m);
    assert.deepEqual(
      text.split('\n').filter(line => line.startsWith('## ')),
      ['## Not found (0)', '## Found elsewhere (0)', '## Found (2)', '## Not checked (0)'],
    );
  });
});
