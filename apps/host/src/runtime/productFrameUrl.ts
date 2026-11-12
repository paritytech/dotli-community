// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Where a product's frame loads from, and what it may do there.

import { BASE_DOMAIN, DEV_SANDBOX_PORT, getBackend, getNetwork, getLocalRoot } from '@dotli/config';
import { getResolutionId } from '@dotli/metrics';
import { getSandboxLabel } from '@dotli/resolver';
import { removeContractParams, SANDBOX_CONTRACT_PARAMS, SANDBOX_SCHEMA_VERSION } from '@dotli/sandbox-wire';
import { ERRORS } from './errors.js';
import { pendingResets } from './createPendingResets.js';
import { toProductId } from './createTruapiRuntimeConfig.js';
import type { FrameProduct, ProductFramePage } from './createProductFrame.js';

type PageLocation = ReturnType<ProductFramePage['location']>;

const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-pointer-lock';
const SUBDOMAIN_SANDBOX = `${IFRAME_SANDBOX} allow-popups`;

/**
 * The URL the frame loads `product` from. Building a subdomain's takes a scheduled sandbox reset. Throws when an app
 * subdomain's deep path leaves its origin.
 */
export function buildFrameUrl(product: FrameProduct, location: PageLocation): URL {
  switch (product.mode) {
    case 'iframe':
      return new URL(product.url, location.href);
    case 'subdomain':
      return buildSandboxUrl(product, location);
  }
}

/** The product id `product` asks the core for. */
export function getFrameProductId(product: FrameProduct): string {
  switch (product.mode) {
    case 'iframe':
      return product.productId ?? toProductId(product.label);
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

/** The sandbox validator rejects unknown params. */
function buildSandboxUrl(product: Extract<FrameProduct, { mode: 'subdomain' }>, location: PageLocation): URL {
  const origin = getAppOrigin(product.label, location);
  const deepPath = getDeepPath(location, product.base ?? '');
  const url = new URL(deepPath ? `${origin}${deepPath}` : origin);
  if (url.origin !== origin) {
    throw new Error(ERRORS.CROSS_ORIGIN_APP_URL);
  }
  // Only the host writes the sandbox's params. A visitor's link that carried them could purge the sandbox origin or
  // name a resolution.
  const contract = new URLSearchParams();
  contract.set(SANDBOX_CONTRACT_PARAMS.cid, product.cid);
  contract.set(SANDBOX_CONTRACT_PARAMS.v, String(SANDBOX_SCHEMA_VERSION));
  contract.set(SANDBOX_CONTRACT_PARAMS.chainBackend, getBackend());
  contract.set(SANDBOX_CONTRACT_PARAMS.network, getNetwork());
  if (pendingResets.take('sandbox')) {
    contract.set(SANDBOX_CONTRACT_PARAMS.fullReset, '1');
  }
  const resolutionId = getResolutionId();
  if (resolutionId !== null) {
    contract.set(SANDBOX_CONTRACT_PARAMS.resolutionId, resolutionId);
  }
  const productQuery = removeContractParams(url.search);
  url.search = [productQuery, contract.toString()].filter(part => part !== '').join('&');
  return url;
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
