import ts from "typescript";

const MAX_EVALUATE_EXPRESSION_CHARS = 20_000;

const ROOT_IDENTIFIERS = new Set(["args", "document", "location"]);

const FORBIDDEN_IDENTIFIERS = new Set([
  "AsyncFunction",
  "Atomics",
  "BroadcastChannel",
  "Deno",
  "EventSource",
  "Function",
  "GeneratorFunction",
  "SharedArrayBuffer",
  "SharedWorker",
  "WebAssembly",
  "WebSocket",
  "Worker",
  "XMLHttpRequest",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "caches",
  "constructor",
  "cookie",
  "documentElementFromPoint",
  "eval",
  "fetch",
  "globalThis",
  "importScripts",
  "indexedDB",
  "localStorage",
  "navigator",
  "open",
  "postMessage",
  "prototype",
  "sendBeacon",
  "serviceWorker",
  "sessionStorage",
  "window",
]);

const DOCUMENT_MEMBERS = new Set([
  "URL",
  "activeElement",
  "baseURI",
  "body",
  "characterSet",
  "contentType",
  "documentElement",
  "documentURI",
  "elementFromPoint",
  "elementsFromPoint",
  "forms",
  "getElementById",
  "getElementsByClassName",
  "getElementsByName",
  "getElementsByTagName",
  "hasFocus",
  "head",
  "hidden",
  "images",
  "links",
  "querySelector",
  "querySelectorAll",
  "readyState",
  "scrollingElement",
  "title",
  "visibilityState",
]);

const LOCATION_MEMBERS = new Set([
  "ancestorOrigins",
  "hash",
  "host",
  "hostname",
  "href",
  "origin",
  "pathname",
  "port",
  "protocol",
  "search",
  "toString",
]);

const DOM_READ_MEMBERS = new Set([
  "alt",
  "ariaLabel",
  "attributes",
  "checked",
  "childElementCount",
  "children",
  "classList",
  "className",
  "clientHeight",
  "clientLeft",
  "clientTop",
  "clientWidth",
  "closest",
  "contains",
  "dataset",
  "disabled",
  "firstElementChild",
  "form",
  "getAttribute",
  "getAttributeNames",
  "getBoundingClientRect",
  "getClientRects",
  "hasAttribute",
  "hasAttributes",
  "hasChildNodes",
  "height",
  "href",
  "id",
  "innerHTML",
  "innerText",
  "item",
  "labels",
  "lastElementChild",
  "length",
  "matches",
  "name",
  "namedItem",
  "nextElementSibling",
  "nodeName",
  "nodeType",
  "offsetHeight",
  "offsetLeft",
  "offsetParent",
  "offsetTop",
  "offsetWidth",
  "parentElement",
  "placeholder",
  "previousElementSibling",
  "querySelector",
  "querySelectorAll",
  "role",
  "scrollHeight",
  "scrollLeft",
  "scrollTop",
  "scrollWidth",
  "selected",
  "selectedIndex",
  "src",
  "style",
  "tagName",
  "textContent",
  "title",
  "toString",
  "type",
  "value",
  "width",
]);

const PURE_VALUE_MEMBERS = new Set([
  "at",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "concat",
  "endsWith",
  "entries",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "includes",
  "indexOf",
  "isFinite",
  "isInteger",
  "isNaN",
  "isSafeInteger",
  "join",
  "keys",
  "lastIndexOf",
  "length",
  "localeCompare",
  "normalize",
  "slice",
  "some",
  "split",
  "startsWith",
  "substring",
  "toExponential",
  "toFixed",
  "toLocaleLowerCase",
  "toLocaleString",
  "toLocaleUpperCase",
  "toLowerCase",
  "toPrecision",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
  "valueOf",
  "values",
]);

const CALLABLE_DOCUMENT_MEMBERS = new Set([
  "elementFromPoint",
  "elementsFromPoint",
  "getElementById",
  "getElementsByClassName",
  "getElementsByName",
  "getElementsByTagName",
  "hasFocus",
  "querySelector",
  "querySelectorAll",
]);

const CALLABLE_DOM_READ_MEMBERS = new Set([
  "closest",
  "contains",
  "getAttribute",
  "getAttributeNames",
  "getBoundingClientRect",
  "getClientRects",
  "hasAttribute",
  "hasAttributes",
  "hasChildNodes",
  "item",
  "matches",
  "namedItem",
  "querySelector",
  "querySelectorAll",
  "toString",
]);

const CALLABLE_PURE_VALUE_MEMBERS = new Set(
  [...PURE_VALUE_MEMBERS].filter((member) => member !== "length"),
);

const ALLOWED_BINARY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.SlashToken,
]);

const ALLOWED_PREFIX_OPERATORS = new Set<ts.PrefixUnaryOperator>([
  ts.SyntaxKind.ExclamationToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.TildeToken,
]);

const ALLOWED_SYNTAX_KINDS = new Set<ts.SyntaxKind>([
  ...ALLOWED_BINARY_OPERATORS,
  ...ALLOWED_PREFIX_OPERATORS,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.BinaryExpression,
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.PrefixUnaryExpression,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.QuestionDotToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.TemplateExpression,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateSpan,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.TypeOfExpression,
]);

type ExpressionRoot = "args" | "document" | "location" | "value";

export class EvaluatePolicyError extends TypeError {
  readonly category = "model_protocol_error" as const;

  constructor(message: string) {
    super(message);
    this.name = "EvaluatePolicyError";
  }
}

function reject(message: string): never {
  throw new EvaluatePolicyError(message);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

function expressionRoot(expression: ts.Expression): ExpressionRoot | null {
  const current = unwrapParentheses(expression);
  if (
    ts.isStringLiteral(current) ||
    ts.isNumericLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    ts.isArrayLiteralExpression(current) ||
    ts.isObjectLiteralExpression(current) ||
    ts.isBinaryExpression(current) ||
    ts.isPrefixUnaryExpression(current) ||
    ts.isTypeOfExpression(current) ||
    ts.isConditionalExpression(current) ||
    ts.isTemplateExpression(current)
  ) {
    return "value";
  }
  if (ts.isIdentifier(current)) {
    return ROOT_IDENTIFIERS.has(current.text)
      ? (current.text as ExpressionRoot)
      : null;
  }
  if (ts.isPropertyAccessExpression(current)) {
    return expressionRoot(current.expression);
  }
  if (ts.isElementAccessExpression(current)) {
    return expressionRoot(current.expression);
  }
  if (ts.isCallExpression(current)) {
    return expressionRoot(current.expression);
  }
  return null;
}

function isDirectRootAccess(
  expression: ts.Expression,
  root: ExpressionRoot,
): boolean {
  const current = unwrapParentheses(expression);
  return ts.isIdentifier(current) && current.text === root;
}

function staticElementMember(
  argument: ts.Expression | undefined,
): string | number {
  if (argument === undefined) reject("element access requires an index");
  const current = unwrapParentheses(argument);
  if (ts.isStringLiteral(current)) return current.text;
  if (ts.isNumericLiteral(current)) return Number(current.text);
  reject("element access requires a static string or numeric index");
}

function assertSafeMemberName(member: string): void {
  if (member.length === 0 || FORBIDDEN_IDENTIFIERS.has(member)) {
    reject("expression member is not allowed");
  }
}

function memberIsReadable(
  root: ExpressionRoot,
  base: ts.Expression,
  member: string,
): boolean {
  if (root === "args") return true;
  if (root !== "value" && isDirectRootAccess(base, root)) {
    if (root === "document") return DOCUMENT_MEMBERS.has(member);
    return LOCATION_MEMBERS.has(member);
  }
  if (root === "document") {
    return DOM_READ_MEMBERS.has(member) || PURE_VALUE_MEMBERS.has(member);
  }
  return PURE_VALUE_MEMBERS.has(member);
}

function memberIsCallable(
  root: ExpressionRoot,
  base: ts.Expression,
  member: string,
): boolean {
  if (root !== "value" && isDirectRootAccess(base, root)) {
    if (root === "document") return CALLABLE_DOCUMENT_MEMBERS.has(member);
    if (root === "location") return member === "toString";
    return false;
  }
  if (root === "document") {
    return (
      CALLABLE_DOM_READ_MEMBERS.has(member) ||
      CALLABLE_PURE_VALUE_MEMBERS.has(member)
    );
  }
  return CALLABLE_PURE_VALUE_MEMBERS.has(member);
}

function validatePropertyAccess(expression: ts.PropertyAccessExpression): void {
  validateExpression(expression.expression);
  const root = expressionRoot(expression.expression);
  if (root === null) reject("property access must remain rooted in trusted data");
  const member = expression.name.text;
  assertSafeMemberName(member);
  if (!memberIsReadable(root, expression.expression, member)) {
    reject("expression member is not allowlisted");
  }
}

function validateElementAccess(expression: ts.ElementAccessExpression): void {
  validateExpression(expression.expression);
  const root = expressionRoot(expression.expression);
  if (root === null) reject("element access must remain rooted in trusted data");
  const member = staticElementMember(expression.argumentExpression);
  if (typeof member === "string") {
    assertSafeMemberName(member);
    if (!memberIsReadable(root, expression.expression, member)) {
      reject("expression member is not allowlisted");
    }
  } else {
    if (
      !Number.isSafeInteger(member) ||
      member < 0 ||
      ((root === "document" || root === "location") &&
        isDirectRootAccess(expression.expression, root))
    ) {
      reject("element index must address an allowlisted data value");
    }
  }
}

function callableMember(
  expression: ts.LeftHandSideExpression,
): { root: ExpressionRoot; base: ts.Expression; member: string } {
  const current = unwrapParentheses(expression);
  if (ts.isPropertyAccessExpression(current)) {
    const root = expressionRoot(current.expression);
    if (root === null) reject("call must remain rooted in trusted data");
    return { root, base: current.expression, member: current.name.text };
  }
  if (ts.isElementAccessExpression(current)) {
    const root = expressionRoot(current.expression);
    if (root === null) reject("call must remain rooted in trusted data");
    const member = staticElementMember(current.argumentExpression);
    if (typeof member !== "string") {
      reject("call member must be a static string");
    }
    return { root, base: current.expression, member };
  }
  reject("bare function calls are not allowed");
}

function validateCall(expression: ts.CallExpression): void {
  if (
    expression.typeArguments !== undefined &&
    expression.typeArguments.length !== 0
  ) {
    reject("type arguments are not allowed");
  }
  const target = callableMember(expression.expression);
  assertSafeMemberName(target.member);
  if (!memberIsCallable(target.root, target.base, target.member)) {
    reject("expression call is not allowlisted");
  }
  validateExpression(expression.expression);
  for (const argument of expression.arguments) {
    if (ts.isSpreadElement(argument)) reject("spread arguments are not allowed");
    validateExpression(argument);
  }
}

function validateObjectLiteral(expression: ts.ObjectLiteralExpression): void {
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      reject("object literals require explicit data properties");
    }
    if (
      !ts.isIdentifier(property.name) &&
      !ts.isStringLiteral(property.name) &&
      !ts.isNumericLiteral(property.name)
    ) {
      reject("computed object property names are not allowed");
    }
    const name = property.name.text;
    assertSafeMemberName(name);
    validateExpression(property.initializer);
  }
}

function validateExpression(expression: ts.Expression): void {
  const current = unwrapParentheses(expression);

  if (
    ts.isStringLiteral(current) ||
    ts.isNumericLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword ||
    ts.isNoSubstitutionTemplateLiteral(current)
  ) {
    return;
  }

  if (ts.isIdentifier(current)) {
    if (!ROOT_IDENTIFIERS.has(current.text)) {
      reject("expression identifier is not allowlisted");
    }
    return;
  }

  if (ts.isPropertyAccessExpression(current)) {
    validatePropertyAccess(current);
    return;
  }
  if (ts.isElementAccessExpression(current)) {
    validateElementAccess(current);
    return;
  }
  if (ts.isCallExpression(current)) {
    validateCall(current);
    return;
  }
  if (ts.isBinaryExpression(current)) {
    if (!ALLOWED_BINARY_OPERATORS.has(current.operatorToken.kind)) {
      reject("binary operator is not allowed");
    }
    validateExpression(current.left);
    validateExpression(current.right);
    return;
  }
  if (ts.isPrefixUnaryExpression(current)) {
    if (!ALLOWED_PREFIX_OPERATORS.has(current.operator)) {
      reject("prefix operator is not allowed");
    }
    validateExpression(current.operand);
    return;
  }
  if (ts.isTypeOfExpression(current)) {
    validateExpression(current.expression);
    return;
  }
  if (ts.isConditionalExpression(current)) {
    validateExpression(current.condition);
    validateExpression(current.whenTrue);
    validateExpression(current.whenFalse);
    return;
  }
  if (ts.isArrayLiteralExpression(current)) {
    for (const element of current.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        reject("array holes and spread are not allowed");
      }
      validateExpression(element);
    }
    return;
  }
  if (ts.isObjectLiteralExpression(current)) {
    validateObjectLiteral(current);
    return;
  }
  if (ts.isTemplateExpression(current)) {
    for (const span of current.templateSpans) {
      validateExpression(span.expression);
    }
    return;
  }

  reject("expression syntax is not allowlisted");
}

function validateSyntaxKinds(expression: ts.Expression): void {
  function visit(node: ts.Node): void {
    if (!ALLOWED_SYNTAX_KINDS.has(node.kind)) {
      reject(`syntax kind ${ts.SyntaxKind[node.kind]} is not allowed`);
    }
    if (
      ts.isIdentifier(node) &&
      FORBIDDEN_IDENTIFIERS.has(node.text)
    ) {
      reject("forbidden identifier");
    }
    ts.forEachChild(node, visit);
  }
  visit(expression);
}

export function parseAndValidateEvaluateExpression(
  source: string,
): ts.Expression {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > MAX_EVALUATE_EXPRESSION_CHARS
  ) {
    reject("evaluate source length is invalid");
  }

  const sourceFile = ts.createSourceFile(
    "evaluate-expression.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (
    parseDiagnostics === undefined ||
    parseDiagnostics.length !== 0 ||
    sourceFile.statements.length !== 1
  ) {
    reject("evaluate source must be one parsed expression");
  }

  const statement = sourceFile.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) {
    reject("evaluate source must be one expression statement");
  }

  validateSyntaxKinds(statement.expression);
  validateExpression(statement.expression);
  return statement.expression;
}
