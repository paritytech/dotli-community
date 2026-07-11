import { getActiveServicesConfig } from "@dotli/config/network";
import type { ProductRuntimeConfig } from "@parity/truapi-host";

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
  productId: string = labelToProductId(label),
): ProductRuntimeConfig {
  void location;
  return {
    productId,
    host: {
      name: "Polkadot Web",
      icon: undefined,
      version:
        typeof __DOTLI_VERSION__ === "string" ? __DOTLI_VERSION__ : undefined,
    },
    platform: {
      type: getPlatformType(),
      version: undefined,
    },
    people: {
      genesisHash: getActiveServicesConfig().people.genesis,
    },
    bulletin: {
      genesisHash: getActiveServicesConfig().bulletin.genesis,
    },
    pairing: {
      deeplinkScheme: "polkadotapp",
    },
  };
}
