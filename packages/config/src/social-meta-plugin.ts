// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Injects description, OpenGraph and Twitter card tags so shared links unfurl.
// A plugin, not index.html, because crawlers need an absolute og:image URL.

import type { HtmlTagDescriptor, Plugin } from 'vite';

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
  const appUrl = process.env['VITE_APP_URL']?.trim();
  if (appUrl === undefined || appUrl === '') {
    return image;
  }
  return new URL(image, appUrl).href;
}

/**
 * The description, OpenGraph and Twitter card `<meta>` tags for `config`, as
 * attribute sets: what socialMetaTags() injects, for a page that writes its
 * own head (the host's Astro page).
 */
export function socialMetaAttributes(config: SocialMeta): Record<string, string>[] {
  const image = socialImageUrl(config.image);
  return [
    { name: 'description', content: config.description },
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: config.siteName },
    { property: 'og:title', content: config.title },
    { property: 'og:description', content: config.description },
    { property: 'og:image', content: image },
    { property: 'og:image:alt', content: config.imageAlt },
    { name: 'twitter:card', content: 'summary' },
    { name: 'twitter:title', content: config.title },
    { name: 'twitter:description', content: config.description },
    { name: 'twitter:image', content: image },
    { name: 'twitter:image:alt', content: config.imageAlt },
  ];
}

export function socialMetaTags(config: SocialMeta): Plugin {
  return {
    name: 'dotli-social-meta',
    transformIndexHtml(): HtmlTagDescriptor[] {
      return socialMetaAttributes(config).map(attrs => ({ tag: 'meta', attrs, injectTo: 'head' as const }));
    },
  };
}
