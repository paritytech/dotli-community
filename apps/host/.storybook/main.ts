// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { inlineScript } from '@config/vite/inline-script';
import { storybookMain } from '@config/storybook/main';

// The sandbox checker stories frame a product page that inlines its script, bundled as the build does.
export default storybookMain({ plugins: () => [inlineScript()] });
