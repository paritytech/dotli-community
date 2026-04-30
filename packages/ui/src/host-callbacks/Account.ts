// Account adapters — temporary bridge between the TrUAPI callback surface
// and the host-papp session exposed by `@dotli/auth`. The endpoints that
// dotli historically supported through `container.handleAccount*` are
// preserved verbatim here; new / unused ones fall through to
// `createUnavailableCallbacks()`.

import type * as T from "@truapi/client";
import type {
  SubscribeNoArgs,
  WasmHostCallbacks,
} from "@truapi/host-shared";
import type { UserSession } from "@novasamatech/host-papp";
import {
  getAuthState,
  onAuthStateChange,
  type AuthState,
} from "@dotli/auth/auth";
import { deriveProductPublicKey } from "@dotli/auth/account";
import { showAliasPermissionModal } from "../alias-permission-modal";
import { createSubmitRateLimiter } from "./rate-limit";

function getSession(): UserSession | null {
  const state = getAuthState();
  return state.status === "authenticated" ? state.session : null;
}

function subscribeSession(
  callback: (session: UserSession | null) => void,
): () => void {
  callback(getSession());
  return onAuthStateChange((state: AuthState) => {
    callback(state.status === "authenticated" ? state.session : null);
  });
}

function createAccountGet(): WasmHostCallbacks["accountGet"] {
  return (request) => {
    const [dotNsIdentifier, derivationIndex] = request.value;
    const session = getSession();
    if (!session) {
      return Promise.reject(new Error("Not connected"));
    }
    const publicKey = deriveProductPublicKey(
      session.remoteAccount.accountId,
      dotNsIdentifier,
      derivationIndex,
    );
    return Promise.resolve({ tag: "V2", value: { publicKey } });
  };
}

function createAccountGetAlias(
  label: string,
): WasmHostCallbacks["accountGetAlias"] {
  const limiter = createSubmitRateLimiter();
  return async (request) => {
    if (!limiter.allow()) {
      throw new Error("Rate limited");
    }

    const session = getSession();
    if (!session) {
      throw new Error("Not connected");
    }

    const productAccountId = request.value;
    const [productIdentifier] = productAccountId;

    if (!productIdentifier.endsWith(".dot")) {
      throw new Error("Invalid domain");
    }

    const identifier = label + ".dot";
    const isOwnDomain = identifier === productIdentifier;

    if (!isOwnDomain) {
      await showAliasPermissionModal(identifier, productIdentifier);
    }

    const result = await session
      .getRingVrfAlias(productAccountId, identifier)
      .match(
        (alias) => alias,
        (error) => {
          throw new Error(error.message);
        },
      );

    return {
      tag: "V2",
      value: { context: result.context, alias: result.alias },
    };
  };
}

function createGetNonProductAccounts(): WasmHostCallbacks["getNonProductAccounts"] {
  return () => {
    const state = getAuthState();
    if (state.status === "authenticated") {
      const account: T.Account = {
        publicKey: state.session.remoteAccount.accountId,
        name: state.identity?.liteUsername,
      };
      return Promise.resolve({ tag: "V2", value: [account] });
    }
    return Promise.resolve({ tag: "V2", value: [] });
  };
}

function createAccountConnectionStatusSubscribe(): SubscribeNoArgs<T.HostAccountConnectionStatusItem> {
  return (sendItem) => {
    return subscribeSession((session) => {
      const status: T.AccountConnectionStatus = session
        ? { tag: "Connected", value: undefined }
        : { tag: "Disconnected", value: undefined };
      sendItem({ tag: "V2", value: status });
    });
  };
}

export function createAccountAdapters(label: string): Pick<
  WasmHostCallbacks,
  | "accountGet"
  | "accountGetAlias"
  | "getNonProductAccounts"
  | "accountConnectionStatusSubscribe"
> {
  return {
    accountGet: createAccountGet(),
    accountGetAlias: createAccountGetAlias(label),
    getNonProductAccounts: createGetNonProductAccounts(),
    accountConnectionStatusSubscribe: createAccountConnectionStatusSubscribe(),
  };
}
