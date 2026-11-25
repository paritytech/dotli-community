# A dependency declares a license the notices generator has not reviewed

A developer adds a dependency, and the generator of the third-party notices fails because a package in the lockfile
declares a license string it has not reviewed. The notices' intro speaks for every license family listed, so the string
cannot pass unread. The string is either an informal spelling of a known license that leaves a detail open, such as a
version without "only" or "or later", or a custom license with no SPDX id whose text falls back to a known license
outside some agreement. The question is how to list the strings. They could stay as they are. They could fold into one
known license. Or each could map in its own way.

## How to resolve

1. Read what each license text asks of the project, such as keeping the code unmodified.
2. Map an informal spelling of a known license to that license's SPDX section as an alias. Where the spelling leaves
   the variant open, such as "only" or "or later", pick the variant the project's own license uses.
3. List a custom license with no SPDX id in a section of its own, under the name the package declares. Do not fold it
   into the known license its text falls back to.
4. Add an intro sentence that says what the new sections ask and how the project uses them, such as only as build-time
   tooling.

The owner chose this without a reason beyond the option itself: the open variant follows the project's own license, and
the custom license keeps its own section rather than being listed as the license it falls back to.

## Example

```ts
const SECTIONS = [
  // ...
  'AGPL-3.0-only',
  'Acme Restricted License',
] as const;

const ALIASES: Record<string, string> = {
  'AGPL version 3': 'AGPL-3.0-only',
};

// Intro: The `AGPL-3.0-only` and `Acme Restricted License` packages are build-time tooling for the lint step.
// acme-math is used unmodified under the AGPL terms its license grants outside the Acme agreement.
```

Not this:

```ts
const ALIASES: Record<string, string> = {
  'AGPL version 3': 'AGPL-3.0',
  'Acme Restricted License': 'AGPL-3.0',
};
```

## Cases

- A contrast-math package for the Storybook a11y check declares a custom restricted license that falls back to AGPL v3
  outside a standards-body agreement and asks for unmodified code, and its dependency declares an informal "AGPL v3".
  Both are build-time tooling. The owner mapped the informal string to `AGPL-3.0-only`, gave the custom license its own
  section and added one intro sentence on both. (docs/_plans/apca-contrast-design.md)

Status: active
