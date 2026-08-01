#!/usr/bin/env node

import { readFileSync } from "node:fs";

const INTERNAL_HOSTNAME = "searxng";
const INTERNAL_ENDPOINT = "http://searxng:8080";

class EndpointValidationError extends Error {}

function invalidEndpoint() {
  throw new EndpointValidationError("Invalid SearXNG endpoint");
}

export function normalizeSearxngEndpoint(input) {
  if (
    input.length === 0 ||
    input !== input.trim() ||
    /[\r\n]/u.test(input) ||
    !/^https?:\/\//iu.test(input) ||
    input.includes("?") ||
    input.includes("#")
  ) {
    invalidEndpoint();
  }

  const authority = input.slice(input.indexOf("://") + 3).split(/[/?#]/u, 1)[0];
  if (authority.includes("@")) {
    invalidEndpoint();
  }

  let endpoint;
  try {
    endpoint = new URL(input);
  } catch (error) {
    if (error instanceof TypeError) {
      invalidEndpoint();
    }
    throw error;
  }

  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hostname === "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    invalidEndpoint();
  }

  const hostname = endpoint.hostname.toLowerCase();
  if (hostname.replace(/\.+$/u, "") === INTERNAL_HOSTNAME) {
    if (
      hostname !== INTERNAL_HOSTNAME ||
      endpoint.protocol !== "http:" ||
      endpoint.port !== "8080"
    ) {
      invalidEndpoint();
    }
    return INTERNAL_ENDPOINT;
  }

  return endpoint.origin;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.stdout.write(normalizeSearxngEndpoint(readFileSync(0, "utf8")));
  } catch (error) {
    if (error instanceof EndpointValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
