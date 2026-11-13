// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { isPhoneViewport, watchPhoneViewport } from '@dotli/ui';
import { isMobileDevice } from './isMobileDevice.js';
import { productFrameLayout, type ProductFrameLayout } from './createProductFrameLayout.js';

type Params = {
  /** Touch devices have no hover to bring a folded bar back, so their bar never folds. The page's own unless given. */
  isMobile?: () => boolean;
  /** The page's own unless given. */
  isPhone?: () => boolean;
  /** Returns the unwatch. The page's own unless given. */
  watchPhone?: (onChange: () => void) => () => void;
  /** The page's own unless given. */
  layout?: Pick<ProductFrameLayout, 'setTopbarLayout'>;
};

/**
 * Keeps the product frame clear of a bar that never folds, on a touch device or a phone-width window, rather than
 * under it for good. Follows the viewport until the returned stop. Throws only as `watchPhone` does.
 */
export function watchTopbarOffset({
  isMobile = isMobileDevice,
  isPhone = isPhoneViewport,
  watchPhone = watchPhoneViewport,
  layout = productFrameLayout,
}: Params = {}): () => void {
  syncOffset();
  return watchPhone(syncOffset);

  function syncOffset(): void {
    layout.setTopbarLayout({ offset: isPhone() || isMobile() });
  }
}
