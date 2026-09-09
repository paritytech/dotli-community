import type {
  AuthPresenter,
  AuthState,
  LoginFailureKind,
} from "@parity/truapi-host";
import {
  toSessionUiState,
  writeUiStateCache,
  type TruapiSessionUiState,
} from "./SessionStore";

/**
 * UI-level auth state dispatched on `dotli:truapi-auth-state`. Mirrors the
 * core's `AuthState` with byte fields already converted for rendering, plus
 * the pairing presentation context the topbar modal needs.
 */
export type DotliAuthState =
  | { tag: "Disconnected" }
  | {
      tag: "Pairing";
      deeplink: string;
      label: string;
      dotSuffix?: boolean;
      hostGlobal?: boolean;
    }
  | { tag: "Authenticating" }
  | { tag: "Connected"; session: TruapiSessionUiState }
  | { tag: "LoginFailed"; kind: LoginFailureKind; reason: string };

/** Dispatch a `dotli:truapi-auth-state` event for the topbar to render. */
export function dispatchAuthState(state: DotliAuthState): void {
  window.dispatchEvent(
    new CustomEvent<DotliAuthState>("dotli:truapi-auth-state", {
      detail: state,
    }),
  );
}

/**
 * Build the `authStateChanged` host callback: converts the core's ordered
 * auth states into `dotli:truapi-auth-state` events and maintains the
 * boot-rehydration UI-state cache on connect/disconnect transitions.
 */
export function createAuthStateChanged(
  label: string,
  options: { dotSuffix?: boolean; hostGlobal?: boolean } = {},
): Required<AuthPresenter>["authStateChanged"] {
  return (state: AuthState) => {
    switch (state.tag) {
      case "Pairing": {
        dispatchAuthState({
          tag: "Pairing",
          deeplink: state.value.deeplink,
          label,
          dotSuffix: options.dotSuffix,
          hostGlobal: options.hostGlobal,
        });
        break;
      }
      case "Authenticating": {
        dispatchAuthState({ tag: "Authenticating" });
        break;
      }
      case "Connected": {
        const session = toSessionUiState(state.value);
        void writeUiStateCache(session);
        dispatchAuthState({ tag: "Connected", session });
        break;
      }
      case "Disconnected": {
        void writeUiStateCache({ connected: false });
        dispatchAuthState({ tag: "Disconnected" });
        break;
      }
      case "LoginFailed": {
        dispatchAuthState({
          tag: "LoginFailed",
          kind: state.value.kind,
          reason: state.value.reason,
        });
        break;
      }
    }
  };
}
