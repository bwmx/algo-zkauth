import * as algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { decodeAddress, encodeAddress, getApplicationAddress, isValidAddress, sha512_256 } from "../src/address.ts";

describe("address codec (checked against algosdk)", () => {
  it("matches SHA-512/256 test vectors", () => {
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    expect(hex(sha512_256(new TextEncoder().encode("abc")))).toBe("53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23");
    expect(hex(sha512_256(new Uint8Array(0)))).toBe("c672b8d1ef56ed28ab87c3622c5114069bdd3ad7b8f9737498d0c01ecef0967a");
  });

  it("encodes, decodes and rejects like algosdk", () => {
    for (let i = 0; i < 25; i++) {
      const key = crypto.getRandomValues(new Uint8Array(32));
      const address = algosdk.encodeAddress(key);
      expect(encodeAddress(key)).toBe(address);
      expect(decodeAddress(address).publicKey).toEqual(key);
      expect(isValidAddress(address)).toBe(true);
      const typo = address.slice(0, 10) + (address[10] === "A" ? "B" : "A") + address.slice(11);
      expect(isValidAddress(typo)).toBe(algosdk.isValidAddress(typo));
    }
    expect(isValidAddress("")).toBe(false);
    expect(isValidAddress("a".repeat(58))).toBe(false);
  });

  it("derives application addresses like algosdk", () => {
    for (const id of [1n, 5000n, 746_000_000n, 0xffffffffffffffffn]) {
      expect(getApplicationAddress(id)).toBe(algosdk.getApplicationAddress(id).toString());
    }
  });
});
