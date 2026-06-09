import { SITE_ID } from "@dotli/config/config";
import { getActiveServicesConfig } from "@dotli/config/network";
import type { WasmRuntimeConfig } from "@parity/truapi-host-wasm";

type RuntimeLocation = Pick<Location, "hostname" | "origin">;

export function labelToProductId(label: string): string {
  return label.startsWith("localhost:") ? label : `${label}.dot`;
}

export function pairingMetadataUrl(location: RuntimeLocation): string {
  if (
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname.endsWith(".localhost")
  ) {
    const subdomain = location.hostname.endsWith(".localhost")
      ? `${location.hostname.slice(0, -".localhost".length)}.`
      : "";
    return `https://${subdomain}dot.li/metadata.json`;
  }
  return `${location.origin}/metadata.json`;
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
    hostMetadataUrl: pairingMetadataUrl(location),
    peopleChainGenesisHash: getActiveServicesConfig().people.genesis,
    pairingDeeplinkScheme: "polkadotapp",
  };
}
