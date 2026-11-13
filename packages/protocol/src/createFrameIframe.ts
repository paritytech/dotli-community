// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getResolutionId } from '@dotli/metrics';
import type { FrameDocument, FrameElement, ProtocolFrameConfig } from './frameTypes.js';
import { FRAME_MODES } from './getBackendOfFrameMode.js';

type Params<E extends FrameElement> = {
  document: FrameDocument<E>;
  /** The frame's origin, which serves it. */
  origin: string;
  config: ProtocolFrameConfig;
};

/** The hidden iframe of the protocol frame at `origin` for `config`, built on `document` and not yet mounted. */
export function createFrameIframe<E extends FrameElement>({ document, origin, config }: Params<E>): E {
  const iframe = document.createElement('iframe');
  const params = new URLSearchParams();
  params.set('mode', FRAME_MODES[config.backend]);
  params.set('network', config.network);
  if (config.skipWorkerCache) {
    params.set('skipWorkerCache', '1');
  }
  // On the URL, not posted after load, because the iframe's Sentry client emits before any handshake.
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    params.set('resolutionId', resolutionId);
  }
  // The build serves the frame at /p/ on its origin.
  iframe.src = `${origin}/p/?${params.toString()}`;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  iframe.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;';
  return iframe;
}
