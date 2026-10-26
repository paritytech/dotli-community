// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { BASE_DOMAIN, isSandboxOrigin } from './config.js';
import { NETWORK_NAME_TO_SERVICES_CONFIG, NetworkName } from './network.js';

describe('config constants', () => {
  describe('contract addresses', () => {
    const paseo = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].dotns;

    it('As a resolver on Paseo, I read the dotNS registry at a valid hex address', () => {
      // When / Then
      expect(paseo.DOTNS_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('As a resolver on Paseo, I read the dotNS content resolver at a valid hex address', () => {
      // When / Then
      expect(paseo.DOTNS_CONTENT_RESOLVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  describe('dotns TLD', () => {
    // Mirrors `DOTNS_TLDS` in truapi's `truapi-platform`.
    const CORE_ACCEPTED_TLDS = ['dot', 'paseo', 'testnet'];

    it('As a dotli maintainer, I give every network a bare lowercase TLD and the truapi core accepts it', () => {
      // When / Then
      for (const [name, cfg] of Object.entries(NETWORK_NAME_TO_SERVICES_CONFIG)) {
        const tld = cfg.dotns.TLD;
        expect(tld, `${name} TLD must be non-empty`).not.toBe('');
        expect(tld, `${name} TLD must be lowercase`).toBe(tld.toLowerCase());
        expect(tld, `${name} TLD must not carry a leading dot`).not.toMatch(/^\./);
        expect(CORE_ACCEPTED_TLDS, `${name} TLD ${tld} is not in the core's DOTNS_TLDS`).toContain(tld);
      }
    });
  });

  describe('IPFS gateways', () => {
    it('As a visitor on Paseo, I fetch content from a first IPFS gateway on HTTPS', () => {
      // When / Then
      expect(NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO].bulletin.ipfsGateways[0]).toMatch(/^https:\/\//);
    });
  });

  // Gates the postMessage traffic the host accepts from the sandbox iframe.
  describe('isSandboxOrigin', () => {
    it('As the host, I accept a product label app-subdomain over HTTPS as a sandbox origin', () => {
      // When / Then
      expect(isSandboxOrigin(`https://name.app.${BASE_DOMAIN}`)).toBe(true);
      expect(isSandboxOrigin(`https://my-app.app.${BASE_DOMAIN}`)).toBe(true);
    });

    it('As the host, I refuse a bare host or non-app subdomain as a sandbox origin', () => {
      // When / Then
      expect(isSandboxOrigin(`https://name.${BASE_DOMAIN}`)).toBe(false);
      expect(isSandboxOrigin(`https://app.${BASE_DOMAIN}`)).toBe(false);
      expect(isSandboxOrigin(`https://${BASE_DOMAIN}`)).toBe(false);
    });

    it('As the host, I refuse a production sandbox origin without TLS', () => {
      // When / Then
      expect(isSandboxOrigin(`http://name.app.${BASE_DOMAIN}`)).toBe(false);
    });

    it('As the host, I refuse unrelated and lookalike origins as sandbox origins', () => {
      // When / Then
      expect(isSandboxOrigin('https://evil.com')).toBe(false);
      expect(isSandboxOrigin(`https://name.app.${BASE_DOMAIN}.evil.com`)).toBe(false);
      expect(isSandboxOrigin(`https://evil-app.${BASE_DOMAIN}`)).toBe(false);
    });

    it('As the host in development, I accept *.app.localhost and bare app.localhost as sandbox origins', () => {
      // When / Then
      expect(isSandboxOrigin('http://name.app.localhost:5174')).toBe(true);
      expect(isSandboxOrigin('http://app.localhost')).toBe(true);
    });

    it('As the host in development, I refuse localhost origins outside app as sandbox origins', () => {
      // When / Then
      expect(isSandboxOrigin('http://name.localhost:5174')).toBe(false);
      expect(isSandboxOrigin('http://localhost:5174')).toBe(false);
    });

    it('As a developer on local.host, I load a product from an app subdomain and it is accepted as a sandbox origin', () => {
      // Given an app subdomain of local.host and the bare app host
      const origins = ['https://name.app.local.host:4322', 'https://app.local.host'];

      // When each is checked as a sandbox origin
      const accepted = origins.map(origin => isSandboxOrigin(origin));

      // Then both are sandbox origins
      expect(accepted).toEqual([true, true]);
    });

    it('As a developer on local.host, I load a product from an origin outside app and it is refused as a sandbox origin', () => {
      // Given a product subdomain, the bare local.host and a lookalike app host
      const origins = ['https://browse.local.host:4321', 'https://local.host:4321', 'https://name.app.notlocal.host'];

      // When each is checked as a sandbox origin
      const accepted = origins.map(origin => isSandboxOrigin(origin));

      // Then none is a sandbox origin
      expect(accepted).toEqual([false, false, false]);
    });

    it('As the host, I refuse a malformed origin string as a sandbox origin without throwing', () => {
      // When / Then
      expect(isSandboxOrigin('garbage')).toBe(false);
      expect(isSandboxOrigin('')).toBe(false);
      expect(isSandboxOrigin(`name.app.${BASE_DOMAIN}`)).toBe(false);
    });
  });
});
