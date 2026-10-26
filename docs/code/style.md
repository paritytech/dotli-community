# Code style

How code is shaped and how small pieces combine into bigger ones. The formatter owns layout (width, quotes, commas,
arrow parens), so nothing here repeats it. Where a rule in `AGENTS.md` says otherwise, that rule wins.

A rule says what to do. A rule whose reason is not obvious also says why.

## Building blocks

### A factory returns a plain object

Build a stateful unit as a `createX` factory. Keep its state in local variables and return an object literal of methods.
Bind the object to a const first when its methods call each other.

Why: the closure is the privacy boundary. There is no `this`, no `new`, no inheritance and nothing to bind, and the
returned object is easy to fake in a test.

```ts
// Do
export function createCounter({ initial = 0 }: Params) {
  let value = initial;

  return {
    read: () => value,
    increment() {
      value += 1;
    },
  };
}

// Don't
export class Counter {
  private value: number;
  constructor(initial = 0) {
    this.value = initial;
  }
  // ...
}
```

A class is allowed in three cases: an `Error` subclass, a data structure (a stack, a linked list, a graph), and a hot
path where a measured closure cost matters. In the last case keep the class private and export a factory that returns
it.

```ts
export function createTaskQueue(params: Params) {
  return new TaskQueue(params);
}

class TaskQueue {
  /* ... */
}
```

### The public type comes from the implementation

Derive a factory's type from the factory, and a data type that has a schema or codec from that schema or codec. Write a
hand-made type only for a contract that has more than one implementation. A factory whose type is derived this way has
no explicit return type.

Why: one source of truth. The type cannot drift from the code that produces the value.

```ts
// Do
export type Counter = ReturnType<typeof createCounter>;
export type Item = Infer<typeof itemSchema>;

// Don't
export type Counter = { read(): number; increment(): void };
export function createCounter(): Counter {
  /* ... */
}
```

### A module exports one named object per entity

When a module owns an entity, export one object named after the entity itself (`accounts`, `session`). Stateless helpers
for an entity go in an `xService` object. The object is the module's public API.

Why: call sites read as `entity.action()`. The larger the scope, the shorter the name, because the module name already
gives the context.

```ts
// Do
export const accounts = {
  list: readonly(list),
  add: addAccount,
  remove: removeAccount,
};

// Don't
export const accountsList = list;
export const addAccountToAccountsStore = addAccount;
```

## Functions

### Declarations at the top, arrows inline

A top-level function is a `function` declaration, exported or not, even when its body is one line. A named step inside a
factory is a declaration too. Arrows are only for callbacks and one-expression values inside a function body.

Why: the file reads top-down. A declaration hoists, so the public function opens the file and the helpers follow it.

```ts
// Do
export function parseList(source: string): string[] {
  return source.split(',').map(item => normalize(item));
}

function normalize(item: string) {
  return item.trim().toLowerCase();
}

// Don't
const normalize = (item: string) => item.trim().toLowerCase();

export const parseList = (source: string) => source.split(',').map(normalize);
```

### Params object for factories, two positional inputs at most

- A factory that builds a stateful unit takes its dependencies and options in one destructured object, typed by a local
  `Params`, with defaults in the destructuring.
- Any other function, including a `createX` that builds a value (`createAccountId(raw)`), takes at most two positional
  inputs. Optional inputs go in one trailing options object (`withRetry(load, { retries })`). Past two required inputs,
  everything goes in one object.

Why: call sites name their arguments, order stops mattering, and adding an option breaks no caller.

```ts
// Do
type Params = {
  fetch: Fetch;
  retries?: number;
  delay?: number;
};

export function createLoader({ fetch, retries = 3, delay = 200 }: Params) {
  /* ... */
}

// Don't
export function createLoader(fetch: Fetch, retries?: number, delay?: number, cache?: Cache) {
  /* ... */
}
```

### Function names start with a verb

`getX`, `mapX`, `parseX`, `applyX`, `fetchX`, `calculateX`. A factory is `createX`, a predicate is `isX` or `hasX`, and
a wrapper that returns the same interface with added behaviour is `withX`. Prefix an escape hatch that bypasses a check
with `unsafe_`. A library combinator is named after its pattern (`pipe`, `memo`, `first`).

Why: the name tells the reader what kind of thing it is before they read the body.

### One job per function

A function does one job. When a part of its body needs a comment to say what it does, that part is a separate named
function, and the outer body reads as a list of steps.

Why: a reader can follow the outer flow without reading every step.

## Composition

### Dependencies come in through parameters

A unit receives what touches the outside world (network clients, storage, timers, the clock, randomness) through its
params. An optional dependency defaults to the real one, so a composition root wires it and a test swaps it. Pure code
and another module's public API are imported.

Why: a test swaps any IO without module mocks.

```ts
// Do
// createRepository.ts
export function createRepository({ storage, client }: Params) {
  /* ... */
}

// createApp.ts
type Params = {
  adapters?: Partial<Adapters>;
};

export function createApp({ adapters }: Params) {
  const client = adapters?.client ?? createClient();
  const storage = adapters?.storage ?? createLocalStorage();
  const repository = createRepository({ storage, client });
  // ...
}

// Don't
import { storage } from './globalStorage.js';

export function createRepository() {
  /* reads `storage` directly */
}
```

### Inject through a framework only where the architecture defines it

Use a DI framework (slots, pipelines, feature injection) only when the project has one and its architecture says which
layers expose injection points and which inject into them. Then extend only along those paths.

Without such a framework, compose conventionally. The composition root lists the variants and passes them in as params,
and a closed set that one module owns is a `switch` (see "Branch on a union in its own function"). Never build an ad-hoc
registry that modules fill as a side effect of being imported.

Why: injection hides who calls whom. A defined architecture makes that hidden link predictable. Without one, explicit
composition keeps every link readable at the call site.

```ts
// Do: no DI framework, the composition root wires variants explicitly
const renderIcon = createIconRenderer({ renderers: [renderSpecialIcon, renderLegacyIcon] });

// Do: the architecture defines that features inject into page slots
specialFeature.inject(iconSlot, ({ item }) => {
  if (!isSpecial(item)) {
    return null;
  }
  return renderSpecialIcon(item);
});

// Don't: an ad-hoc registry filled on import
import './specialIcon.js'; // calls iconRegistry.add(...) at module load
```

### Wrap to add behaviour

Add a cross-cutting concern (cache, retry, dedupe, replay) as a wrapper that takes a function or object and returns one
of the same shape. Stack wrappers instead of growing the core.

Why: the core stays small, and each concern can be tested on its own.

```ts
const load = withCache(withRetry(fetchItem, { retries: 3 }));
```

### Share knowledge, not look-alike code

Before merging two similar blocks, ask: if this rule changes, must both copies change together, for the same reason?

- Yes: extract it, give it one owner, and let the others import it through the owner's public API.
- No: keep both copies, each inside its own boundary (a layer, a package, a domain).

Technical helpers with no domain meaning (a combinator, a collection helper, a codec) are shared from a library. Domain
rules are shared only inside their boundary. A shared function that gains a flag or branch for each new caller is
inlined back into its callers.

Why: a duplicate is cheap to remove later. A wrong abstraction couples every caller to every other.

```ts
// Do: two contexts, two rules that happen to look alike today
// billing
function isValidAmount(amount: number) {
  return amount > 0 && amount <= BILLING_LIMIT;
}
// transfers
function isValidAmount(amount: number) {
  return amount > 0 && amount <= TRANSFER_LIMIT;
}

// Don't: one helper that grows a branch per caller
function isValidAmount(amount: number, { context, allowZero }: { context: Context; allowZero?: boolean }) {
  /* ... */
}
```

### Name repeated control flow as a combinator

A control-flow pattern used in two places (first non-empty result, pipe, memo, sequence) becomes a small named
combinator in a library, and callers compose it.

Why: the composed form says what happens. The inline form makes the reader work it out.

## State

### Derive, don't store

A value computable from other state is computed from it, not stored and kept in sync.

Why: two stored copies drift. A derived value can't.

```ts
// Do
const visible = derive([items, filter], (all, query) => all.filter(i => matches(i, query)));

// Don't
const visible = createStore<Item[]>([]);
// ...plus an update in every place that changes items or filter
```

### Private writable, public read-only

The module that owns state writes it. Others get a read-only view and call the owner's actions to change it.

Why: there is one writer, so every change has one place to look.

### Mutate inside, stay immutable outside

Inside a function, mutate local accumulators freely (`push` into a local array, a `let` counter). Anything handed to a
caller or stored as shared state is replaced, never mutated. When nothing changed, return the same reference so callers
can skip work. A function mutates its input only as an in-place algorithm the caller asks for by name (`sortInPlace`),
and its JSDoc carries a `CAUTION` note.

Why: local mutation is the simplest code. Shared mutation is the hardest bug.

```ts
// Do
function upsert(list: Item[], next: Item) {
  const index = list.findIndex(i => i.id === next.id);
  if (index === -1) {
    return list.concat(next);
  }
  if (list[index] === next) {
    return list;
  }
  return list.map((item, position) => (position === index ? next : item));
}

// Don't
function upsert(list: Item[], next: Item) {
  list.push(next);
  return list;
}
```

### Every subscription returns its cleanup

`subscribe` returns an unsubscribe function, and a unit that holds a resource (a connection, a timer, a listener) has
`dispose()`. A shared source opens with its first subscriber and closes with its last.

Why: ownership of a resource is visible in the code that took it, and nothing leaks when the last user leaves.

## Control flow

### Guard first, then the happy path

Handle the empty, invalid or "not mine" cases with early returns at the top. The main logic then runs unindented.

Why: nesting depth stays at one or two, and each guard can be read alone.

```ts
// Do
function resolve(item: Item | null) {
  if (!item) {
    return null;
  }
  if (item.hidden) {
    return null;
  }
  return render(item);
}

// Don't
function resolve(item: Item | null) {
  if (item) {
    if (!item.hidden) {
      return render(item);
    }
  }
  return null;
}
```

### `for...of` over `forEach` and `for...in`

Loop with `for...of`. Use `map` and `filter` for pure transforms. Never `forEach` with a callback, never `for...in`.

Why: `for...of` supports `break`, `continue`, `return` and `await`, and does not walk prototype keys.

### Branch on a union in its own function

Handle each member of a union that one module owns in a function that takes the value and returns from a `switch` over
it, one `case` per member. Leave out `default`, so a new member fails the type check. A set that other modules extend is
composed instead (see "Inject through a framework only where the architecture defines it").

Why: the mapping has a name and one place to change, and the compiler finds every function a new member must reach.

```ts
// Do
function getStatusLabel(status: Status) {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'running':
      return 'Running';
    case 'failed':
      return 'Failed';
  }
}

// Don't
const label = status === 'idle' ? 'Idle' : status === 'running' ? 'Running' : 'Failed';
```

## Types

### `type`, not `interface`

Use `type` for every shape. Use `interface` only when declaration merging is the point.

Why: one construct for every shape, and unions and intersections read the same as objects.

### Unions, not enums

Model a closed set as a string literal union, and a variant as a discriminated union on one tag field (`kind`, `status`,
`tag`).

Why: unions erase to plain strings, narrow with `switch`, and need no import at the call site.

```ts
// Do
type State = { status: 'idle' } | { status: 'running'; data: Data } | { status: 'failed'; error: Error };

// Don't
enum Status {
  Idle,
  Running,
  Failed,
}
type State = { status: Status; data?: Data; error?: Error };
```

### Brand values that look alike

Give an identifier or encoded value that is a plain `string` or `Uint8Array` underneath a branded type, created only by
a parsing or constructing function.

Why: the compiler stops one kind of id being passed where another is expected.

```ts
export type AccountId = Branded<string, 'AccountId'>;

export function createAccountId(raw: string): AccountId {
  /* validate */
  // The one place a plain string becomes an AccountId
  return raw as AccountId;
}
```

### Parse at the boundary

Data from the network, storage or another context is parsed by a schema once, where it enters. Inside, code trusts the
types.

Why: validation lives in one place, and the inner code carries no defensive checks.

### Every cross-boundary message has a versioned format

A message that crosses a frame, a worker or the network follows "Parse at the boundary", plus:

- Its format is a schema or codec with a version field.
- The format has an encode and decode pair, or a validate function when the message travels as a plain JS value.
- The sender builds the message through the format.
- A message with an unknown version or shape is rejected with an error, never guessed at.
- A change to the shape is a new version. The receiver handles each version it supports explicitly.

Why: the two sides ship and update separately. A versioned format turns a mismatch into a clear error at the edge
instead of a wrong value deep inside.

```ts
// Do
const connectV1 = object({ version: literal(1), type: literal('connect'), origin: string() });
type ConnectV1 = Infer<typeof connectV1>;

port.onmessage = event => {
  const message = connectV1.parse(event.data);
  handleConnect(message);
};

// Don't
port.onmessage = event => {
  if (event.data.type === 'connect') {
    handleConnect(event.data.origin);
  }
};
```

### Strict everywhere, escape hatches only in library code

Type every value precisely. Write explicit return types on exported functions, except a factory whose type is derived
from it. Let inner functions infer. Narrow `unknown` with a type guard or a schema, never with a cast.

`any`, `as`, `as never`, `as unknown as X` and `@ts-expect-error` appear only inside library code: a generic helper
whose types are hard to derive, a typed wrapper around an untyped API, or the constructor of a branded type. Each one
carries a one-line reason. Application code has none. When application code seems to need one, fix the types of the
helper it calls.

Why: unsafe code is confined to a few small, tested helpers. Everything built on them stays fully checked.

```ts
// Do: the escape hatch is inside a generic helper, and callers get exact types
export function memo<Wrapped extends (arg: never) => unknown>(wrapped: Wrapped): Wrapped {
  const cache = new Map<unknown, ReturnType<Wrapped>>();
  // The wrapper has the same signature as `wrapped`, which TS can't infer from the closure
  return ((arg: unknown) => {
    /* ... */
  }) as never;
}

// Don't: a cast in application code hides a real type gap
const user = response.data as User;
```

### Generic names are words

Name a type parameter for what it holds (`Input`, `Output`, `Value`, `Meta`). A single `T` is fine when there is only
one and its meaning is obvious. A type helper that extracts is `InferX`.

## Errors

### Throw errors, catch at the boundary

A failure throws an `Error` or a class derived from it. Code in between lets it pass, and the layer boundary that can
act on it catches it there. No result wrappers inside a layer. A catch that adds context wraps the error with
`{ cause }`, and a catch that only filters rethrows the original unchanged.

Give a failure its own class (`class TimeoutError extends Error`) when a caller handles it differently from other
failures, or needs data about it. Callers tell failures apart with `instanceof` and read typed fields, never match
message strings. A shared base class groups a family of failures.

Why: one error model everywhere, and the happy path reads without unwrapping. A derived class makes the failure part of
the API.

```ts
// Do
export class TimeoutError extends Error {
  readonly name = 'TimeoutError';
  readonly url: string;
  readonly timeout: number;

  constructor(url: string, timeout: number) {
    super(`Request to ${url} timed out after ${timeout}ms`);
    this.url = url;
    this.timeout = timeout;
  }
}

try {
  await load(url);
} catch (error) {
  if (error instanceof TimeoutError) {
    return retryLater(error.url);
  }
  throw error;
}

// Don't
try {
  await load(url);
} catch (error) {
  if (String(error).includes('timed out')) {
    return retryLater(url);
  }
  throw error;
}
```

### Application code never swallows an error

In application code, a caught error is rethrown, or reported through the app's error channel and turned into a visible
outcome (a failed state, a message to the user, a status to the caller). Logging and continuing is allowed only in
scripts and dev tooling.

Why: a swallowed error leaves the app in a state nobody knows about, and the failure surfaces later with no trace to its
cause.

```ts
// Do
for (const plugin of plugins) {
  try {
    plugin.start();
  } catch (error) {
    reportError(error);
    markFailed(plugin, error);
  }
}

// Don't
for (const plugin of plugins) {
  try {
    plugin.start();
  } catch (error) {
    console.error(error);
  }
}
```

### Messages name the value and the place

An error message says what failed and includes the value that caused it.

```ts
// Do
throw new Error(`Unknown flag '${flag}' in ${source}`);

// Don't
throw new Error('Unsupported');
```

## Async

### Thread an `AbortSignal`

An async API that waits on the network, a timer or another context takes an optional `signal` and stops when it fires.

Why: the caller that started the work can stop it, without a flag on the side.

### Dedupe in-flight work

A repeated request for work that is already running joins that run instead of starting a second one. Use the project's
tool for it when there is one. Otherwise keep the pending promise and hand it to the repeated caller. A result cache,
when there is one, is kept apart from the running work, so a failed run is not cached.

### Serial when order matters

Run steps one after another when a step reads what an earlier one wrote, or when the user sees their order. Run them in
parallel otherwise.

## Modules

### One concept per file, named after its export

A file holds one factory or one concept, and is named after its main export in camelCase (`createLoader.ts`). A feature
folder may add `types.ts` and `constants.ts` for what several of its files share.

### Main export before its helpers

Imports, types, constants, then the main export, then the private helpers it uses.

Why: a reader opening the file sees what it offers before how it works.

### Named exports and one explicit barrel

Use named exports only. Each package has one `index.ts` that lists every public name. Type exports and value exports go
on separate lines, grouped by source module. No `export *` and no nested barrels.

Why: the barrel is the package's API, readable in one place.

```ts
// Do
export type { Loader } from './createLoader.js';
export { createLoader } from './createLoader.js';

// Don't
export * from './createLoader.js';
export default createLoader;
```

## Naming

- Use full words. The one exception is a single-letter parameter in a short callback, named after the entity's first
  letter (`accounts.filter(a => a.active)`).
- The larger the scope, the shorter the name. A module-level entity is `accounts`, and a local in a filter function is
  `activeAccounts`.
- Name a type after the role it plays (`XParams`, `XResult`, `XHandler`, `XAdapter`). A function's options type is
  `Params` while it is local, and `XParams` once exported.
- Name a module-level primitive or static table in SCREAMING_CASE (`DEFAULT_TIMEOUT`, `MAX_RETRIES`). A module's API
  object (`accounts`), a schema or codec (`itemSchema`) and every local stay camelCase.

## Comments

- A comment explains a quirk, a workaround or a constraint, never what the code does. Code with none of these has no
  comment.
- An exported library function gets a one-sentence JSDoc and a short usage example.

## Tests

- Test through the module's public API. Pass fakes through params, never mock modules.
- Use a table (`it.each`) when the same behaviour runs over three or more inputs.
- For a stream of events, collect them into an array and assert the whole sequence once.
- Assert a cache hit with identity (`toBe`), and structure with `toEqual`.
