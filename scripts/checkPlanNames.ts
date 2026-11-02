// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Looks up every name a plan in docs/_plans/ cites, so a plan review pass reads lookup results instead of running one
// search per name. It reads committed trees, and the disk only for paths git ignores, so the same plan, commits and
// ignored files always give the same report. It reports what it found and judges nothing.
//
// Usage: node scripts/checkPlanNames.ts <plan> [--base <rev>]
//
// `--base` is the commit the plan's implementation starts from, HEAD by default. A Create path must be absent there.
// Every other lookup passes when the name is found at the base commit or at HEAD, so a plan amended mid-implementation
// still checks against the code its earlier tasks committed.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

type Location = { line: number; task: string };

type DeclaredFile = Location & {
  verb: string;
  path: string;
  /** The file name as written, when the line gives it without a repo path. */
  bareName?: string | undefined;
};

type NamedPath = Location & { path: string };

type ReadEntry = Location & {
  /** The repo paths of files the entry names. */
  files: string[];
  /** The file names the entry names without a repo path, such as `createChainPool.ts` or `page/runWhenIdle.ts`. */
  bareNames: string[];
  symbols: (Location & { name: string })[];
};

type Citation = Location & { file: string; heading: string };

type Skipped = Location & { token: string; reason: string };

export type PlanNames = {
  /** The `- Create|Modify|Test|Delete|Rename|Move: \`path\`` entries, in plan order. */
  declared: DeclaredFile[];
  /** Every other backticked repo path. */
  paths: NamedPath[];
  /** Each Read or Precedent entry of a task's Context. */
  reads: ReadEntry[];
  /** Each `(<file>.md § <heading>)` citation. */
  citations: Citation[];
  /** Backticked repo paths not looked up: patterns, such as a glob or a placeholder, and branch names. */
  skipped: Skipped[];
  /** The words of the plan's fenced code and of its Interfaces and Produces lines, which name what the plan adds. */
  planWords: Set<string>;
  /** Each task heading, with whether the task has a Read entry. */
  tasks: (Location & { hasRead: boolean })[];
};

/** The working tree, read only for paths git ignores, such as plans and reviews. */
export type Disk = {
  /** Whether git ignores the path. Never throws. */
  isIgnored(path: string): boolean;
  /** Whether the path is a file or folder on disk. Never throws. */
  exists(path: string): boolean;
};

/** One committed tree of the repo. */
export type Tree = {
  /** Whether the path is a file or a folder in the tree. Never throws. */
  hasPath(path: string): boolean;
  /** The file's text, or `undefined` when the tree has no such file. Throws when git fails. */
  readFile(path: string): string | undefined;
  /** The files that hold the word, sorted. Throws when git fails. */
  listFilesWithWord(word: string): string[];
  /** The files whose path ends with `/<name>`, sorted. Never throws. */
  listFilesNamed(name: string): string[];
};

type Entry = Location & { text: string; also: number[] };

export type Report = {
  notFound: Entry[];
  foundElsewhere: Entry[];
  found: { paths: number; symbols: number; citations: number; addedByPlan: number };
  skipped: Skipped[];
};

const FILE_NAME = /^[\w.@/-]+\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|md|css|astro|html|yml|yaml|toml|svg|txt|sh)$/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

const NOT_A_SYMBOL = new Set(['true', 'false', 'null', 'undefined', 'void', 'this', 'new', 'typeof', 'async', 'await']);

const PATH = /^[\w.@-]+(?:\/[\w.@-]+)+$/;

const PATTERN = /[*{}<>$\s]/;

const TASK_HEADING = /^#{2,6}\s+Task\s+([\w.-]+)/;

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

const DECLARED = /^\s*- (Create|Modify|Test|Delete|Rename|Move)(?: \([^)]*\))?: `([^`]+)`/;

// `- **Read:**`, `- **Read**:` and `- Read:` all open an entry.
const READ_BULLET = /^(\s*)- (?:\*\*)?(Read|Precedent)(?:\*\*)?:(?:\*\*)?/;

const BULLET = /^(\s*)- /;

const LABEL_LINE = /^([A-Z][^#*\-`].{0,60}):\s*$/;

const CITATION = /\(([\w./-]+\.md) § ([^)]+)\)/g;

/**
 * Splits a plan into the names it cites. `topLevel` holds the repo's top-level entries, which mark a repo path.
 * `branches` holds the branch names, which look like paths and are not checked.
 */
export function parsePlan(text: string, topLevel: ReadonlySet<string>, branches: ReadonlySet<string>): PlanNames {
  const plan: PlanNames = {
    declared: [],
    paths: [],
    reads: [],
    citations: [],
    skipped: [],
    planWords: new Set(),
    tasks: [],
  };
  const lines = text.split('\n');
  const labels = labelLines(lines);
  let inFence = false;
  let section = '';
  let read: { indent: number; entry: ReadEntry } | undefined;
  lines.forEach((line, index) => {
    const at = { line: index + 1, task: labels[index] ?? '' };
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      addWords(plan.planWords, line);
      return;
    }
    if (HEADING.test(line)) {
      section = '';
      read = undefined;
      if (TASK_HEADING.test(line)) {
        plan.tasks.push({ ...at, hasRead: false });
      }
      return;
    }
    const label = /^\*\*([^*]+?):?\*\*/.exec(line);
    if (label) {
      section = (label[1] ?? '').toLowerCase();
      read = undefined;
    }
    const bullet = BULLET.exec(line);
    const readBullet = READ_BULLET.exec(line);
    if (readBullet) {
      read = { indent: (readBullet[1] ?? '').length, entry: { ...at, files: [], bareNames: [], symbols: [] } };
      plan.reads.push(read.entry);
      const task = plan.tasks.at(-1);
      if (readBullet[2] === 'Read' && task?.task === at.task) {
        task.hasRead = true;
      }
    } else if (read && line.trim() !== '' && (bullet ? (bullet[1] ?? '').length <= read.indent : !/^\s/.test(line))) {
      read = undefined;
    }
    if (section === 'interfaces' || /\bProduces:/.test(line)) {
      addWords(plan.planWords, line);
    }
    const declared = DECLARED.exec(line);
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map(match => match[1] ?? '');
    tokens.forEach(token => {
      const path = normalizePath(token);
      const isRepoPath = path.includes('/') && topLevel.has(path.split('/')[0] ?? '');
      if (isRepoPath && PATTERN.test(path)) {
        plan.skipped.push({ ...at, token, reason: 'a pattern, not a path' });
        return;
      }
      if (isRepoPath && branches.has(token)) {
        plan.skipped.push({ ...at, token, reason: 'a branch name' });
        return;
      }
      if (isRepoPath && PATH.test(path)) {
        if (declared) {
          plan.declared.push({ ...at, verb: declared[1] ?? '', path });
        } else {
          plan.paths.push({ ...at, path });
        }
        if (read && FILE_NAME.test(path)) {
          read.entry.files.push(path);
        }
        return;
      }
      if (FILE_NAME.test(token)) {
        // A declared line may list more files by name alone, usually in the folder of its first path.
        const first = plan.declared.at(-1);
        if (declared && first?.line === at.line) {
          plan.declared.push({ ...at, verb: first.verb, path: `${dirname(first.path)}/${token}`, bareName: token });
        } else if (read) {
          read.entry.bareNames.push(token);
        }
        return;
      }
      if (read && IDENTIFIER.test(token)) {
        const name = token.replace(/\(\)$/, '').split('.').pop() ?? '';
        if (!NOT_A_SYMBOL.has(name)) {
          read.entry.symbols.push({ ...at, name });
        }
      }
    });
  });
  plan.citations = listCitations(text, lines, labels);
  return plan;
}

/**
 * Looks up every name of the plan in the base and HEAD trees, and on disk for a path git ignores. Throws when a tree
 * throws.
 */
export function checkPlanNames(plan: PlanNames, base: Tree, head: Tree, disk: Disk): Report {
  const notFound = new Map<string, Entry>();
  const foundElsewhere = new Map<string, Entry>();
  const found = { paths: 0, symbols: 0, citations: 0, addedByPlan: 0 };
  const add = (map: Map<string, Entry>, at: Location, text: string): void => {
    const entry = map.get(text);
    if (entry) {
      entry.also.push(at.line);
      return;
    }
    map.set(text, { ...at, text, also: [] });
  };
  const inTrees = (path: string): boolean => base.hasPath(path) || head.hasPath(path);
  const exists = (path: string): boolean => inTrees(path) || (disk.isIgnored(path) && disk.exists(path));
  const missing = (path: string): string =>
    disk.isIgnored(path) ? 'is ignored by git and is not on disk' : 'exists neither at the base commit nor at HEAD';
  const named = (name: string): string[] => [...new Set([...base.listFilesNamed(name), ...head.listFilesNamed(name)])];
  const creations = plan.declared.filter(file => file.verb === 'Create' || file.verb === 'Test');
  const createdByPlan = (path: string): boolean =>
    creations.some(file => file.path === path || file.path.startsWith(`${path}/`));

  plan.declared.forEach((file, index) => {
    if (file.verb === 'Create') {
      if (base.hasPath(file.path)) {
        add(notFound, file, `Create \`${file.path}\` already exists at the base commit.`);
      } else {
        found.addedByPlan++;
      }
      return;
    }
    if (exists(file.path) || (file.bareName !== undefined && named(file.bareName).length > 0)) {
      found.paths++;
      return;
    }
    const createdEarlier = creations.some(
      creation => plan.declared.indexOf(creation) < index && creation.path === file.path,
    );
    if (file.verb === 'Test' || createdEarlier) {
      found.addedByPlan++;
      return;
    }
    const fact =
      file.bareName === undefined
        ? `\`${file.path}\` ${missing(file.path)}`
        : `\`${file.bareName}\` matches no tracked file name`;
    add(notFound, file, `${file.verb} ${fact}, and no earlier task creates it.`);
  });

  for (const mention of plan.paths) {
    if (exists(mention.path)) {
      found.paths++;
    } else if (createdByPlan(mention.path)) {
      found.addedByPlan++;
    } else {
      add(notFound, mention, `\`${mention.path}\` ${missing(mention.path)}, and no task creates it.`);
    }
  }

  for (const entry of plan.reads) {
    // A bare file name stands for every tracked file of that name, so a symbol in any of them is found.
    const files = [...new Set([...entry.files.filter(inTrees), ...entry.bareNames.flatMap(named)])].sort();
    for (const symbol of entry.symbols) {
      if (files.some(file => hasWord(base.readFile(file), symbol.name) || hasWord(head.readFile(file), symbol.name))) {
        found.symbols++;
        continue;
      }
      if (plan.planWords.has(symbol.name)) {
        found.addedByPlan++;
        continue;
      }
      const elsewhere = [
        ...new Set([...base.listFilesWithWord(symbol.name), ...head.listFilesWithWord(symbol.name)]),
      ].sort();
      if (elsewhere.length > 0 && files.length === 0) {
        // An entry that names no file it could be in leaves the repo as the only place to look.
        found.symbols++;
        continue;
      }
      if (elsewhere.length > 0) {
        const shown = elsewhere
          .slice(0, 3)
          .map(path => `\`${path}\``)
          .join(', ');
        const more = elsewhere.length > 3 ? ` and ${String(elsewhere.length - 3)} more files` : '';
        add(
          foundElsewhere,
          symbol,
          `\`${symbol.name}\`, in the ${describeEntry(entry)}, is a word in none of the files it names (${listFiles(files)}). It is in ${shown}${more}.`,
        );
        continue;
      }
      add(
        notFound,
        symbol,
        `\`${symbol.name}\`, in the ${describeEntry(entry)}, is a word in no tracked file at the base commit or HEAD, and not in the plan's code blocks, Interfaces or Produces lines.`,
      );
    }
  }

  for (const citation of plan.citations) {
    const content = head.readFile(citation.file) ?? base.readFile(citation.file);
    if (content === undefined) {
      add(
        notFound,
        citation,
        `\`${citation.file}\`, cited as (${citation.file} § ${citation.heading}), exists neither at the base commit nor at HEAD.`,
      );
      continue;
    }
    if (hasHeading(content, citation.heading)) {
      found.citations++;
      continue;
    }
    add(
      notFound,
      citation,
      `\`${citation.file}\` has no heading or label line that "${citation.heading}" starts with, at HEAD.`,
    );
  }

  for (const task of plan.tasks.filter(item => !item.hasRead)) {
    add(notFound, task, `${task.task} has no Read entry.`);
  }

  const byLine = (a: Entry, b: Entry): number => a.line - b.line;
  return {
    notFound: [...notFound.values()].sort(byLine),
    foundElsewhere: [...foundElsewhere.values()].sort(byLine),
    found,
    skipped: plan.skipped,
  };
}

/** The report as Markdown. */
export function formatReport(report: Report, meta: { plan: string; base: string; head: string }): string {
  const { paths, symbols, citations, addedByPlan } = report.found;
  const total = paths + symbols + citations + addedByPlan;
  const entry = (item: Entry): string => {
    const also = item.also.length > 0 ? ` Also lines ${item.also.join(', ')}.` : '';
    return `- Line ${String(item.line)}, ${item.task}: ${item.text}${also}`;
  };
  return [
    '# Plan names check',
    '',
    `- Plan: \`${meta.plan}\``,
    `- Base commit: \`${meta.base}\`. HEAD: \`${meta.head}\`. The working tree is read only for paths git ignores.`,
    `- Result: ${String(report.notFound.length)} not found, ${String(report.foundElsewhere.length)} found elsewhere, ${String(total)} found.`,
    '',
    'Every line is the result of a lookup by `scripts/checkPlanNames.ts`, not a judgment. The check covers each',
    'backticked repo path, each file a Create, Modify, Test, Delete, Rename or Move line declares, each backticked symbol',
    'of a Read or Precedent entry, each `(<file>.md § <heading>)` citation, and whether each task has a Read entry. A',
    'symbol counts as found when it is a word in any file its entry names, and a bare file name, such as `index.ts`, names',
    'every tracked file of that name.',
    '',
    `## Not found (${String(report.notFound.length)})`,
    '',
    ...(report.notFound.length > 0 ? report.notFound.map(entry) : ['None.']),
    '',
    `## Found elsewhere (${String(report.foundElsewhere.length)})`,
    '',
    ...(report.foundElsewhere.length > 0 ? report.foundElsewhere.map(entry) : ['None.']),
    '',
    `## Found (${String(total)})`,
    '',
    `- ${String(paths)} paths, ${String(symbols)} symbols and ${String(citations)} citations found at the base commit or HEAD.`,
    `- ${String(addedByPlan)} names the plan itself adds: a Create or Test file, or a word of its code blocks, Interfaces or Produces lines.`,
    '',
    `## Not checked (${String(report.skipped.length)})`,
    '',
    ...(report.skipped.length > 0
      ? report.skipped.map(item => `- Line ${String(item.line)}, ${item.task}: \`${item.token}\` is ${item.reason}.`)
      : ['None.']),
    '',
  ].join('\n');
}

/** A committed tree, read through git. Throws when `rev` names no commit. */
export function createGitTree(rev: string): Tree {
  const files = new Set(git(['ls-tree', '-r', '--name-only', '-z', rev]).split('\0').filter(Boolean));
  const folders = new Set<string>();
  for (const file of files) {
    for (let end = file.lastIndexOf('/'); end > 0; end = file.lastIndexOf('/', end - 1)) {
      folders.add(file.slice(0, end));
    }
  }
  const contents = new Map<string, string>();
  const sorted = [...files].sort();
  return {
    hasPath: path => files.has(path) || folders.has(path),
    listFilesNamed: name => sorted.filter(file => file === name || file.endsWith(`/${name}`)),
    readFile: path => {
      if (!files.has(path)) {
        return undefined;
      }
      const content = contents.get(path) ?? git(['show', `${rev}:${path}`]);
      contents.set(path, content);
      return content;
    },
    listFilesWithWord: word => {
      const result = spawnSync('git', ['grep', '-l', '-w', '-F', '-e', word, rev, '--'], {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      });
      // git grep exits 1 when nothing matches.
      if (result.status === 1) {
        return [];
      }
      if (result.status !== 0) {
        throw new Error(`git grep failed: ${result.stderr.trim()}`);
      }
      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(rev.length + 1))
        .sort();
    },
  };
}

/** The working tree, for paths git ignores. */
export function createDisk(): Disk {
  return {
    isIgnored: path => spawnSync('git', ['check-ignore', '-q', '--no-index', path]).status === 0,
    exists: path => existsSync(path),
  };
}

/** The section each line sits in: its task, else the nearest heading above it at the task headings' level or higher. */
function labelLines(lines: string[]): string[] {
  let label = 'preamble';
  let taskLevel = Infinity;
  let inFence = false;
  return lines.map(line => {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return label;
    }
    const heading = inFence ? null : HEADING.exec(line);
    if (!heading) {
      return label;
    }
    const level = line.indexOf(' ');
    const task = TASK_HEADING.exec(line);
    if (task) {
      label = `Task ${task[1] ?? ''}`;
      taskLevel = level;
    } else if (level <= taskLevel) {
      label = `section "${heading[1] ?? ''}"`;
      taskLevel = Infinity;
    }
    return label;
  });
}

function git(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function normalizePath(token: string): string {
  return token.replace(/:\d+(?:-\d+)?$/, '').replace(/\/$/, '');
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

function describeEntry(entry: ReadEntry): string {
  return `entry at line ${String(entry.line)}`;
}

function listFiles(files: string[]): string {
  if (files.length === 0) {
    return 'none of them is in the repo';
  }
  const shown = files
    .slice(0, 5)
    .map(file => `\`${file}\``)
    .join(', ');
  return files.length > 5 ? `${shown} and ${String(files.length - 5)} more` : shown;
}

function addWords(words: Set<string>, line: string): void {
  for (const match of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
    words.add(match[0]);
  }
}

function hasWord(text: string | undefined, word: string): boolean {
  if (text === undefined) {
    return false;
  }
  return new RegExp(`(?<![A-Za-z0-9_$])${word.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`).test(text);
}

function hasHeading(content: string, cited: string): boolean {
  const clean = (heading: string): string => heading.replace(/`/g, '').replace(/:$/, '').trim();
  // A label line, such as "Tests:" alone on its line, is a section a citation may point at too.
  const targets = new Set(
    content
      .split('\n')
      .map(line => HEADING.exec(line)?.[1] ?? LABEL_LINE.exec(line)?.[1])
      .filter((target): target is string => target !== undefined)
      .map(clean),
  );
  // A citation may add text after its target, as in "§ Code style, Tests:" or "§ Errors: \"quoted rule\"", and a target
  // may hold a comma or a colon itself, so every prefix that ends before one of those marks is a candidate.
  const ends = [...cited.matchAll(/[,:]| "| \(/g)].map(mark => mark.index);
  const candidates = [cited, ...ends.map(end => cited.slice(0, end))].map(clean);
  return candidates.some(candidate => candidate !== '' && targets.has(candidate));
}

function listCitations(text: string, lines: string[], labels: string[]): Citation[] {
  // Blank fenced code and join wrapped lines without moving any offset, so an offset still maps to its line.
  let inFence = false;
  const flat = lines
    .map(line => {
      const isFence = line.trimStart().startsWith('```');
      const blank = inFence || isFence;
      inFence = isFence ? !inFence : inFence;
      return blank ? ' '.repeat(line.length) : line;
    })
    .join(' ');
  return [...flat.matchAll(CITATION)].map(match => {
    const line = text.slice(0, match.index).split('\n').length;
    const heading = (match[2] ?? '').replace(/\s+/g, ' ').trim();
    return { line, task: labels[line - 1] ?? '', file: match[1] ?? '', heading };
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const baseFlag = args.indexOf('--base');
  const baseRev = baseFlag >= 0 ? args[baseFlag + 1] : 'HEAD';
  const positional = args.filter((arg, index) => !arg.startsWith('--') && !(baseFlag >= 0 && index === baseFlag + 1));
  const unknownFlag = args.some(arg => arg.startsWith('--') && arg !== '--base');
  const planPath = positional[0];
  if (
    planPath === undefined ||
    positional.length > 1 ||
    baseRev === undefined ||
    baseRev.startsWith('--') ||
    unknownFlag
  ) {
    console.error('Usage: node scripts/checkPlanNames.ts <plan> [--base <rev>]');
    process.exit(1);
  }
  try {
    const base = git(['rev-parse', '--verify', `${baseRev}^{commit}`]).trim();
    const head = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    const baseTree = createGitTree(base);
    const headTree = head === base ? baseTree : createGitTree(head);
    const topLevel = new Set(
      [
        ...git(['ls-tree', '--name-only', base]).split('\n'),
        ...git(['ls-tree', '--name-only', head]).split('\n'),
      ].filter(Boolean),
    );
    const refs = git(['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads', 'refs/remotes']).split('\n');
    // A remote branch is also named without its remote, as in `main` for `origin/main`.
    const branches = new Set(refs.filter(Boolean).flatMap(name => [name, name.slice(name.indexOf('/') + 1)]));
    const plan = parsePlan(readFileSync(planPath, 'utf8'), topLevel, branches);
    if (plan.declared.length === 0) {
      throw new Error(
        'found no "- Create|Modify|Test|Delete|Rename|Move: `path`" line, so the plan does not follow the plan format',
      );
    }
    const report = checkPlanNames(plan, baseTree, headTree, createDisk());
    process.stdout.write(formatReport(report, { plan: planPath, base: base.slice(0, 12), head: head.slice(0, 12) }));
  } catch (error) {
    console.error(`checkPlanNames: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
