// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The registrable domain of a hostname by the Public Suffix List: its public suffix plus one label. The list arrives as
// text, so the rules are read here and matched in their ASCII form, as a URL gives a hostname.

/** The registrable domains the Public Suffix List draws. */
export interface PublicSuffixList {
  /**
   * The hostname's public suffix plus one label, lowercase.
   *
   * None for an address, a hostname with an empty label or a character outside printable ASCII, or one that is a
   * public suffix itself.
   */
  registrable(hostname: string): string | null;
}

// A WHATWG URL reads a hostname whose last label is a number as an IPv4 address.
const NUMBER_LABEL = /^(?:\d+|0x[\da-f]*)$/;

// The rules are held in ASCII form, so a hostname a URL did not convert, with a character outside printable ASCII,
// would match a shorter rule than its own.
const NOT_ASCII = /[^\x21-\x7e]/;

/** A rule's ASCII form, read whole, since a URL reads a lone numeric label as an address. */
function asciiRule(rule: string): string {
  let ascii: string;
  try {
    ascii = new URL(`http://${rule}`).hostname;
  } catch (cause) {
    throw new Error(`Public Suffix List rule ${rule} is not a hostname`, { cause });
  }
  if (ascii.split('.').length !== rule.split('.').length) {
    throw new Error(`Public Suffix List rule ${rule} reads as ${ascii}`);
  }
  return ascii;
}

/** Reads the list's text into its rules. Throws on a rule that is not a hostname of its own label count. */
export function parsePublicSuffixList(text: string): PublicSuffixList {
  const rules = new Set<string>();
  const wildcards = new Set<string>();
  const exceptions = new Set<string>();
  for (const line of text.split('\n')) {
    const rule = line.trim().split(/\s/, 1)[0] ?? '';
    if (rule === '' || rule.startsWith('//')) {
      continue;
    }
    if (rule.startsWith('!')) {
      exceptions.add(asciiRule(rule.slice(1)));
    } else if (rule.startsWith('*.')) {
      wildcards.add(asciiRule(rule.slice(2)));
    } else {
      rules.add(asciiRule(rule));
    }
  }

  /** How many labels of `labels`, from the right, make the public suffix. */
  function suffixLength(labels: string[]): number {
    for (let start = 0; start < labels.length; start++) {
      if (exceptions.has(labels.slice(start).join('.'))) {
        return labels.length - start - 1;
      }
    }
    for (let start = 0; start < labels.length; start++) {
      const suffix = labels.slice(start).join('.');
      if (rules.has(suffix) || (start + 1 < labels.length && wildcards.has(labels.slice(start + 1).join('.')))) {
        return labels.length - start;
      }
    }
    // The default rule `*`.
    return 1;
  }

  return {
    registrable(hostname) {
      const labels = hostname.toLowerCase().split('.');
      const last = labels.at(-1) ?? '';
      if (labels.includes('') || hostname.includes(':') || NOT_ASCII.test(hostname) || NUMBER_LABEL.test(last)) {
        return null;
      }
      const suffix = suffixLength(labels);
      return labels.length > suffix ? labels.slice(-suffix - 1).join('.') : null;
    },
  };
}
