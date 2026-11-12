// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The name methods an engine serves, as reads on its resolver.

import { TIMEOUTS } from '@dotli/config';
import {
  getBudget,
  type ProtocolContext,
  type ProtocolHandler,
  protocolSchema,
  type RemoteFailure,
  toRemoteEnd,
} from '@dotli/protocol';
import type { DotnsResolver } from '@dotli/resolver';
import { toError } from '@dotli/shared';
import { err, ok, type AnyMethod, type CallError, type MethodTypes, type ResultPayload } from '@dotli/transport';

import { PROTOCOL_APP_ERRORS } from './errors.js';

export type EngineResolver = Pick<
  DotnsResolver,
  'resolveDotName' | 'resolveOwner' | 'resolveExecutableManifest' | 'resolveRootManifest'
>;

type Params = {
  /** The name reads. Unset, each read is refused at once instead of leaving the caller to hang. */
  resolver?: EngineResolver | undefined;
  /** Caps each read's sync budget, for a tester who needs a timeout to show quickly. */
  syncBudgetCapMs?: number | undefined;
};

type NameSink = Parameters<ProtocolHandler<typeof methods.resolve.dotName>>[2];

const methods = protocolSchema.sections;

/** The name methods over `resolver`. Never throws. */
export function createNameReads({ resolver, syncBudgetCapMs }: Params) {
  return {
    /**
     * Sends each phase, then the result, then ends cleanly, or ends with the read's failure. Throws when the mode
     * resolves no names or `label` is empty.
     */
    resolveDotName,
    /** Answers the name's owner, or the failure as a remote error, a mode that resolves no names included. */
    resolveOwner,
    /**
     * Answers the name's executable manifest, or the failure as a remote error, a mode that resolves no names
     * included.
     */
    resolveExecutableManifest,
    /** Answers the name's root manifest, or the failure as a remote error, a mode that resolves no names included. */
    resolveRootManifest,
  };

  function requireResolver(unsupported: string): EngineResolver {
    if (resolver === undefined) {
      throw new Error(unsupported);
    }
    return resolver;
  }

  /**
   * The resolver's sync budget for a read: the method's budget, counted from when the call arrives, less a grace for
   * the typed error to cross back while the call still waits.
   */
  function toSyncOptions(method: AnyMethod): { syncTimeoutMs?: number } {
    const budgetMs = getBudget(method);
    if (budgetMs === null) {
      return {};
    }
    const budget = Math.max(1, budgetMs - TIMEOUTS.RESPONSE_DELIVERY_GRACE);
    return { syncTimeoutMs: syncBudgetCapMs === undefined ? budget : Math.min(budget, syncBudgetCapMs) };
  }

  function resolveDotName(
    { label }: MethodTypes<typeof methods.resolve.dotName>['start'],
    _context: ProtocolContext,
    sink: NameSink,
  ): () => void {
    const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_DOT_NAME_UNSUPPORTED);
    assertNonEmpty(label, 'label');
    void reader
      .resolveDotName(label, {
        onPhase: phase => {
          sink.send({ tag: 'phase', value: phase });
        },
        ...toSyncOptions(methods.resolve.dotName),
      })
      .then(
        resolved => {
          sink.send({ tag: 'resolved', value: resolved });
          sink.interrupt(ok());
        },
        (error: unknown) => {
          sink.interrupt(err(toRemoteEnd(toError(error))));
        },
      );
    // A read cannot be called off, and the transport drops what it sends once the host has stopped listening.
    return () => undefined;
  }

  // Each request handler below takes the context and returns what the protocol's handler returns, so the type is no
  // narrower than the method it serves.
  function resolveOwner(
    { label }: MethodTypes<typeof methods.resolve.owner>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.resolve.owner>> {
    return answerRead(() => {
      const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_OWNER_UNSUPPORTED);
      assertNonEmpty(label, 'label');
      return reader.resolveOwner(label, toSyncOptions(methods.resolve.owner));
    });
  }

  function resolveExecutableManifest(
    { label, kind }: MethodTypes<typeof methods.resolve.executableManifest>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.resolve.executableManifest>> {
    return answerRead(() => {
      const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_EXECUTABLE_MANIFEST_UNSUPPORTED);
      assertNonEmpty(label, 'label');
      return reader.resolveExecutableManifest(label, kind, toSyncOptions(methods.resolve.executableManifest));
    });
  }

  function resolveRootManifest(
    { label }: MethodTypes<typeof methods.resolve.rootManifest>['request'],
    _context: ProtocolContext,
  ): ReturnType<ProtocolHandler<typeof methods.resolve.rootManifest>> {
    return answerRead(() => {
      const reader = requireResolver(PROTOCOL_APP_ERRORS.RESOLVE_ROOT_MANIFEST_UNSUPPORTED);
      assertNonEmpty(label, 'label');
      return reader.resolveRootManifest(label, toSyncOptions(methods.resolve.rootManifest));
    });
  }
}

/** Throws when a protocol field that must name something is empty. */
export function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`Invalid ${name}: expected non-empty string`);
  }
}

/** Answers a read with its value, or with its failure as a remote error ends a call. */
async function answerRead<T>(read: () => Promise<T>): Promise<ResultPayload<T, CallError<RemoteFailure>>> {
  try {
    return ok(await read());
  } catch (error) {
    return err(toRemoteEnd(toError(error)));
  }
}
