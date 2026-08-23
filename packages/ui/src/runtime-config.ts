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

// `assetHub` drives the host's dotNS username resolution. Typed as an
// intersection so this compiles against @parity/truapi-host releases from
// before the field existed; once the dependency floor includes it, fold the
// field into the plain ProductRuntimeConfig literal.
type RuntimeConfigWithAssetHub = ProductRuntimeConfig & {
  assetHub?: { genesisHash: string | Uint8Array };
};

// The window origin deliberately plays no part here: `productId` comes
// solely from the label (or the explicit override).
export function createTruapiRuntimeConfig(
  label: string,
  productId: string = labelToProductId(label),
): ProductRuntimeConfig {
  const config: RuntimeConfigWithAssetHub = {
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
    assetHub: {
      genesisHash: getActiveServicesConfig().assethub.genesis,
    },
    pairing: {
      deeplinkScheme: "polkadotapp",
    },
  };
  return config;
}
