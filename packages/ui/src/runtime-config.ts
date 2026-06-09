import { SITE_ID } from "@dotli/config/config";
import { getActiveServicesConfig } from "@dotli/config/network";
import type { WasmRuntimeConfig } from "@parity/truapi-host-wasm";

type RuntimeLocation = Pick<Location, "origin">;

const DOTLI_ICON_URL = "https://dot.li/dotli.png";

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

function getHostIcon(location: RuntimeLocation): string {
  try {
    const icon = new URL("/dotli.png", location.origin);
    return icon.protocol === "https:" ? icon.href : DOTLI_ICON_URL;
  } catch {
    return DOTLI_ICON_URL;
  }
}

export function createTruapiRuntimeConfig(
  label: string,
  location: RuntimeLocation = window.location,
  siteId: string = SITE_ID,
): WasmRuntimeConfig {
  return {
    productId: labelToProductId(label),
    productLabel: label,
    siteId,
    hostName: "Polkadot Web",
    hostIcon: getHostIcon(location),
    hostVersion: undefined,
    platformType: getPlatformType(),
    platformVersion: undefined,
    peopleChainGenesisHash: getActiveServicesConfig().people.genesis,
    pairingDeeplinkScheme: "polkadotapp",
  };
}
