import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const ALLOWED_APEXES = Object.freeze(["openai.com", "chatgpt.com"]);
const MAX_DNS_ANSWERS = 16;
const MAX_CLIENT_HELLO_BYTES = 64 * 1024;

function policyError(message) {
  return Object.assign(new Error(message), { category: "egress_denied" });
}

export function normalizeHostname(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > 254 ||
    /[\0-\x20\x7f/@\\[\]]/u.test(value)
  ) {
    throw policyError("invalid hostname");
  }
  const withoutDot = value.endsWith(".") ? value.slice(0, -1) : value;
  if (withoutDot === "" || isIP(withoutDot) !== 0) {
    throw policyError("IP literals are not allowed");
  }
  const ascii = domainToASCII(withoutDot).toLowerCase();
  if (
    ascii === "" ||
    ascii.length > 253 ||
    ascii.split(".").some(
      label =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw policyError("invalid hostname");
  }
  return ascii;
}

export function hostnameIsAllowed(value) {
  const hostname = normalizeHostname(value);
  return ALLOWED_APEXES.some(
    apex => hostname === apex || hostname.endsWith(`.${apex}`),
  );
}

export function parseConnectAuthority(authority) {
  if (
    typeof authority !== "string" ||
    authority.length === 0 ||
    authority.length > 300 ||
    /[\0-\x20\x7f/?#@\\]/u.test(authority)
  ) {
    throw policyError("invalid CONNECT authority");
  }
  const separator = authority.lastIndexOf(":");
  if (separator <= 0 || authority.slice(separator + 1) !== "443") {
    throw policyError("only CONNECT port 443 is allowed");
  }
  const hostname = normalizeHostname(authority.slice(0, separator));
  if (!hostnameIsAllowed(hostname)) {
    throw policyError("hostname is not allowed");
  }
  return Object.freeze({ hostname, port: 443 });
}

function parseIpv4(value) {
  const parts = value.split(".");
  if (
    parts.length !== 4 ||
    parts.some(part => !/^(?:0|[1-9]\d{0,2})$/u.test(part))
  ) {
    return undefined;
  }
  const octets = parts.map(Number);
  if (octets.some(octet => octet > 255)) return undefined;
  return (
    ((octets[0] << 24) |
      (octets[1] << 16) |
      (octets[2] << 8) |
      octets[3]) >>>
    0
  );
}

function inIpv4Cidr(address, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function ipv4IsGlobal(value) {
  const address = parseIpv4(value);
  if (address === undefined) return false;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, bits]) =>
    inIpv4Cidr(address, parseIpv4(base), bits),
  );
}

function parseIpv6(value) {
  if (value.includes("%") || value.split("::").length > 2) return undefined;
  let normalized = value.toLowerCase();
  const ipv4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (ipv4Match !== null) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (ipv4 === undefined) return undefined;
    normalized = `${normalized.slice(0, -ipv4Match[1].length)}${(
      (ipv4 >>> 16) &
      0xffff
    ).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const [leftText, rightText = ""] = normalized.split("::");
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  if (
    [...left, ...right].some(
      part => !/^[0-9a-f]{1,4}$/u.test(part),
    )
  ) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if (
    (normalized.includes("::") && missing < 1) ||
    (!normalized.includes("::") && missing !== 0)
  ) {
    return undefined;
  }
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map(part => Number.parseInt(part, 16));
  if (groups.length !== 8) return undefined;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return bytes;
}

function ipv6IsGlobal(value) {
  const bytes = parseIpv6(value);
  if (bytes === undefined) return false;
  const ipv4Mapped =
    bytes.subarray(0, 10).every(byte => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (ipv4Mapped) {
    return ipv4IsGlobal(
      `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
    );
  }
  // Permit globally routed unicast only. This excludes loopback, unspecified,
  // ULA, link-local, multicast, IPv4-transition, and translation ranges.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  // Documentation and special-purpose allocations within 2000::/3.
  if (
    (bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      (bytes[2] & 0xfe) === 0) ||
    (bytes[0] === 0x20 && bytes[1] === 0x02) ||
    (bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x0d &&
      bytes[3] === 0xb8) ||
    (bytes[0] === 0x3f &&
      bytes[1] === 0xff &&
      (bytes[2] & 0xf0) === 0)
  ) {
    return false;
  }
  return true;
}

export function addressIsGlobal(value) {
  const family = isIP(value);
  if (family === 4) return ipv4IsGlobal(value);
  if (family === 6) return ipv6IsGlobal(value);
  return false;
}

export function addressesMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const family = isIP(left);
  if (family === 0 || isIP(right) !== family) return false;
  if (family === 4) return parseIpv4(left) === parseIpv4(right);
  const leftBytes = parseIpv6(left);
  const rightBytes = parseIpv6(right);
  return (
    leftBytes !== undefined &&
    rightBytes !== undefined &&
    leftBytes.equals(rightBytes)
  );
}

export function validateResolvedAddresses(answers) {
  if (
    !Array.isArray(answers) ||
    answers.length === 0 ||
    answers.length > MAX_DNS_ANSWERS
  ) {
    throw policyError("DNS answer set is invalid");
  }
  const unique = new Map();
  for (const answer of answers) {
    if (
      answer === null ||
      typeof answer !== "object" ||
      ![4, 6].includes(answer.family) ||
      isIP(answer.address) !== answer.family ||
      !addressIsGlobal(answer.address)
    ) {
      throw policyError("DNS resolved to a non-global address");
    }
    unique.set(`${answer.family}:${answer.address}`, {
      address: answer.address,
      family: answer.family,
    });
  }
  return Object.freeze([...unique.values()].map(Object.freeze));
}

function need(buffer, offset, bytes) {
  return offset + bytes <= buffer.length;
}

function parseServerNameExtension(extension) {
  if (!need(extension, 0, 2)) throw policyError("invalid TLS SNI");
  const listLength = extension.readUInt16BE(0);
  if (listLength !== extension.length - 2) {
    throw policyError("invalid TLS SNI");
  }
  let offset = 2;
  let hostname;
  while (offset < extension.length) {
    if (!need(extension, offset, 3)) throw policyError("invalid TLS SNI");
    const type = extension[offset];
    const length = extension.readUInt16BE(offset + 1);
    offset += 3;
    if (!need(extension, offset, length) || length === 0) {
      throw policyError("invalid TLS SNI");
    }
    if (type === 0) {
      if (hostname !== undefined) throw policyError("ambiguous TLS SNI");
      const encodedHostname = extension.subarray(offset, offset + length);
      if (encodedHostname.some(byte => byte > 0x7f)) {
        throw policyError("TLS SNI must be ASCII");
      }
      hostname = normalizeHostname(encodedHostname.toString("ascii"));
    }
    offset += length;
  }
  if (hostname === undefined) throw policyError("TLS SNI is required");
  return hostname;
}

function parseClientHelloBody(body) {
  let offset = 0;
  if (!need(body, offset, 34)) throw policyError("invalid TLS ClientHello");
  offset += 34;
  if (!need(body, offset, 1)) throw policyError("invalid TLS ClientHello");
  const sessionLength = body[offset];
  offset += 1;
  if (!need(body, offset, sessionLength + 2)) {
    throw policyError("invalid TLS ClientHello");
  }
  offset += sessionLength;
  const cipherLength = body.readUInt16BE(offset);
  offset += 2;
  if (
    cipherLength < 2 ||
    cipherLength % 2 !== 0 ||
    !need(body, offset, cipherLength + 1)
  ) {
    throw policyError("invalid TLS ClientHello");
  }
  offset += cipherLength;
  const compressionLength = body[offset];
  offset += 1;
  if (
    compressionLength < 1 ||
    !need(body, offset, compressionLength + 2)
  ) {
    throw policyError("invalid TLS ClientHello");
  }
  offset += compressionLength;
  const extensionsLength = body.readUInt16BE(offset);
  offset += 2;
  if (
    extensionsLength === 0 ||
    !need(body, offset, extensionsLength) ||
    offset + extensionsLength !== body.length
  ) {
    throw policyError("invalid TLS ClientHello");
  }
  const end = offset + extensionsLength;
  let hostname;
  while (offset < end) {
    if (!need(body, offset, 4)) throw policyError("invalid TLS extension");
    const type = body.readUInt16BE(offset);
    const length = body.readUInt16BE(offset + 2);
    offset += 4;
    if (!need(body, offset, length)) throw policyError("invalid TLS extension");
    if (type === 0) {
      if (hostname !== undefined) throw policyError("ambiguous TLS SNI");
      hostname = parseServerNameExtension(
        body.subarray(offset, offset + length),
      );
    }
    offset += length;
  }
  if (hostname === undefined) throw policyError("TLS SNI is required");
  return hostname;
}

export function parseClientHelloSni(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_CLIENT_HELLO_BYTES) {
    throw policyError("TLS ClientHello exceeds its bound");
  }
  let recordOffset = 0;
  const handshakeParts = [];
  let handshakeBytes = 0;
  while (recordOffset < buffer.length) {
    if (!need(buffer, recordOffset, 5)) return { status: "need_more" };
    if (buffer[recordOffset] !== 22) {
      throw policyError("TLS ClientHello is required");
    }
    const recordLength = buffer.readUInt16BE(recordOffset + 3);
    if (recordLength === 0 || recordLength > 18 * 1024) {
      throw policyError("invalid TLS record length");
    }
    if (!need(buffer, recordOffset + 5, recordLength)) {
      return { status: "need_more" };
    }
    const payload = buffer.subarray(
      recordOffset + 5,
      recordOffset + 5 + recordLength,
    );
    handshakeParts.push(payload);
    handshakeBytes += payload.length;
    if (handshakeBytes > MAX_CLIENT_HELLO_BYTES) {
      throw policyError("TLS ClientHello exceeds its bound");
    }
    const handshake = Buffer.concat(handshakeParts, handshakeBytes);
    if (handshake.length >= 4) {
      if (handshake[0] !== 1) throw policyError("TLS ClientHello is required");
      const bodyLength = handshake.readUIntBE(1, 3);
      if (bodyLength === 0 || bodyLength + 4 > MAX_CLIENT_HELLO_BYTES) {
        throw policyError("invalid TLS ClientHello length");
      }
      if (handshake.length >= bodyLength + 4) {
        return {
          status: "complete",
          hostname: parseClientHelloBody(
            handshake.subarray(4, bodyLength + 4),
          ),
        };
      }
    }
    recordOffset += 5 + recordLength;
  }
  return { status: "need_more" };
}

export const EGRESS_POLICY = Object.freeze({
  allowedApexes: ALLOWED_APEXES,
  maxClientHelloBytes: MAX_CLIENT_HELLO_BYTES,
});
