import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { domainToASCII } from "node:url";

import ipaddr from "ipaddr.js";

export type PublicLookup = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export type ResolvedPublicTarget = {
  url: URL;
  hostname: string;
  port: number;
  addresses: readonly string[];
};

export type ConnectAuthority = {
  hostname: string;
  port: number;
};

export class NetworkPolicyError extends Error {
  readonly category:
    | "target_blocked"
    | "target_invalid"
    | "target_resolution_failed";
  readonly hostname?: string;

  constructor(
    category: NetworkPolicyError["category"],
    message: string,
    hostname?: string,
  ) {
    super(message);
    this.name = "NetworkPolicyError";
    this.category = category;
    if (hostname !== undefined) this.hostname = hostname;
  }
}

export const systemPublicLookup: PublicLookup = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export function isPublicAddress(input: string): boolean {
  try {
    const address = ipaddr.process(input);
    return address.range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicTarget(
  input: string | URL,
  lookup: PublicLookup = systemPublicLookup,
): Promise<ResolvedPublicTarget> {
  if (typeof input === "string" && /\[[^\]]*%/u.test(input)) {
    throw new NetworkPolicyError("target_blocked", "target is not allowed");
  }
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new NetworkPolicyError("target_invalid", "invalid target URL");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new NetworkPolicyError("target_blocked", "target is not allowed");
  }

  const hostname = normalizeHostname(url.hostname);
  const port = parsePort(
    url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port,
  );
  url.hostname = hostname.includes(":") ? `[${hostname}]` : hostname;

  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new NetworkPolicyError(
      "target_blocked",
      "target is not allowed",
      hostname,
    );
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new NetworkPolicyError(
        "target_blocked",
        "target is not allowed",
        hostname,
      );
    }
    return { url, hostname, port, addresses: [canonicalAddress(hostname)] };
  }

  let answers: readonly LookupAddress[];
  try {
    answers = await lookup(hostname);
  } catch {
    throw new NetworkPolicyError(
      "target_resolution_failed",
      "target resolution failed",
      hostname,
    );
  }
  if (answers.length === 0) {
    throw new NetworkPolicyError(
      "target_resolution_failed",
      "target resolution failed",
      hostname,
    );
  }

  const addresses: string[] = [];
  for (const answer of answers) {
    let actualFamily: 4 | 6 | undefined;
    try {
      actualFamily = ipaddr.parse(answer.address).kind() === "ipv4" ? 4 : 6;
    } catch {
      actualFamily = undefined;
    }
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      answer.family !== actualFamily ||
      !isPublicAddress(answer.address)
    ) {
      throw new NetworkPolicyError(
        "target_blocked",
        "target is not allowed",
        hostname,
      );
    }
    const canonical = canonicalAddress(answer.address);
    if (!addresses.includes(canonical)) addresses.push(canonical);
  }
  return { url, hostname, port, addresses };
}

export function parseConnectAuthority(authority: string): ConnectAuthority {
  if (
    authority.length === 0 ||
    /[\u0000-\u0020\u007f]/u.test(authority) ||
    /[@/?#]/u.test(authority)
  ) {
    throw new NetworkPolicyError("target_invalid", "invalid CONNECT authority");
  }

  let hostname: string;
  let portText: string;
  if (authority.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(authority);
    if (match === null) {
      throw new NetworkPolicyError(
        "target_invalid",
        "invalid CONNECT authority",
      );
    }
    hostname = normalizeHostname(match[1] ?? "");
    portText = match[2] ?? "";
    if (!ipaddr.IPv6.isValid(hostname)) {
      throw new NetworkPolicyError(
        "target_invalid",
        "invalid CONNECT authority",
      );
    }
  } else {
    const match = /^([^:]+):(\d{1,5})$/u.exec(authority);
    if (match === null) {
      throw new NetworkPolicyError(
        "target_invalid",
        "invalid CONNECT authority",
      );
    }
    hostname = normalizeHostname(match[1] ?? "");
    portText = match[2] ?? "";
  }
  return { hostname, port: parsePort(portText) };
}

function normalizeHostname(input: string): string {
  const unwrapped =
    input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const withoutTrailingDot = unwrapped.endsWith(".")
    ? unwrapped.slice(0, -1)
    : unwrapped;
  if (
    withoutTrailingDot.length === 0 ||
    withoutTrailingDot.endsWith(".") ||
    withoutTrailingDot.includes("%")
  ) {
    throw new NetworkPolicyError("target_invalid", "invalid target hostname");
  }
  if (ipaddr.isValid(withoutTrailingDot)) {
    return canonicalAddress(withoutTrailingDot);
  }
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    ascii
      .split(".")
      .some(
        (label) =>
          label.length === 0 ||
          label.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new NetworkPolicyError("target_invalid", "invalid target hostname");
  }
  return ascii;
}

function parsePort(input: string): number {
  if (!/^\d{1,5}$/u.test(input)) {
    throw new NetworkPolicyError("target_invalid", "invalid target port");
  }
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new NetworkPolicyError("target_invalid", "invalid target port");
  }
  return port;
}

function canonicalAddress(input: string): string {
  return ipaddr.process(input).toString();
}
