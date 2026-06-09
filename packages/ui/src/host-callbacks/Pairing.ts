import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { emitSsoPairingPresented } from "./SsoDebug";

export interface TrUApiPairingRequest {
  deeplink: string;
  label: string;
  dotSuffix?: boolean;
  cancel: () => void;
}

export function createPresentPairing(
  label: string,
  options: { dotSuffix?: boolean } = {},
): HostCallbacks["presentPairing"] {
  return (deeplink) =>
    new Promise<void>((resolve) => {
      emitSsoPairingPresented({ label, deeplink });
      window.dispatchEvent(
        new CustomEvent<TrUApiPairingRequest>("dotli:truapi-pairing", {
          detail: {
            deeplink,
            label,
            dotSuffix: options.dotSuffix,
            cancel: resolve,
          },
        }),
      );
    });
}
