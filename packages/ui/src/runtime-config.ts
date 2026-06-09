import { SITE_ID } from "@dotli/config/config";
import { getActiveServicesConfig } from "@dotli/config/network";
import type { WasmRuntimeConfig } from "@parity/truapi-host-wasm";

type RuntimeLocation = Pick<Location, "origin">;

declare const __DOTLI_VERSION__: string | undefined;

export function labelToProductId(label: string): string {
  return label.startsWith("localhost:") ? label : `${label}.dot`;
}

function getPlatformType(userAgent: string = navigator.userAgent): string {
  if (userAgent.includes("Win")) {
    return "Windows";
  }
  if (userAgent.includes("Mac")) {
    return "macOS";
  }
  if (userAgent.includes("Linux")) {
    return "Linux";
  }
  return "Unknown";
}

export function createTruapiRuntimeConfig(
  label: string,
  location: RuntimeLocation = window.location,
  siteId: string = SITE_ID,
  productId: string = labelToProductId(label),
): WasmRuntimeConfig {
  void location;
  return {
    productId,
    productLabel: label,
    siteId,
    hostName: "Polkadot Web",
    hostIcon: undefined,
    hostVersion:
      typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : undefined,
    platformType: getPlatformType(),
    platformVersion: undefined,
    peopleChainGenesisHash: getActiveServicesConfig().people.genesis,
    pairingDeeplinkScheme: "polkadotapp",
  };
}
