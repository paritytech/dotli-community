import type { HostCallbacks } from "@parity/truapi-host-wasm";

export interface TrUApiPairingRequest {
  deeplink: string;
  label: string;
  cancel: () => void;
}

export function createPresentPairing(
  label: string,
): HostCallbacks["presentPairing"] {
  return (deeplink) =>
    new Promise<void>((resolve) => {
      window.dispatchEvent(
        new CustomEvent<TrUApiPairingRequest>("dotli:truapi-pairing", {
          detail: { deeplink, label, cancel: resolve },
        }),
      );
    });
}
