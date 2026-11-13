// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Checks the prose mechanics of the tracked Markdown docs, so no reviewer spends a finding on them. Code blocks, inline
// code and link targets are not prose. A word in double quotes is named, not used, as a rule that bans it names it.
//
// Usage: node scripts/checkProse.ts

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

type ProseIssue = { line: number; rule: string };

// Generated from the dependency tree, so its prose is not ours to shape.
const IGNORED = new Set(['THIRD_PARTY_NOTICES.md']);

const MARK_RULES = [
  { rule: 'an em-dash', pattern: /—/ },
  { rule: 'a semicolon', pattern: /;/ },
  { rule: 'a Unicode arrow', pattern: /[←-⇿⟵-⟿]/ },
];

const WORD_RULES = [
  { rule: '"on-chain" where "network" or "remote" fits', pattern: /\bon-chain\b/i },
  { rule: '"Solid-free" instead of "imports no Solid"', pattern: /\bsolid-free\b/i },
];

export function findProseIssues(text: string): ProseIssue[] {
  const issues: ProseIssue[] = [];
  let inFence = false;
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const prose = line
      .replace(/`[^`]*`/g, '')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/<!--.*?-->/g, '')
      .replace(/&#?\w+;/g, '');
    const used = prose.replace(/"[^"]*"/g, '');
    for (const { rule, pattern } of MARK_RULES) {
      if (pattern.test(prose)) {
        issues.push({ line: index + 1, rule });
      }
    }
    for (const { rule, pattern } of WORD_RULES) {
      if (pattern.test(used)) {
        issues.push({ line: index + 1, rule });
      }
    }
  }
  return issues;
}

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '*.md'], { encoding: 'utf8' })
    .split('\n')
    .filter(file => file !== '' && !IGNORED.has(file));
  let count = 0;
  for (const file of files) {
    for (const { line, rule } of findProseIssues(readFileSync(file, 'utf8'))) {
      console.error(`${file}:${String(line)} ${rule} in prose (AGENTS.md § Code style, Comments and docs:)`);
      count += 1;
    }
  }
  if (count > 0) {
    console.error(
      `checkProse: ${String(count)} issue${count === 1 ? '' : 's'} in ${String(files.length)} Markdown files`,
    );
    process.exit(1);
  }
}
