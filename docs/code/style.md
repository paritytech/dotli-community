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

### Params object for factories, three parameters at most

- A factory that builds a stateful unit takes its dependencies and options in one destructured object, typed by a local
  `Params`, with defaults in the destructuring.
- Any other function, including a `createX` that builds a value (`createAccountId(raw)`), takes at most three
  parameters, a trailing options object included. Optional inputs go in that options object
  (`withRetry(load, { retries })`). Past three, everything goes in one object. ESLint's `max-params` checks the count.
  A function whose signature a third-party interface fixes keeps it, and disables the rule naming that interface. Test
  code is exempt, since its helpers and table rows take their inputs positionally.

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

A callback slot named for its role (`onMessage`, `handler`) and a member whose name a third-party interface fixes keep
their names. A read accessor on an entity object is still `getX`.

Why: the name tells the reader what kind of thing it is before they read the body.

### One job per function

A function's body reads top to bottom as the flow it implements. Extract a step only when another place calls it, or
when its name tells the reader what a block of several lines does that the code does not show. A step of one or two
lines stays inline, with a comment when its reason is not obvious.

A function that only forwards to another, renames a call or passes its arguments through is inlined at its call site.
So is a helper called once whose body is no harder to read than its call.

Why: a reader follows the flow in one place. Each hop to a helper costs more than the lines it hides.

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

### Pass collaborators whole, grouped by owner

A parameter a module only hands on is typed by reference to its owner, as `Owner['member']` or
`Pick<Owner, 'a' | 'b'>`, never restated. Collaborators that one owner provides travel as one object. What one
instance owns, such as its scope, its trackers and its liveness checks, is one context object, built where the
instance is built and handed on whole. Only the module that uses a part of it picks that part.

A lazy chunk whose capabilities eager code calls from several modules exports one typed facade object. Eager code
takes it as `() => Promise<Facade>`, or a `Pick` of it, never a wrapper per capability. A chunk loaded for one
component or one call may return its module namespace.

Why: a hop that restates or re-picks a collaborator changes whenever the collaborator does, and so does every spec
that builds the hop. Handed on whole, a new member edits its owner and its user only.

```ts
// Do
type Params = {
  job: JobContext;
  prompts: Pick<Prompts, 'ask'>;
  reports: () => Promise<Pick<ReportsChunk, 'export' | 'print'>>;
};

// Don't
type Params = {
  label: string;
  scope: Scope;
  tracker: Tracker;
  ask: (question: Question) => Promise<Answer>;
  exportReport: () => Promise<void>;
  printReport: () => Promise<void>;
};
```

### Inject through a framework only where the architecture defines it

Use a DI framework (slots, pipelines, feature injection) only when the project has one and its architecture says which
layers expose injection points and which inject into them. Then extend only along those paths.

Without such a framework, compose conventionally. The composition root lists the variants and passes them in as params,
and a closed set that one module owns is a `switch` (see "Branch on a union with a `switch`"). Never build an ad-hoc
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

A control-flow pattern longer than a few lines and used in three or more places (first non-empty result, pipe, memo,
sequence) becomes a small named combinator in a library, and callers compose it.

Why: the composed form says what happens. The inline form makes the reader work it out.

## State

### App state is a nanostores store

App state is a nanostores `atom`, and a value computed from stores is a `computed`. The owning module keeps the writable
atom and exposes it as `ReadableAtom`. A follower calls `listen`, which waits for the next change. `subscribe` also
calls it at once, so use it only where the current value is wanted too.

```ts
// Do
const status = atom<Status>('idle');
const statusStore: ReadableAtom<Status> = status;
export const connection = { status: statusStore };

connection.status.listen(next => {
  report(next);
});

// Don't
export const status = atom<Status>('idle');
```

### Derive, don't store

A value computable from other state is computed from it, not stored and kept in sync.

Why: two stored copies drift. A derived value can't.

```ts
// Do
const visible = computed([items, filter], (all, query) => all.filter(i => matches(i, query)));

// Don't
const visible = atom<Item[]>([]);
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

### A lifecycle is one state value

A unit has a lifecycle when it has three or more phases, or when an await, a callback or a timer reads its phase. It
runs that lifecycle on `createStateMachine` from `@dotli/shared`. A latch that only makes a callback race settle once
keeps a plain flag, and so does a unit with one or two flags and no async work.

The state is a discriminated union with one member per phase, and only the machine's transitions write it. What a phase
owns lives in its member, such as the timer of a wait or the controller of a request in flight, never in a nullable slot
or a flag beside it. Facts that are not phases, such as a config or a count of holds, sit beside the state. A unit that
can be disposed has a disposed state with no handlers, so every later event is ignored.

How a handler moves the machine:

- A handler emits its next state before it calls out, so a collaborator that reads the state during the call sees it
  moved. A resource whose stop the next state holds, such as a listener or a tick, starts before the state is emitted.
- A handler sends through its transition's own `update`. No handler refers to the machine, and neither does a callback
  or a timer it starts.
- Async work that settles by itself enters the machine as `update(promise)`, a promise that resolves to the event, with
  its failure mapped to an event too. Only such work does, so `await()` never waits out a timer. A timer, a tick or a
  listener calls `update(event)` from its callback.
- A timer or callback that can outlive its state carries that state value, and its handler acts only while the state is
  still that value.
- A handler that several states share is a named function typed `HandlerOf<Machine, Kind, EventKind>`, and each state's
  table lists it by name. A table is never built by spreading a shared object into it.
- A handler that can stop the work it starts threads an `AbortSignal` into it (see "Thread an `AbortSignal`").

How the unit around the machine is shaped:

- `state`, `update` and `await()` are the machine's whole API. A caller that waits for the machine to settle calls
  `await()`. It never waits on work kept beside the state, such as a promise or a reply.
- A unit's params are typed from their owners, as `Pick<Owner, ...>` or `Owner['member']`, grouped by owner.
- A unit that reports what happens to it emits effects, and one runner turns them into its reports.
- No function returns a value of two unlike kinds, such as `boolean | Error`. Cases that lead to one value are the
  default, not a branch each.
- No module constant, type or function is used in one place only. A `defineCount` metric and a module reporter are
  exceptions, and so is a name that saves the reader working out a block. A machine's state, event and effect unions
  are such names, and so are a factory's `Params` type and the options type of one of its methods.

One unit runs one machine, and every lifecycle nested in it is part of that machine's state:

- A run whose steps hide inside one phase is nested. Its steps become states.
- A sub-phase whose events change what the phase around it does is coupled to it, and is flattened into the kinds
  around it.
- A sub-phase that moves on events its phase ignores is independent. It is a field of the phase's member, typed as its
  own union, and `nest` runs it.
- A machine per key is a `ReadonlyMap` field of the phase's member, and `nest` runs each value. An event for a key that
  left, or for a sub-phase that moved on, is ignored with no guard.
- A keyed value leaves when its handler emits a state that `store` drops, and leaving a phase ends its independent
  sub-phase.
- A run that goes on beside other work has its steps as the kinds of its nested value.
- A nested value never moves its parent. It sends the parent an event, and the parent's own handler moves it.
- A collaborator from another module keeps its own machine. A parent that waits for it sends
  `update(collaborator.await().then(...))`, so its own `await()` covers that wait. The phase that owns the collaborator
  holds it in its member and hears its subscriptions as events of the parent.

Why: one value names every phase, and the machine handles one event at a time. A stale event finds a state with no
handler for it, so it needs no check.

```ts
// Do
type State =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  | { kind: 'fetched'; profile: Profile }
  | { kind: 'failed'; error: unknown };

type Event =
  | { kind: 'asked' }
  | { kind: 'profileFetched'; profile: Profile }
  | { kind: 'fetchFailed'; error: unknown };

type ProfileMachine = MachineTypes<State, Event>;

const startFetch: HandlerOf<ProfileMachine, 'idle' | 'failed', 'asked'> = (_state, _event, { emitState, update }) => {
  emitState({ kind: 'fetching' });
  update(
    fetchProfile().then(
      profile => ({ kind: 'profileFetched', profile }),
      (error: unknown) => ({ kind: 'fetchFailed', error }),
    ),
  );
};

const machine = createStateMachine<ProfileMachine>({
  initial: { kind: 'idle' },
  handlers: {
    idle: { asked: startFetch },
    fetching: {
      profileFetched(_state, { profile }, { emitState }) {
        emitState({ kind: 'fetched', profile });
      },
      fetchFailed(_state, { error }, { emitState }) {
        emitState({ kind: 'failed', error });
      },
    },
    fetched: null,
    failed: { asked: startFetch },
  },
  onError: error => report.defect(error),
});

// Don't
let fetching = false;
let failed = false;
let profile: Profile | null = null;
```

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

### Branch on a union with a `switch`

Map a union with a `switch`, one `case` per member, and no `default`, so a new member fails the type check. A mapping
used in one place stays where it is used. It becomes a named function when a second place needs it. A set that other
modules extend is composed instead (see "Inject through a framework only where the architecture defines it").

Only the module that owns the union compares its raw tag. A union read outside its owner gets named views or predicates
exported beside it, and readers outside ask those. A reader that holds facts of its own for every member, such as its own
copy per member, maps every member in a `switch` or a `satisfies Record<Member, …>` table. It never picks out one member
with `===`, and never groups members in one `case` to answer a question the owner could name.

A function that reads only some members of a large union lists those and ends with a `default`, with a one-line reason.

Why: the mapping has a name and one place to change, the compiler finds every function a new member must reach, and a
reader that only asks a question stays unchanged when a member is added.

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
    case 'done':
      return 'Done';
  }
}

// Don't
const label = status === 'idle' ? 'Idle' : status === 'running' ? 'Running' : 'Failed';
```

```ts
// Do: the owner module names the question
export function isTerminal(status: Status): boolean {
  switch (status) {
    case 'idle':
    case 'running':
      return false;
    case 'failed':
    case 'done':
      return true;
  }
}

// In a reader module
if (isTerminal(job.status)) {
  // ...
}

// Don't: a reader module picks members out itself
if (job.status === 'failed' || job.status === 'done') {
  // ...
}
```

### A variant flag is a predicate

A mode or kind that changes behaviour in several places (a backend, a wallet mode) is answered by a capability predicate
its owner exports, never compared at each site. When the variant is fixed before its readers are built, pass a strategy
object picked once instead.

Why: a reader asks the question it means, and adding a variant edits the owner's table, not every reader.

```ts
// Do
if (hasOfflineCache(storage)) {
  // ...
}

// Don't
if (storage === 'indexeddb' || storage === 'opfs') {
  // ...
}
```

## Types

### `type`, not `interface`

Use `type` for every shape. Use `interface` only when declaration merging is the point.

Why: one construct for every shape, and unions and intersections read the same as objects.

### Unions, not enums

Model a closed set as a string literal union, and a variant as a discriminated union on one tag field (`kind`, `status`,
`tag`).

When the set is also needed at run time, write the union first and type the list or set by it
(`const NETWORK_NAMES: readonly Network[] = ['paseo-next-v2', 'previewnet']`). Never derive the union from an
`as const` list.

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

### `null` for a known empty value

A value the code knows is empty is `null`. That covers a slot with nothing in it yet and a lookup that found nothing.
It also covers a return with no result. `undefined` means only "not given", such as an optional parameter or property
left out. Turn an `undefined` from a platform or library API into `null` where it enters the code.

Why: `null` is set on purpose, so a reader tells "known to be empty" apart from "never set".

```ts
// Do
function findAccount(id: AccountId): Account | null {
  return accounts.get(id) ?? null;
}

// Don't
function findAccount(id: AccountId): Account | undefined {
  return accounts.get(id);
}
```

### Per-member facts in one table

Facts the owner knows about each member (a label, a tone, a default, a policy) live in one table beside the union, typed
`satisfies Record<Member, Facts>`, so a new member fails the check until its row exists. Predicates read the table.
Fixtures and stories import the table instead of copying it. A fact that is a component, or that would pull code into a
chunk that must not load it, stays in its own `Record` in the layer that renders it.

Why: one row per member is one edit per member, and a copy in a fixture cannot drift.

```ts
type Plan = 'free' | 'team';

const PLAN_FACTS = {
  free: { label: 'Free', seats: 1 },
  team: { label: 'Team', seats: 10 },
} satisfies Record<Plan, { label: string; seats: number }>;

function getSeats(plan: Plan): number {
  return PLAN_FACTS[plan].seats;
}
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

A store read back only by the module that writes it may trust its records. The change that alters a record's shape adds
its guard or migration.

Why: validation lives in one place, and the inner code carries no defensive checks.

### Every cross-boundary message has a versioned format

A message that crosses a frame, a worker or the network follows "Parse at the boundary", plus:

- Its format is a schema or codec with a version field.
- The format has an encode and decode pair, or a validate function when the message travels as a plain JS value.
- The sender builds the message through the format.
- A message with an unknown version or shape is rejected with an error, never guessed at.
- A change to the shape is a new version. The receiver handles each version it supports explicitly.
- An error that crosses is an error codec: a class extending `Error` with a name and a typed payload, plus its encode
  and decode pair. A family of them is one enum codec. The transport decodes it back into an instance of its class
  before any consumer sees it, so consumers tell failures apart with `instanceof`. Never hand consumers a name or a
  message to match.

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

A union of expected answers that the caller presents differently (a name with no content, an unsupported version) is a
domain outcome, not a result wrapper. A failure of the code or the transport still throws.

Give a failure its own class (`class TimeoutError extends Error`) when a caller handles it differently from other
failures, or needs data about it. Callers tell failures apart with `instanceof` and read typed fields, never match
message strings. A shared base class groups a family of failures.

A failure that reaches another package in another form than its class, such as a JSON-RPC error object or a copy rebuilt
after crossing a frame or worker, is recognised by a predicate the package that owns the failure or its marker exports.
The predicate knows every form. Callers never match the message text.

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

An async API that waits on the network, a timer or another context takes an optional `signal` once a caller can stop
the work, and stops when it fires. With no such caller, leave the `signal` out and add it in the change that brings
one. On an abort it rejects with `signal.reason`, so a timeout or a caller's own reason reaches the caller. A pool whose
works must never overlap, even across an abort, holds its slots on abort.

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

- The file keeps the private helpers, types, constants and state that serve its main export. A getter that reads state
  the main export keeps stays beside it.
- Split a piece into its own file only when it is a concept of its own that other modules build on, never because it is
  a separate function, table or value.

- A camelCase module never shares its name with a PascalCase component in the same folder (`authModal.ts` beside
  `AuthModal.tsx`), because a case-insensitive file system resolves an import of one to the other. Name the module
  after its export instead.
- Names that something outside the code depends on keep their form: package and app folders, package `exports` keys,
  and a file whose name a URL or a tool loads by path, such as a service worker entry.

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
  `Params` while it is local, and `XParams` once exported. In a file with several, the main export's is `Params` and
  each other function's is `<FunctionName>Params`.
- Name a module-level primitive or static table in SCREAMING_CASE (`DEFAULT_TIMEOUT`, `MAX_RETRIES`). A module's API
  object (`accounts`), a schema or codec (`itemSchema`) and every local stay camelCase.

## Comments

- A comment explains a quirk, a workaround or a constraint, never what the code does. Code with none of these has no
  comment.
- An exported library function gets a one-sentence JSDoc. Add a short usage example only when the signature does not
  show the use, such as a generic helper, a combinator or a multi-step API.

## Tests

A test documents a behaviour or guards an edge case. Confidence comes from the types and the code flow, so a test that
only pins the current code goes.

Keep a test that:

- documents a public behaviour of its module that the types do not show, told as what a caller sees
- guards an edge case: a failure path, a race or overlap, idempotency or dedupe, retry and recovery, a boundary input, a
  cleanup that releases a resource, a limit that keeps a repeated failure from flooding the log, or Safari's storage
  partition
- is the regression test of a real bug: it guards the defect that the commit or issue adding it names. A commit that
  only creates, moves or renames the spec, or groups review fixes, makes no case a regression test

Cut a test that:

- restates the types: a shape, a field's presence, or a value passed through unchanged
- pins implementation detail: a call count or argument on an internal fake, internal step order, or a breadcrumb or log
  line. A count is the contract when the case is about doing the work once
- repeats a case another kept test asserts. When two layers assert one behaviour, the spec of the module that owns it
  keeps it, and a caller keeps its copy only as the only test of a parameter it passes on. A case that re-tests a shared
  helper's contract, such as a listener set that survives a throwing listener, repeats the helper's own spec when its
  module adds only the wiring
- tests a getter, a constant, a re-export, a one-line helper its callers' specs cover, or a third-party library's own
  behaviour

A cut never removes the only test of a failure path, a race or a recovery. A regression test keeps its bug guarded, not
its case: when a kept test asserts the same failing input and outcome, the regression case goes. A one-line helper keeps
one case for a boundary input its callers' specs miss. Siblings merge into one `it.each` table only when one assertion,
with its expected value taken from the row, covers them all. A metric is a contract in a failure-path case, or when
emitting it is the documented job of the dependency it goes through. In a race case, the absence of a warning is how the
test shows the late message was expected. A parser or validator whose input the types leave open, such as `unknown`, a
string or URL params, keeps one case for each shape it accepts in its own spec, even when its callers' specs cover it,
since the types do not show what passes. A case that checks a type with `@ts-expect-error` guards that type, so it does
not restate it.

A test never looks like this:

- **The same case over equal inputs.** It runs a case again with another input that takes the same branch, such as a
  second local root or a second backend. One input per branch.
- **A wrapper retesting its inner module.** A caller's spec asserts what the module it wraps already asserts in its own
  spec. The caller tests only what it adds.
- **A regression test that passes without its fix.** A regression test fails when its fix is reverted. One that still
  passes guards nothing, so it goes, and the gap is recorded instead.
- **A regression test bigger than its bug.** One bug gets one case, the smallest that fails without the fix. It has:
  - no second direction of the same bug
  - no table rows beyond the one that shows it
  - no setup the bug does not need
- **A name that claims more than its Then.** The name states only what `// Then` asserts.
- **Copy or markup with no behaviour behind it.** It asserts a label's exact text or an `aria-label` string. It asserts
  the order of elements. Assert the role or state a user acts on instead.
- **A story play that adds no behaviour.** A play that only checks copy or DOM order goes, and so does one that checks a
  styling hook. The story stays as a visual doc. A story that shows the same state as another story in its file goes.
- **A browser case a unit spec covers.** A Playwright or e2e suite keeps one case per host branch that needs a real
  browser, for its storage, its frames or its network. It never repeats what a unit spec asserts.
- **A disabled test left in place.** A `test.fixme` or `it.skip` waiting on an upstream fix is switched back on once the
  fix lands, or deleted. It never stays disabled without a tracking issue.

How a test is written:

- Test through the module's public API. Pass fakes through params, never mock modules.
- Use a table (`it.each`) when the same behaviour runs over three or more inputs.
- For a stream of events, collect them into an array and assert the whole sequence once.
- Assert a cache hit with identity (`toBe`), and structure with `toEqual`.
