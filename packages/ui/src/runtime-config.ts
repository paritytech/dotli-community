import { getActiveServicesConfig, withActiveTld } from "@dotli/config/network";
import type { ProductRuntimeConfig } from "@parity/truapi-host";

declare const __DOTLI_VERSION__: string | undefined;

export function labelToProductId(label: string): string {
  return label.startsWith("localhost:") ? label : withActiveTld(label);
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

// The window origin deliberately plays no part here: `productId` comes
// solely from the label (or the explicit override).
export function createTruapiRuntimeConfig(
  label: string,
  productId: string = labelToProductId(label),
): ProductRuntimeConfig {
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
