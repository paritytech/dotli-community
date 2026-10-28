// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Link-unfurl meta tags. A plugin, not index.html, because crawlers need an absolute og:image URL.

import type { HtmlTagDescriptor, Plugin } from 'vite';

export type SocialMeta = {
  /** The page's title. */
  title: string;
  /** Ideally under 160 characters. */
  description: string;
  /** The site's name, as `og:site_name` gives it. */
  siteName: string;
  /** Root-relative path to a square PNG of at least 200x200. */
  image: string;
  /** The image's alternative text. */
  imageAlt: string;
};

/** Returns the plugin that injects the link-unfurl meta tags of `config` into the page head. */
export function socialMetaTags(config: SocialMeta): Plugin {
  return {
    name: 'dotli-social-meta',
    transformIndexHtml(): HtmlTagDescriptor[] {
      return listSocialMetaAttributes(config).map(attributes => ({
        tag: 'meta',
        attrs: attributes,
        injectTo: 'head' as const,
      }));
    },
  };
}

/**
 * Returns the link-unfurl meta tags of `config` as attribute sets, for a page that writes its own head. Throws when
 * `VITE_APP_URL` is set but is not a URL.
 */
export function listSocialMetaAttributes(config: SocialMeta): Record<string, string>[] {
  const image = getSocialImageUrl(config.image);
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

/**
 * Returns `image` resolved against `VITE_APP_URL`, or `image` as it is when that is unset. Throws when it is set but is
 * not a URL.
 */
export function getSocialImageUrl(image: string): string {
  const appUrl = process.env['VITE_APP_URL']?.trim();
  if (appUrl === undefined || appUrl === '') {
    return image;
  }
  return new URL(image, appUrl).href;
}
