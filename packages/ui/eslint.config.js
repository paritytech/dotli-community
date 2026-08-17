// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from "@dotli/eslint-config/vite";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@dotli/protocol/broker",
              message:
                "Host code must open chains through @dotli/protocol/client.",
            },
            {
              name: "@dotli/resolver/chains",
              message:
                "Smoldot upstream ownership belongs to the protocol runtime.",
            },
            {
              name: "@dotli/resolver/rpc-chain",
              message:
                "RPC upstream ownership belongs to the protocol runtime.",
            },
          ],
        },
      ],
    },
  },
];
