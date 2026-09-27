// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from "@dotli/eslint-config/vite";

// The shared config's `no-restricted-syntax` entries. A file override
// replaces a rule's options rather than merging them, so the shell override
// below repeats these.
const sharedRestrictedSyntax = config
  .map((entry) => entry.rules?.["no-restricted-syntax"])
  .filter((rule) => rule !== undefined)
  .at(-1)
  .slice(1);

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The shell's islands (components/shell/islands.tsx) render into a
    // detached container, which is where Solid delegates `onClick`-style
    // events: they would never fire once the island is swapped in. The
    // landing page follows the same rule, since it moves island nodes into
    // its own tree.
    files: ["src/components/shell/**/*.tsx", "src/components/landing/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...sharedRestrictedSyntax,
        {
          selector: "JSXAttribute[name.name=/^on[A-Z]/]",
          message:
            "Solid's delegated events do nothing in a shell island (it renders into a detached container). Add a native listener in a callback ref instead (see components/shell/islands.tsx).",
        },
      ],
    },
  },
];
