// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';

const OFF_SPECS = 'src/**/*.off.spec.ts';

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        extends: true,
        // On, so a test reads what the module sends to a bound fake.
        test: {
          name: 'metrics:unit',
          env: { VITE_METRICS: 'true' },
          include: ['src/**/*.spec.ts'],
          exclude: [OFF_SPECS],
          environment: 'node',
        },
      },
      {
        extends: true,
        // Off, as a build without metrics compiles the module.
        test: {
          name: 'metrics:off',
          env: { VITE_METRICS: 'false' },
          include: [OFF_SPECS],
          environment: 'node',
        },
      },
    ],
  },
});
