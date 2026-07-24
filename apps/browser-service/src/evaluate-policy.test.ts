import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

import {
  EvaluatePolicyError,
  parseAndValidateEvaluateExpression,
} from "./evaluate-policy.js";

function expectAccepted(source: string): void {
  expect(() => parseAndValidateEvaluateExpression(source)).not.toThrow();
}

function expectRejected(source: string): void {
  expect(() => parseAndValidateEvaluateExpression(source)).toThrow(
    expect.objectContaining({
      name: "EvaluatePolicyError",
      category: "model_protocol_error",
    }),
  );
}

describe("parseAndValidateEvaluateExpression", () => {
  test.each([
    "document.title",
    'document.querySelector("h1")?.textContent ?? ""',
    "document.querySelectorAll(args.selector).length",
    "location.origin + location.pathname",
    "args.prefix + document.title",
    "args.items[0].name",
    "({ title: document.title, path: location.pathname, value: args.value })",
    "[document.title, args.value, true, null]",
    '(document.body?.innerText ?? "").slice(0, 100)',
    "`title: ${document.title}`",
    "typeof args.value === \"string\" ? args.value.trim() : null",
  ])("accepts supported read-only expression %s", (source) => {
    expectAccepted(source);
  });

  test.each([
    "",
    "document.",
    "document.title; location.href",
    "const value = document.title",
    "return document.title",
  ])("rejects parse errors or non-expression programs %s", (source) => {
    expectRejected(source);
  });

  test.each([
    "document.title = args.value",
    "document.title += args.value",
    "args.value ||= document.title",
    "args.count++",
    "--args.count",
    "delete args.value",
  ])("rejects assignment, update, and delete %s", (source) => {
    expectRejected(source);
  });

  test.each([
    "new Date()",
    'import("https://example.test/module.js")',
    "() => document.title",
    "function () { return document.title; }",
    "class { value = document.title }",
    "String.raw`x`",
    "await document.title",
    "document.title as string",
    "document.title!",
    "document.title satisfies string",
    "/title/.test(document.title)",
    "(document.title, location.href)",
  ])("rejects executable syntax family %s", (source) => {
    expectRejected(source);
  });

  test.each([
    'fetch("https://example.test/")',
    'new XMLHttpRequest()',
    'new WebSocket("wss://example.test/")',
    'new EventSource("https://example.test/")',
    'new Worker("worker.js")',
    'new SharedWorker("worker.js")',
    "navigator.sendBeacon",
    "window.document.title",
    "globalThis.document.title",
  ])("rejects network, worker, or ambient global access %s", (source) => {
    expectRejected(source);
  });

  test.each([
    "localStorage.length",
    "sessionStorage.length",
    "indexedDB.databases()",
    "caches.keys()",
    "document.cookie",
    "document.defaultView",
  ])("rejects storage and expanded-global access %s", (source) => {
    expectRejected(source);
  });

  test.each([
    'document.write("<p>x</p>")',
    "document.body.click()",
    'document.body.setAttribute("data-x", "1")',
    "document.body.remove()",
    "location.assign(args.url)",
    "location.replace(args.url)",
    "location.reload()",
    "location.href = args.url",
  ])("rejects DOM and navigation mutation %s", (source) => {
    expectRejected(source);
  });

  test.each([
    "args.constructor",
    'args["__proto__"]',
    "document.body.ownerDocument",
    "document.querySelector(args.selector).attachShadow",
    "document.querySelector(args.selector).dispatchEvent",
    "args[args.key]",
  ])("rejects prototype escape and unapproved members %s", (source) => {
    expectRejected(source);
  });

  test("returns the compiler expression for an accepted source", () => {
    const expression = parseAndValidateEvaluateExpression("document.title");
    expect(expression.getText()).toBe("document.title");
  });

  test("uses the exact production TypeScript compiler", () => {
    expect(ts.version).toBe("5.9.3");
  });

  test("keeps the exact TypeScript compiler in production dependencies", () => {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(
      readFileSync(packageJsonPath, "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toMatchObject({
      typescript: "5.9.3",
    });
    expect(packageJson.devDependencies).not.toHaveProperty("typescript");
  });

  test("rejects non-string and oversized input before parsing", () => {
    expect(() =>
      parseAndValidateEvaluateExpression(1 as unknown as string),
    ).toThrow(EvaluatePolicyError);
    expectRejected("x".repeat(20_001));
  });
});
