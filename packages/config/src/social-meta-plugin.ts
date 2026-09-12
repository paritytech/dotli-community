// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Injects description, OpenGraph and Twitter card tags so shared links unfurl.
// A plugin, not index.html, because crawlers need an absolute og:image URL.

import type { HtmlTagDescriptor, Plugin } from "vite";

export interface SocialMeta {
  /** Page title as shown in link previews. Should match `<title>`. */
  title: string;
  /** One or two sentences, ideally under 160 characters. */
  description: string;
  /** Site name shown above the title by some unfurlers. */
  siteName: string;
  /** Root-relative path to a square PNG of at least 200x200, e.g. `/icon-512.png`. */
  image: string;
  /** Alt text for the preview image. */
  imageAlt: string;
}

/** Resolves `image` against `VITE_APP_URL`, keeping it relative when unset. */
export function socialImageUrl(image: string): string {
  const appUrl = process.env.VITE_APP_URL?.trim();
  if (appUrl === undefined || appUrl === "") {
    return image;
  }
  return new URL(image, appUrl).href;
}

function meta(attrs: Record<string, string>): HtmlTagDescriptor {
  return { tag: "meta", attrs, injectTo: "head" as const };
}

export function socialMetaTags(config: SocialMeta): Plugin {
  return {
    name: "dotli-social-meta",
    transformIndexHtml() {
      const image = socialImageUrl(config.image);
      return [
        meta({ name: "description", content: config.description }),
        meta({ property: "og:type", content: "website" }),
        meta({ property: "og:site_name", content: config.siteName }),
        meta({ property: "og:title", content: config.title }),
        meta({ property: "og:description", content: config.description }),
        meta({ property: "og:image", content: image }),
        meta({ property: "og:image:alt", content: config.imageAlt }),
        meta({ name: "twitter:card", content: "summary" }),
        meta({ name: "twitter:title", content: config.title }),
        meta({ name: "twitter:description", content: config.description }),
        meta({ name: "twitter:image", content: image }),
        meta({ name: "twitter:image:alt", content: config.imageAlt }),
      ];
    },
  };
}
