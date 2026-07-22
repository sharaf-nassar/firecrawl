import type { LookupAddress } from "node:dns";

import { describe, expect, test, vi } from "vitest";

import {
  NetworkPolicyError,
  isPublicAddress,
  parseConnectAuthority,
  resolvePublicTarget,
  type PublicLookup,
} from "./network-policy.js";

function lookupAnswers(...answers: string[][]): PublicLookup {
  let call = 0;
  return vi.fn(async () => {
    const current = answers[Math.min(call, answers.length - 1)] ?? [];
    call += 1;
    return current.map(
      (address): LookupAddress => ({
        address,
        family: address.includes(":") ? 6 : 4,
      }),
    );
  });
}

describe("public target resolution", () => {
  test.each([
    "file:///etc/passwd",
    "ftp://93.184.216.34/file",
    "http://user:secret@example.com/",
    "http://localhost/",
    "http://localhost./",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1%25eth0]/",
    "http://169.254.169.254/",
    "http://10.0.0.1/",
    "http://100.64.0.1/",
    "http://172.16.0.1/",
    "http://192.168.0.1/",
    "http://0.0.0.0/",
    "http://224.0.0.1/",
    "http://192.0.2.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://198.18.0.1/",
    "http://240.0.0.1/",
    "http://[fc00::1]/",
    "http://[2001:db8::1]/",
    "http://[ff02::1]/",
  ])("blocks non-public target %s", async (target) => {
    await expect(
      resolvePublicTarget(target, lookupAnswers(["93.184.216.34"])),
    ).rejects.toMatchObject({ category: "target_blocked" });
  });

  test("normalizes IDNs and strips one trailing dot before one DNS lookup", async () => {
    const lookup = lookupAnswers(["93.184.216.34", "2606:2800:220:1::1"]);
    const target = await resolvePublicTarget(
      "https://B\u00dcCHER.example.:8443/a",
      lookup,
    );

    expect(target.hostname).toBe("xn--bcher-kva.example");
    expect(target.port).toBe(8443);
    expect(target.addresses).toEqual(["93.184.216.34", "2606:2800:220:1::1"]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith("xn--bcher-kva.example");
  });

  test("rejects a hostname when any answer is non-public", async () => {
    await expect(
      resolvePublicTarget(
        "https://rebind.example/",
        lookupAnswers(["93.184.216.34", "127.0.0.1"]),
      ),
    ).rejects.toMatchObject({ category: "target_blocked" });
  });

  test("performs a new lookup for every request", async () => {
    const lookup = lookupAnswers(["93.184.216.34"], ["127.0.0.1"]);
    await expect(
      resolvePublicTarget("https://example.test/", lookup),
    ).resolves.toMatchObject({ addresses: ["93.184.216.34"] });
    await expect(
      resolvePublicTarget("https://example.test/", lookup),
    ).rejects.toMatchObject({ category: "target_blocked" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test("rejects empty, failed, and malformed DNS answers", async () => {
    await expect(
      resolvePublicTarget("https://empty.test/", lookupAnswers([])),
    ).rejects.toBeInstanceOf(NetworkPolicyError);
    await expect(
      resolvePublicTarget(
        "https://bad.test/",
        lookupAnswers(["not-an-address"]),
      ),
    ).rejects.toMatchObject({ category: "target_blocked" });
    await expect(
      resolvePublicTarget("https://fail.test/", async () => {
        throw new Error("resolver detail must not escape");
      }),
    ).rejects.toMatchObject({ category: "target_resolution_failed" });
    await expect(
      resolvePublicTarget("https://wrong-family.test/", async () => [
        { address: "93.184.216.34", family: 6 },
      ]),
    ).rejects.toMatchObject({ category: "target_blocked" });
  });
});

describe("address and CONNECT parsing", () => {
  test("accepts public unicast IPv4 and IPv6 only", () => {
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
    expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });

  test.each([
    ["unspecified IPv4", "0.0.0.0"],
    ["broadcast", "255.255.255.255"],
    ["multicast IPv4", "224.0.0.1"],
    ["AS112 IPv4", "192.175.48.1"],
    ["AMT IPv4", "192.52.193.1"],
    ["benchmark IPv4", "198.18.0.1"],
    ["documentation IPv4", "203.0.113.1"],
    ["unspecified IPv6", "::"],
    ["site-local IPv6", "fec0::1"],
    ["discard IPv6", "100::1"],
    ["translation IPv6", "64:ff9b::c000:201"],
    ["6to4", "2002:c000:0201::"],
    ["Teredo", "2001::1"],
    ["benchmark IPv6", "2001:2::1"],
    ["AMT IPv6", "2001:3::1"],
    ["AS112 IPv6", "2001:4:112::1"],
    ["deprecated ORCHID", "2001:10::1"],
    ["ORCHIDv2", "2001:20::1"],
    ["drone remote ID", "2001:30::1"],
    ["segment routing", "5f00::1"],
    ["reserved IPv6", "3fff::1"],
    ["mapped private", "::ffff:10.0.0.1"],
    ["mapped documentation", "::ffff:192.0.2.1"],
  ])("blocks %s address %s", (_label, address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    "93.184.216.34",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "::ffff:93.184.216.34",
  ])("accepts verified public unicast %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  test.each([
    "example.test",
    "example.test:0",
    "example.test:65536",
    "user@example.test:443",
    "example.test:443/path",
    "example.test:443?x",
    "example.test:443#x",
    "example.test:443 extra",
    "example.test:443\r\nX: y",
    "::1:443",
  ])("rejects malformed CONNECT authority %s", (authority) => {
    expect(() => parseConnectAuthority(authority)).toThrowError(
      NetworkPolicyError,
    );
  });

  test("parses explicit domain and bracketed IPv6 CONNECT authorities", () => {
    expect(parseConnectAuthority("Example.TEST.:443")).toEqual({
      hostname: "example.test",
      port: 443,
    });
    expect(parseConnectAuthority("[2606:2800:220:1::1]:8443")).toEqual({
      hostname: "2606:2800:220:1::1",
      port: 8443,
    });
  });
});
