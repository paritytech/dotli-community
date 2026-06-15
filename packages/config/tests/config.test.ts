// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
  TIMEOUTS,
  SW_ARCHIVE_CACHE_MAX,
  BASE_DOMAIN,
  isSandboxOrigin,
} from "@dotli/config/config";
import {
  NETWORK_NAME_TO_SERVICES_CONFIG,
  NetworkName,
} from "@dotli/config/network";

describe("config constants", () => {
  describe("contract addresses", () => {
    const v1 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V1].dotns;
    const v2 = NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V2].dotns;

    it("V1 DOTNS_REGISTRY is a valid hex address", () => {
      expect(v1.DOTNS_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V1 DOTNS_CONTENT_RESOLVER is a valid hex address", () => {
      expect(v1.DOTNS_CONTENT_RESOLVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V2 DOTNS_REGISTRY is a valid hex address", () => {
      expect(v2.DOTNS_REGISTRY).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V2 DOTNS_CONTENT_RESOLVER is a valid hex address", () => {
      expect(v2.DOTNS_CONTENT_RESOLVER).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("V1 and V2 contract addresses differ (separate deployments)", () => {
      expect(v1.DOTNS_REGISTRY).not.toBe(v2.DOTNS_REGISTRY);
      expect(v1.DOTNS_CONTENT_RESOLVER).not.toBe(v2.DOTNS_CONTENT_RESOLVER);
    });
  });

  describe("dotns storage slots", () => {
    it("every network exposes non-negative REGISTRY_RECORDS and CONTENTHASH slots", () => {
      for (const cfg of Object.values(NETWORK_NAME_TO_SERVICES_CONFIG)) {
        const slots = cfg.dotns.storageSlots;
        expect(Number.isInteger(slots.REGISTRY_RECORDS)).toBe(true);
        expect(slots.REGISTRY_RECORDS).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(slots.CONTENTHASH)).toBe(true);
        expect(slots.CONTENTHASH).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("IPFS gateways", () => {
    it("V1 first gateway is a valid HTTPS URL", () => {
      expect(
        NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V1].bulletin
          .ipfsGateways[0],
      ).toMatch(/^https:\/\//);
    });

    it("V2 first gateway is a valid HTTPS URL", () => {
      expect(
        NETWORK_NAME_TO_SERVICES_CONFIG[NetworkName.PASEO_NEXT_V2].bulletin
          .ipfsGateways[0],
      ).toMatch(/^https:\/\//);
    });
  });

  describe("TIMEOUTS", () => {
    it("all timeout values are positive numbers", () => {
      for (const [key, value] of Object.entries(TIMEOUTS)) {
        expect(value, `TIMEOUTS.${key}`).toBeGreaterThan(0);
      }
    });
  });

  describe("SW_ARCHIVE_CACHE_MAX", () => {
    it("is a positive number", () => {
      expect(SW_ARCHIVE_CACHE_MAX).toBeGreaterThan(0);
    });
  });

  // Gates postMessage traffic the host shell accepts from the sandbox iframe
  // (loading status, bitswap relay). Only `<label>.app.<root>` origins — over
  // https in production, or *.app.localhost in dev — may drive host services.
  describe("isSandboxOrigin", () => {
    it("accepts a label app-subdomain over https", () => {
      expect(isSandboxOrigin(`https://name.app.${BASE_DOMAIN}`)).toBe(true);
      expect(isSandboxOrigin(`https://my-app.app.${BASE_DOMAIN}`)).toBe(true);
    });

    it("rejects the bare host (non-app) subdomain", () => {
      // The product's own `<label>.<root>` shell origin must NOT count as a
      // sandbox — only the cross-origin `<label>.app.<root>` sandbox does.
      expect(isSandboxOrigin(`https://name.${BASE_DOMAIN}`)).toBe(false);
      expect(isSandboxOrigin(`https://app.${BASE_DOMAIN}`)).toBe(false);
      expect(isSandboxOrigin(`https://${BASE_DOMAIN}`)).toBe(false);
    });

    it("rejects a non-TLS production origin", () => {
      expect(isSandboxOrigin(`http://name.app.${BASE_DOMAIN}`)).toBe(false);
    });

    it("rejects unrelated and lookalike origins", () => {
      expect(isSandboxOrigin("https://evil.com")).toBe(false);
      // Leading-dot anchoring prevents `*.app.<root>.evil.com` and
      // `evilapp.<root>` style suffix tricks.
      expect(isSandboxOrigin(`https://name.app.${BASE_DOMAIN}.evil.com`)).toBe(
        false,
      );
      expect(isSandboxOrigin(`https://evil-app.${BASE_DOMAIN}`)).toBe(false);
    });

    it("accepts *.app.localhost (and bare app.localhost) in dev", () => {
      expect(isSandboxOrigin("http://name.app.localhost:5174")).toBe(true);
      expect(isSandboxOrigin("http://app.localhost")).toBe(true);
    });

    it("rejects non-app localhost origins", () => {
      expect(isSandboxOrigin("http://name.localhost:5174")).toBe(false);
      expect(isSandboxOrigin("http://localhost:5174")).toBe(false);
    });

    it("rejects malformed origin strings without throwing", () => {
      expect(isSandboxOrigin("garbage")).toBe(false);
      expect(isSandboxOrigin("")).toBe(false);
      expect(isSandboxOrigin(`name.app.${BASE_DOMAIN}`)).toBe(false);
    });
  });
});
