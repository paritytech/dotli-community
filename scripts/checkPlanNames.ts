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
// still checks against the code its earlier tasks committed. The users of a name a task breaks are looked up at HEAD,
// the code the remaining tasks change.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname as pathDirname, join } from 'node:path';

type Location = { line: number; task: string };

type Named = Location & { name: string };

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
  symbols: Named[];
};

type Break = Named & {
  /** The deleted file, when the break comes from a Delete line rather than a Breaks line. */
  deleted?: string | undefined;
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
  /** Names not looked up: patterns, such as a glob or a placeholder, branch names and one-letter symbols. */
  skipped: Skipped[];
  /**
   * The names the plan defines, with the line of the first definition: a name its code declares, or the name a
   * signature in an Interfaces or Produces line starts with.
   */
  defined: Map<string, number>;
  /** The type names, such as `NetworkState`, that the plan's code and its Interfaces and Produces lines use. */
  typeNames: Named[];
  /** The names the plan's code imports from an npm package, with the package. */
  imported: Map<string, string>;
  /** The exported names each task removes, renames or retypes, from its Breaks lines and its deleted files. */
  breaks: Break[];
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
  /** Whether any file holds the word. Throws when git fails. */
  hasWord(word: string): boolean;
  /** The files whose path ends with `/<name>`, sorted. Never throws. */
  listFilesNamed(name: string): string[];
};

type Entry = Location & { text: string; also: number[] };

export type Report = {
  notFound: Entry[];
  foundElsewhere: Entry[];
  found: { paths: number; symbols: number; typeNames: number; citations: number; breaks: number; addedByPlan: number };
  /** The Read symbols found only because the plan defines them, which a reviewer checks a task really adds. */
  definedByPlan: Entry[];
  skipped: Skipped[];
};

const FILE_NAME = /^[\w.@/-]+\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|json|md|css|astro|html|yml|yaml|toml|svg|txt|sh)$/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;

const NOT_A_SYMBOL = new Set(['true', 'false', 'null', 'undefined', 'void', 'this', 'new', 'typeof', 'async', 'await']);

const PATH = /^[\w.@-]+(?:\/[\w.@-]+)+$/;

const PATTERN = /[*{}<>$\s]/;

const TASK_HEADING = /^#{2,6}\s+Task\s+([\w.-]+)/;

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

// The label in parentheses may hold code with parentheses of its own, as in "Modify (script, `f(x)` becomes `x`)".
const DECLARED = /^\s*- (Create|Modify|Test|Delete|Rename|Move)(?: \((?:[^()`]|`[^`]*`|\([^()]*\))*\))?:/;

// `- **Read:**`, `- **Read**:` and `- Read:` all open an entry.
const READ_BULLET = /^(\s*)- (?:\*\*)?(Read|Precedent)(?:\*\*)?:(?:\*\*)?/;

const BREAKS_BULLET = /^(\s*)- (?:\*\*)?Breaks(?:\*\*)?:/;

const CODE_LANGUAGES = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'typescript', 'javascript']);

const CODE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;

// A type name starts with a capital and holds a lowercase letter, so a generic parameter such as `T` or a constant
// such as `MAX_SIZE` is not one.
const TYPE_NAME = /(?<![\w$.])[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*(?![\w$])/g;

const DECLARATION =
  /\b(?:function\*?|const|let|var|class|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)(?:\s*<([^>]*)>)?/g;

const DESTRUCTURING = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g;

const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;

// A property or method at the start of a line of an object, class or interface, as in `close(): void` or `size?: number`.
const PROPERTY = /^\s*(?:(?:readonly|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\??\s*:\s/;

const METHOD =
  /^\s*(?:(?:static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(([^()'"`]*)\)\s*(:[^=]*)?[{;]?\s*$/;

// A signature in an Interfaces or Produces span starts with the name it defines, as in `createX(params): X`,
// `INITIAL_X: X` or `type X = ...`. A bare name or a generic such as `ReadableAtom<X>` defines nothing.
const SIGNATURE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:(?:function|const|let|type|interface|class|enum)\s+)?(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)(?:\s*<([^>]*)>)?\s*(?:\(|\??:|=)/;

// A span the text assigns to, as in "`StatusSource<T>` = `{ get(): T }`" or a span wrapped onto the next line.
const ASSIGNED = /`([A-Za-z_$][\w$]*)(?:<([^>`]*)>)?`?\s*=(?![=>])/g;

// A line that says where its names come from, as in "`ReadableAtom` from `nanostores`". An npm package name is
// lowercase, so "`subscribe` from `createSyncStore`" names no package.
const FROM_PACKAGE = /\bfrom `((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)`/;

const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'case',
  'default',
  'else',
  'do',
  'try',
  'finally',
  'throw',
  'new',
  'typeof',
  'await',
  'yield',
  'function',
  'import',
  'export',
]);

const BULLET = /^(\s*)- /;

const LABEL_LINE = /^([A-Z][^#*\-`].{0,60}):\s*$/;

const CITATION = /\(([\w./-]+\.md) § ([^)]+)\)/g;

/**
 * Splits a plan into the names it cites. `topLevel` holds the repo's top-level entries, which mark a repo path.
 * `branches` holds the branch names, which look like paths and are not checked. `dependencies` holds the npm packages the
 * repo's `package.json` files list.
 */
export function parsePlan(
  text: string,
  topLevel: ReadonlySet<string>,
  branches: ReadonlySet<string>,
  dependencies: ReadonlySet<string> = new Set(),
): PlanNames {
  const plan: PlanNames = {
    declared: [],
    paths: [],
    reads: [],
    citations: [],
    skipped: [],
    defined: new Map(),
    typeNames: [],
    imported: new Map(),
    breaks: [],
    tasks: [],
  };
  const lines = text.split('\n');
  const labels = labelLines(lines);
  let fence: { isCode: boolean } | undefined;
  let section = '';
  let read: { indent: number; entry: ReadEntry } | undefined;
  let breaksIndent: number | undefined;
  let declaring: { indent: number; verb: string; first: string | undefined } | undefined;
  const saidFrom = new Map<string, string>();
  lines.forEach((line, index) => {
    const at = { line: index + 1, task: labels[index] ?? '' };
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim().split(/\s/)[0] ?? '';
      fence = fence ? undefined : { isCode: CODE_LANGUAGES.has(language) };
      return;
    }
    if (fence) {
      addImports(plan.imported, line);
      const code = stripCode(line);
      addCodeDefinitions(plan.defined, code, at.line);
      if (fence.isCode) {
        addTypeNames(plan.typeNames, code, at);
      }
      return;
    }
    if (HEADING.test(line)) {
      section = '';
      read = undefined;
      breaksIndent = undefined;
      declaring = undefined;
      if (TASK_HEADING.test(line)) {
        plan.tasks.push({ ...at, hasRead: false });
      }
      return;
    }
    const label = /^\*\*([^*]+?):?\*\*/.exec(line);
    if (label) {
      section = (label[1] ?? '').toLowerCase();
      read = undefined;
      breaksIndent = undefined;
      declaring = undefined;
    }
    const bullet = BULLET.exec(line);
    const ends = (indent: number): boolean =>
      line.trim() !== '' && (bullet ? (bullet[1] ?? '').length <= indent : !/^\s/.test(line));
    const readBullet = READ_BULLET.exec(line);
    if (readBullet) {
      read = { indent: (readBullet[1] ?? '').length, entry: { ...at, files: [], bareNames: [], symbols: [] } };
      plan.reads.push(read.entry);
      const task = plan.tasks.at(-1);
      if (readBullet[2] === 'Read' && task?.task === at.task) {
        task.hasRead = true;
      }
    } else if (read && ends(read.indent)) {
      read = undefined;
    }
    const breaksBullet = BREAKS_BULLET.exec(line);
    if (breaksBullet) {
      breaksIndent = (breaksBullet[1] ?? '').length;
    } else if (breaksIndent !== undefined && ends(breaksIndent)) {
      breaksIndent = undefined;
    }
    // A declared line may wrap, and its continuation lines declare files with the same verb.
    const declaredLine = DECLARED.exec(line);
    if (declaredLine) {
      declaring = { indent: (bullet?.[1] ?? '').length, verb: declaredLine[1] ?? '', first: undefined };
    } else if (declaring && ends(declaring.indent)) {
      declaring = undefined;
    }
    const tokens = [...line.matchAll(/`([^`]+)`/g)].map(match => match[1] ?? '');
    // A workspace package names repo code, which the tree lookups cover.
    const fromPackage = FROM_PACKAGE.exec(line)?.[1];
    if (fromPackage !== undefined && !fromPackage.startsWith('@dotli/')) {
      for (const token of tokens.filter(item => item !== fromPackage && /^[A-Za-z_$][\w$]*$/.test(item))) {
        if (!saidFrom.has(token)) {
          saidFrom.set(token, fromPackage);
        }
      }
    }
    if (section === 'interfaces' || /\bProduces:/.test(line)) {
      addCodeDefinitions(plan.defined, line.replace(/`/g, ' '), at.line, { declarationsOnly: true });
      for (const match of line.matchAll(ASSIGNED)) {
        define(plan.defined, match[1] ?? '', at.line);
        defineGenerics(plan.defined, match[2], at.line);
      }
      for (const token of tokens.filter(item => !FILE_NAME.test(item) && !PATH.test(item))) {
        addSignature(plan.defined, token, at.line);
        addTypeNames(plan.typeNames, stripCode(token), at);
      }
    }
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
        if (declaring) {
          plan.declared.push({ ...at, verb: declaring.verb, path });
          declaring.first ??= path;
        } else {
          plan.paths.push({ ...at, path });
        }
        if (read && FILE_NAME.test(path)) {
          read.entry.files.push(path);
        }
        return;
      }
      if (FILE_NAME.test(token)) {
        // A declared line may list more files by name alone, usually in the folder of its first path. With no path
        // before it, as in "the `package.json` of each package", the name stands for every file of that name.
        if (declaring) {
          const first = declaring.first;
          const path = first === undefined ? token : `${dirname(first)}/${token}`;
          plan.declared.push({ ...at, verb: declaring.verb, path, bareName: token });
        } else if (read) {
          read.entry.bareNames.push(token);
        }
        return;
      }
      if (breaksIndent !== undefined && IDENTIFIER.test(token)) {
        // Users import the export, so `StatusCell.set` breaks the users of `StatusCell`.
        plan.breaks.push({ ...at, name: token.replace(/\(\)$/, '').split('.')[0] ?? '' });
        return;
      }
      if (read && IDENTIFIER.test(token)) {
        const name = token.replace(/\(\)$/, '').split('.').pop() ?? '';
        if (name.length === 1) {
          plan.skipped.push({ ...at, token, reason: 'a one-letter name, read as a placeholder' });
        } else if (!NOT_A_SYMBOL.has(name)) {
          read.entry.symbols.push({ ...at, name });
        }
      }
    });
  });
  // Prose such as "`X` from `y`" names a package only when the plan's code imports from `y` or a package lists it, so
  // "derive from `speaker`" does not.
  const packages = new Set([...plan.imported.values(), ...dependencies]);
  for (const [name, from] of saidFrom) {
    if (packages.has(from) && !plan.imported.has(name)) {
      plan.imported.set(name, from);
    }
  }
  // A Read entry may name a package the plan imports from, which is no symbol.
  for (const entry of plan.reads) {
    for (const symbol of entry.symbols.filter(item => packages.has(item.name))) {
      plan.skipped.push({ ...symbol, token: symbol.name, reason: 'a package the plan imports from' });
    }
    entry.symbols = entry.symbols.filter(item => !packages.has(item.name));
  }
  // Deleting a module breaks every file that imports it by its name, unless the plan creates a module of that name.
  const fileName = (path: string): string => path.split('/').pop() ?? '';
  const createdNames = new Set(
    plan.declared.filter(item => item.verb === 'Create' || item.verb === 'Test').map(item => fileName(item.path)),
  );
  for (const file of plan.declared.filter(item => item.verb === 'Delete' && CODE_FILE.test(item.path))) {
    const name = fileName(file.path).replace(CODE_FILE, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !createdNames.has(fileName(file.path))) {
      plan.breaks.push({ line: file.line, task: file.task, name, deleted: file.path });
    }
  }
  plan.breaks.sort((a, b) => a.line - b.line);
  plan.citations = listCitations(text, lines, labels);
  return plan;
}

/**
 * Looks up every name of the plan in the base and HEAD trees, and on disk for a path git ignores. `builtins` holds the
 * type names TypeScript declares itself. Throws when a tree throws.
 */
export function checkPlanNames(
  plan: PlanNames,
  base: Tree,
  head: Tree,
  disk: Disk,
  builtins: ReadonlySet<string>,
): Report {
  const notFound = new Map<string, Entry>();
  const foundElsewhere = new Map<string, Entry>();
  const definedByPlan = new Map<string, Entry>();
  const skipped = [...plan.skipped];
  const found = { paths: 0, symbols: 0, typeNames: 0, citations: 0, breaks: 0, addedByPlan: 0 };
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
      // A bare name with no folder before it gives no path that must be absent.
      if (file.path !== file.bareName && base.hasPath(file.path)) {
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
      const from = plan.imported.get(symbol.name);
      if (from !== undefined) {
        skipped.push({ ...symbol, token: symbol.name, reason: `from \`${from}\`, as the plan says` });
        continue;
      }
      const definedAt = plan.defined.get(symbol.name);
      if (definedAt !== undefined) {
        found.addedByPlan++;
        add(
          definedByPlan,
          symbol,
          `\`${symbol.name}\`, in the ${describeEntry(entry)}, is a word in none of the files it names. The plan defines it at line ${String(definedAt)}.`,
        );
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
        `\`${symbol.name}\`, in the ${describeEntry(entry)}, is a word in no tracked file at the base commit or HEAD, and the plan does not define it.`,
      );
    }
  }

  const typeResults = new Map<string, 'found' | 'defined' | 'imported' | 'missing'>();
  for (const type of plan.typeNames) {
    let result = typeResults.get(type.name);
    if (result === undefined) {
      if (plan.defined.has(type.name)) {
        result = 'defined';
      } else if (plan.imported.has(type.name)) {
        result = 'imported';
        const from = plan.imported.get(type.name) ?? '';
        skipped.push({ ...type, token: type.name, reason: `from \`${from}\`, as the plan says` });
      } else if (builtins.has(type.name) || base.hasWord(type.name) || head.hasWord(type.name)) {
        result = 'found';
      } else {
        result = 'missing';
      }
      typeResults.set(type.name, result);
      if (result === 'found') {
        found.typeNames++;
      } else if (result === 'defined') {
        found.addedByPlan++;
      }
    }
    if (result === 'missing') {
      add(
        notFound,
        type,
        `\`${type.name}\`, a type name the plan uses, is a word in no tracked file at the base commit or HEAD and no TypeScript built-in, the plan does not define it, and the plan names no package it comes from.`,
      );
    }
  }

  plan.breaks.forEach(broken => {
    const nextTask = plan.tasks.find(task => task.line > broken.line)?.line ?? Infinity;
    const declares = (item: DeclaredFile, file: string): boolean =>
      item.path === file ||
      file.startsWith(`${item.path}/`) ||
      (item.bareName !== undefined && file.endsWith(`/${item.bareName}`));
    const users = head
      .listFilesWithWord(broken.name)
      .filter(file => !plan.declared.some(item => item.line < nextTask && declares(item, file)));
    if (users.length === 0) {
      found.breaks++;
      return;
    }
    const later = users.flatMap(file => {
      const task = plan.declared.find(item => item.line >= nextTask && declares(item, file))?.task;
      return task === undefined ? [] : [`\`${file}\` (${task})`];
    });
    const undeclared = users.filter(file => !plan.declared.some(item => declares(item, file)));
    const action = broken.deleted === undefined ? `breaks \`${broken.name}\`` : `deletes \`${broken.deleted}\``;
    const files = (count: number): string => `${String(count)} ${count === 1 ? 'file' : 'files'}`;
    const parts = [
      undeclared.length > 0 ? `${files(undeclared.length)} no task declares: ${listFiles(undeclared, 12)}.` : '',
      later.length > 0
        ? `${files(later.length)} only a later task declares: ${later.slice(0, 12).join(', ')}${later.length > 12 ? ` and ${String(later.length - 12)} more` : ''}.`
        : '',
    ].filter(Boolean);
    add(
      notFound,
      broken,
      `${broken.task} ${action}. \`${broken.name}\` is a word at HEAD in ${parts.join(' It is also in ')}`,
    );
  });

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
    definedByPlan: [...definedByPlan.values()].sort(byLine),
    skipped: skipped.sort((a, b) => a.line - b.line),
  };
}

/** The report as Markdown. */
export function formatReport(report: Report, meta: { plan: string; base: string; head: string }): string {
  const { paths, symbols, typeNames, citations, breaks, addedByPlan } = report.found;
  const total = paths + symbols + typeNames + citations + breaks + addedByPlan;
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
    'of a Read or Precedent entry, each type name of the TypeScript code blocks and of the Interfaces and Produces lines,',
    'each `(<file>.md § <heading>)` citation, and whether each task has a Read entry. A symbol counts as found when it is',
    'a word in any file its entry names, and a bare file name, such as `index.ts`, names every tracked file of that name.',
    'For each name a Breaks line lists and each deleted module, it lists the files at HEAD that hold the name and that no',
    'task up to and including the breaking one declares. The plan defines a name its code declares, or the name a',
    'signature in an Interfaces or Produces line starts with, as in `createX(params): X`.',
    '',
    `## Not found (${String(report.notFound.length)})`,
    '',
    ...(report.notFound.length > 0 ? report.notFound.map(entry) : ['None.']),
    '',
    `## Found elsewhere (${String(report.foundElsewhere.length)})`,
    '',
    ...(report.foundElsewhere.length > 0 ? report.foundElsewhere.map(entry) : ['None.']),
    '',
    `## Defined by the plan (${String(report.definedByPlan.length)})`,
    '',
    ...(report.definedByPlan.length > 0 ? report.definedByPlan.map(entry) : ['None.']),
    '',
    `## Found (${String(total)})`,
    '',
    `- ${String(paths)} paths, ${String(symbols)} Read symbols, ${String(typeNames)} type names and ${String(citations)} citations found at the base commit or HEAD.`,
    `- ${String(breaks)} broken names whose every user at HEAD a task up to the breaking one declares.`,
    `- ${String(addedByPlan)} names the plan itself adds: a Create or Test file, or a name the plan defines.`,
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
    hasWord: word => {
      const result = spawnSync('git', ['grep', '-q', '-w', '-F', '-e', word, rev, '--']);
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(`git grep failed: ${result.stderr.toString().trim()}`);
      }
      return result.status === 0;
    },
  };
}

/** The npm packages any tracked `package.json` of the trees lists. Throws when one is not valid JSON. */
export function listDependencies(trees: Tree[]): Set<string> {
  const names = new Set<string>();
  for (const tree of trees) {
    for (const file of tree.listFilesNamed('package.json')) {
      const manifest = JSON.parse(tree.readFile(file) ?? '{}') as Record<string, unknown>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const listed = manifest[field];
        if (typeof listed === 'object' && listed !== null) {
          Object.keys(listed).forEach(name => names.add(name));
        }
      }
    }
  }
  return names;
}

/** The type names TypeScript declares in its own libraries. Throws when TypeScript is not installed. */
export function loadBuiltinTypeNames(): Set<string> {
  const lib = join(pathDirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'lib');
  const names = new Set<string>();
  for (const file of readdirSync(lib).filter(name => /^lib\..*\.d\.ts$/.test(name))) {
    for (const match of readFileSync(join(lib, file), 'utf8').matchAll(/\b[A-Z][\w$]*/g)) {
      names.add(match[0]);
    }
  }
  return names;
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

function listFiles(files: string[], max = 5): string {
  if (files.length === 0) {
    return 'none of them is in the repo';
  }
  const shown = files
    .slice(0, max)
    .map(file => `\`${file}\``)
    .join(', ');
  return files.length > max ? `${shown} and ${String(files.length - max)} more` : shown;
}

/** The line without its string literals and comments, so their words are not read as code. */
function stripCode(line: string): string {
  if (/^\s*(?:\*|\/\*)/.test(line)) {
    return '';
  }
  return line
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '');
}

function define(defined: Map<string, number>, name: string, line: number): void {
  if (!defined.has(name)) {
    defined.set(name, line);
  }
}

function defineGenerics(defined: Map<string, number>, generics: string | undefined, line: number): void {
  for (const generic of (generics ?? '').split(',')) {
    const name = /^\s*([A-Za-z_$][\w$]*)/.exec(generic)?.[1];
    if (name !== undefined) {
      define(defined, name, line);
    }
  }
}

/** `declarationsOnly` reads only keyword declarations, such as `type X = ...`, for prose that wraps code. */
function addCodeDefinitions(
  defined: Map<string, number>,
  code: string,
  line: number,
  { declarationsOnly = false } = {},
): void {
  for (const match of code.matchAll(DECLARATION)) {
    define(defined, match[1] ?? '', line);
    defineGenerics(defined, match[2], line);
  }
  if (declarationsOnly) {
    return;
  }
  for (const match of [...code.matchAll(DESTRUCTURING), ...code.matchAll(EXPORT_LIST)]) {
    for (const name of (match[1] ?? '').matchAll(/[A-Za-z_$][\w$]*/g)) {
      define(defined, name[0], line);
    }
  }
  const property = PROPERTY.exec(code)?.[1];
  if (property !== undefined && !KEYWORDS.has(property)) {
    define(defined, property, line);
  }
  // A call such as `run(task);` has the shape of a method too, so a method needs a return type or a body.
  const method = METHOD.exec(code);
  const name = method?.[1];
  if (
    method &&
    name !== undefined &&
    !KEYWORDS.has(name) &&
    (method[3] !== undefined || code.trimEnd().endsWith('{'))
  ) {
    define(defined, name, line);
  }
}

function addSignature(defined: Map<string, number>, token: string, line: number): void {
  const signature = SIGNATURE.exec(token);
  const name = signature?.[1];
  if (name !== undefined && !KEYWORDS.has(name)) {
    define(defined, name, line);
    defineGenerics(defined, signature?.[2], line);
  }
}

function addTypeNames(typeNames: Named[], code: string, at: Location): void {
  for (const match of code.matchAll(TYPE_NAME)) {
    typeNames.push({ ...at, name: match[0] });
  }
}

function addImports(imported: Map<string, string>, line: string): void {
  const match = /^\s*import\s+(?:type\s+)?(.*?)\s+from\s+['"]([^'"]+)['"]/.exec(line);
  const from = match?.[2] ?? '';
  // A relative or workspace import names repo code, which the tree lookups cover.
  if (match === null || from.startsWith('.') || from.startsWith('/') || from.startsWith('@dotli/')) {
    return;
  }
  for (const name of (match[1] ?? '').replace(/\btype\b/g, '').matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (name[0] !== 'as') {
      imported.set(name[0], from);
    }
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
    const plan = parsePlan(readFileSync(planPath, 'utf8'), topLevel, branches, listDependencies([baseTree, headTree]));
    if (plan.declared.length === 0) {
      throw new Error(
        'found no "- Create|Modify|Test|Delete|Rename|Move: `path`" line, so the plan does not follow the plan format',
      );
    }
    const report = checkPlanNames(plan, baseTree, headTree, createDisk(), loadBuiltinTypeNames());
    process.stdout.write(formatReport(report, { plan: planPath, base: base.slice(0, 12), head: head.slice(0, 12) }));
  } catch (error) {
    console.error(`checkPlanNames: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
