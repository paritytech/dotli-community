import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { emitSsoPairingPresented } from "./SsoDebug";
import { emitDotliDebugEvent } from "@dotli/truapi-debug/dotli-debug-bus";

export interface TrUApiPairingRequest {
  deeplink: string;
  label: string;
  dotSuffix?: boolean;
  hostGlobal?: boolean;
  cancel: () => void;
}

export function createPresentPairing(
  label: string,
  options: { dotSuffix?: boolean; hostGlobal?: boolean } = {},
): HostCallbacks["presentPairing"] {
  return (deeplink) =>
    new Promise<void>((resolve) => {
      emitDotliDebugEvent({
        layer: "sso",
        event: "present_pairing_callback",
        flowId: "sso-present-pairing",
        timestamp: Date.now(),
        payload: { label },
      });
      emitSsoPairingPresented({ label, deeplink });
      window.dispatchEvent(
        new CustomEvent<TrUApiPairingRequest>("dotli:truapi-pairing", {
          detail: {
            deeplink,
            label,
            dotSuffix: options.dotSuffix,
            hostGlobal: options.hostGlobal,
            cancel: resolve,
          },
        }),
      );
    });
}
