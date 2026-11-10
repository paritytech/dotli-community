# `@dotli/resolver`

## Overview

Resolves a `.dot` name to its manifests and content hash from the dotNS contracts. Owns the dotNS naming rules.

## Responsibilities

- **Owns** dotNS reads:
  - Registry and ContentResolver storage
  - contenthash decoding
  - manifest records
  - a name's owner
- **Owns** the wait for chain sync before a read, and the resolution errors.
- **Owns** the naming rules:
  - product hosts
  - valid labels and names
  - sandbox labels
  - manifest kinds
- **Does not own**:
  - chain connections
  - content fetching
  - the label to CID cache

## Public API

### `@dotli/resolver`

| Export                                                                                       | What it does                               |
| -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `createDotnsResolver`, `DotnsResolver`, `ResolveOptions`, `ResolvePhase`, `ChainClient`      | Resolves a name.                           |
| `toRootManifestResult`, `toExecutableManifestResult`                                         | Validate manifest text.                    |
| `RootManifest`, `ExecutableManifest`, `ManifestResult`, `AppVersion`                         | Manifest types.                            |
| `dotNsUrl`                                                                                   | Tells a product host from a website.       |
| `validateDotLabel`, `isValidDotLabel`, `validateDotName`, `isValidDotName`, `DotLabelResult` | Name validation.                           |
| `getSandboxLabel`                                                                            | A product's sandbox origin label.          |
| `isExecutableKind`                                                                           | Whether a kind has an executable manifest. |
| `ResolverErrorName`, `isApiStoppedError`                                                     | Resolution errors.                         |
| `loadResolve`                                                                                | Lazy loader.                               |

## Design

- **Passed-in connection:** the resolver reads through the Asset Hub follow its owner already keeps.
- **Direct storage reads:** contracts are read from Revive storage slots, with no runtime call. A multi-slot read pins
  one block, so bytes are never torn.
- **Halts:** a read on a halted chain is retried a few times. The resolver spots a halt by the shared marker, so it
  never imports the chain pool.
- **Sync wait** has a timeout, since a chain with no peers never syncs.
- **Error names** are read verbatim by dashboards and Sentry filters. Never rename them.
- **Lazy loading:** the resolver is heavy and loads through `loadResolve`. Manifest validators stay off the chain code,
  so the eager path can take them.

### Naming rules

- **Label:** lowercase ASCII letters and digits, with inner hyphens. A registered label has at least 2 characters.
- **No `xn--`:** a punycode label can look like another name.
- **Subname sandbox label:** `sn--` plus a hash of the name, since a wildcard certificate covers one label. So no label
  may start with `sn--`.
- **Sandbox labels are frozen:** a product's origin and all its storage hang on its sandbox label. Changing how the
  label is made drops every user's data.
- **Contracts first:** check a rule change against the dotNS contracts (paritytech/dotns). Never refuse a name they can
  register.
