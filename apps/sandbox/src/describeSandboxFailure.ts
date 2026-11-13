// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// How each way the sandbox run can fail is named and worded for the host and the visitor.

import { CONTENT_ERRORS } from '@dotli/content';
import { describeGatewayUnreachable, getErrorMessage, getErrorName } from '@dotli/shared';
import type { LoadStep } from './loadProduct.js';

/** Each step names the failure wherever it is reported. */
export type SandboxStep =
  LoadStep | 'contract_top_level' | 'contract_origin' | 'contract_params' | 'contract_rerender' | 'retry_limit';

/** The backend a load read its content through, named in its failure. */
export type LoadDependency = 'smoldot-bitswap' | 'ipfs-gateway';

/** A way the run failed, with the facts its wording needs. */
export type SandboxFailure =
  /** The sandbox URL was opened as the page itself, at `host`. */
  | { kind: 'topLevel'; host: string }
  /** The page is not on an app subdomain. */
  | { kind: 'offOrigin' }
  /** The contract could not be read at `step`, for `reason`. */
  | { kind: 'unreadable'; step: 'contract_params' | 'contract_rerender'; reason: string }
  /** The visitor asked for more than `attempts` loads. */
  | { kind: 'retryLimit'; attempts: number }
  /** A load failed at `step`. */
  | { kind: 'load'; step: LoadStep; error: unknown; dependency: LoadDependency };

type DescribeParams = {
  /** The host's root domain, named where the visitor should open the product. */
  baseDomain: string;
  /** The IPFS gateway's host, named when it cannot be reached. */
  getGatewayHost: () => string | undefined;
};

/** The step a failure is reported at. */
export function getFailureStep(failure: SandboxFailure): SandboxStep {
  switch (failure.kind) {
    case 'topLevel':
      return 'contract_top_level';
    case 'offOrigin':
      return 'contract_origin';
    case 'unreadable':
    case 'load':
      return failure.step;
    case 'retryLimit':
      return 'retry_limit';
  }
}

/** The title and message a failure is shown with. Throws what `getGatewayHost` throws. */
export function describeSandboxFailure(
  failure: SandboxFailure,
  { baseDomain, getGatewayHost }: DescribeParams,
): { title: string; message: string } {
  switch (failure.kind) {
    case 'topLevel':
      return {
        title: 'Sandbox URL not supported',
        message: `Open this dApp through https://${baseDomain}. The sandbox origin (${failure.host}) is not a standalone entry point.`,
      };
    case 'offOrigin':
      return {
        title: 'Sandbox URL not supported',
        message: `This page must load as a dotns app subdomain (e.g. myapp.app.${baseDomain}) through dot.li.`,
      };
    case 'unreadable':
      return { title: 'Invalid sandbox URL', message: failure.reason };
    case 'retryLimit':
      return {
        title: 'Too many retry attempts',
        message: `Reached ${String(failure.attempts)} failed attempts. Reload the page to start over.`,
      };
    case 'load': {
      const { error, dependency } = failure;
      // An unreachable gateway names a host the visitor can check, so it gets visitor copy.
      const message =
        dependency === 'ipfs-gateway' && getErrorName(error) === CONTENT_ERRORS.GATEWAY_UNREACHABLE
          ? describeGatewayUnreachable(getGatewayHost())
          : `${getErrorMessage(error)} (via ${dependency})`;
      return { title: 'Failed to load content', message };
    }
  }
}
