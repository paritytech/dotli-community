// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { RotateCwIcon } from '@dotli/ui/icons';
import { createReporter } from '@dotli/metrics';
import { showError } from '@dotli/ui';
import { bootTracker } from './createBootTracker.js';
import { markAndReload } from './createContinuation.js';
import { productState } from './runtime/state/productState.js';
import { describeError } from './describeError.js';
import { RELOAD_BTN_LABEL } from './errorCopy.js';

const report = createReporter({ flow: 'boot' });

/** For a failure before either page had anything to show: reports it under the boot's step and shows the error screen. */
export function reportBootFailure(error: unknown): void {
  report.capture(error, { step: bootTracker.getStep() });
  const description = describeError(error);
  showError(description.title, {
    detail: description.message,
    action: {
      label: RELOAD_BTN_LABEL,
      icon: RotateCwIcon,
      onClick() {
        markAndReload('reload_button');
      },
    },
  });
  productState.setError();
}
