// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where a product's frame loads from, and what it may do there.

import { BASE_DOMAIN, DEV_SANDBOX_PORT, getBackend, getNetwork, getLocalRoot } from '@dotli/config';
import { getResolutionId } from '@dotli/metrics';
import { getSandboxLabel } from '@dotli/resolver';
import { SANDBOX_SCHEMA_VERSION, type SandboxContractMessage } from '@dotli/sandbox-wire';
import { ERRORS } from '../../../kit/errors.js';
import { pendingResets } from '../../../kit/createPendingResets.js';
import { getAskedProductId, toProductId } from '../../../kit/getAskedProductId.js';
import type { FrameProduct, ProductFramePage } from './createProductFrame.js';

type PageLocation = ReturnType<ProductFramePage['location']>;

const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads';
const SUBDOMAIN_SANDBOX = `${IFRAME_SANDBOX} allow-popups`;

/**
 * Where the frame loads `product` from, and the contract the host wrote for a subdomain, or null for an iframe. The
 * contract is built once here, since it takes a scheduled sandbox reset, so the frame can be answered with it when it
 * asks. The URL carries no host-written contract params: the sandbox reads its contract only over the handshake.
 */
export type FrameTarget = { url: URL; contract: SandboxContractMessage | null };

/** A host-written contract, with the fields the host always writes present. Assignable to the wire message. */
type SandboxContract = SandboxContractMessage &
  Required<Pick<SandboxContractMessage, 'cid' | 'chainBackend' | 'network' | 'v'>>;

/**
 * The URL the frame loads `product` from and its contract. Building a subdomain's takes a scheduled sandbox reset.
 * Throws when an app subdomain's deep path leaves its origin.
 */
export function buildFrameUrl(product: FrameProduct, location: PageLocation): FrameTarget {
  switch (product.mode) {
    case 'iframe':
      return { url: new URL(product.url, location.href), contract: null };
    case 'subdomain':
      return buildSandboxUrl(product, location);
  }
}

/**
 * The contract the host writes for a subdomain `product`, each field the string the wire carries. Takes a scheduled
 * sandbox reset, so it runs once per render and feeds the contract reply.
 */
function buildSandboxContract(product: Extract<FrameProduct, { mode: 'subdomain' }>): SandboxContract {
  const resolutionId = getResolutionId();
  return {
    type: 'dotli:sandbox-contract',
    cid: product.cid,
    v: String(SANDBOX_SCHEMA_VERSION),
    chainBackend: getBackend(),
    network: getNetwork(),
    ...(pendingResets.take('sandbox') ? { fullReset: '1' } : {}),
    ...(resolutionId !== null ? { resolutionId } : {}),
  };
}

/** The product id `product` asks the core for. */
export function getFrameProductId(product: FrameProduct): string {
  switch (product.mode) {
    case 'iframe':
      return getAskedProductId(product);
    case 'subdomain':
      return toProductId(product.label);
  }
}

/** The `sandbox` attribute of `product`'s frame. */
export function getFrameSandbox(product: FrameProduct): string {
  switch (product.mode) {
    case 'iframe':
      return IFRAME_SANDBOX;
    case 'subdomain':
      return SUBDOMAIN_SANDBOX;
  }
}

/** The origin of the app subdomain of `label`, as seen from the host page at `location`. */
export function getAppOrigin(label: string, location: PageLocation): string {
  const root = getLocalRoot(location.hostname);
  if (root !== null) {
    const port = import.meta.env.DEV ? DEV_SANDBOX_PORT : location.port;
    return `${location.protocol}//${getSandboxLabel(label)}.app.${root}:${port}`;
  }
  return `https://${getSandboxLabel(label)}.app.${BASE_DOMAIN}`;
}

/**
 * The frame URL is the product's own origin, deep path and the visitor's own query. The host writes no contract params
 * into it: the sandbox reads its contract only over the authenticated handshake, so a visitor's own query keys pass
 * through unchanged.
 */
function buildSandboxUrl(product: Extract<FrameProduct, { mode: 'subdomain' }>, location: PageLocation): FrameTarget {
  const origin = getAppOrigin(product.label, location);
  const deepPath = getDeepPath(location, product.base ?? '');
  const url = new URL(deepPath ? `${origin}${deepPath}` : origin);
  if (url.origin !== origin) {
    throw new Error(ERRORS.CROSS_ORIGIN_APP_URL);
  }
  const contract = buildSandboxContract(product);
  return { url, contract };
}

function getDeepPath(location: PageLocation, productBase: string): string {
  const { pathname, search, hash } = location;
  let path = pathname;
  const base = import.meta.env.BASE_URL;
  if (base !== '/' && path.startsWith(base)) {
    path = '/' + path.slice(base.length);
  }
  if (productBase !== '' && path.startsWith(productBase)) {
    path = path.slice(productBase.length);
  }
  const isRoot = path === '' || path === '/';
  if (isRoot) {
    return search || hash ? search + hash : '';
  }
  return path + search + hash;
}
