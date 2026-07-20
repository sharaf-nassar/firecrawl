import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeJsonBytes,
  canonicalizeJsonFile,
  hashCanonicalSchemaBundle,
  parseLosslessJson,
} from "./schema-canonicalizer.mjs";

const bytes = value => Buffer.from(value, "utf8");
const canonical = value => canonicalizeJsonBytes(bytes(value));
let cases = 0;

function equal(actual, expected) {
  cases += 1;
  assert.deepEqual(actual, expected);
}

function differs(left, right) {
  cases += 1;
  assert.notDeepEqual(left, right);
}

function rejects(raw) {
  cases += 1;
  assert.throws(() => parseLosslessJson(raw), /invalid_json/);
}

equal(
  canonical('{"a":1,"2":2,"10":10}'),
  canonical('{"10":10,"2":2,"a":1}'),
);
equal(
  canonical('{"2":2,"10":10,"a":1}').toString("utf8"),
  '{"10":10,"2":2,"a":1}',
);
differs(canonical('[1,2,3]'), canonical('[3,2,1]'));
differs(canonical('{"value":true}'), canonical('{"value":false}'));

equal(
  canonical('{"number":9007199254740993}').toString("utf8"),
  '{"number":9007199254740993}',
);
differs(
  canonical('{"number":9007199254740993}'),
  canonical('{"number":9007199254740992}'),
);
equal(
  canonical('{"number":0.100000000000000005}').toString("utf8"),
  '{"number":0.100000000000000005}',
);
differs(
  canonical('{"number":0.100000000000000005}'),
  canonical('{"number":0.1}'),
);

rejects(bytes(String.raw`{"a":1,"\u0061":2}`));
for (const invalid of [
  "01",
  "1.",
  "+1",
  "--1",
  "1e",
  "NaN",
  '"line\nbreak"',
  String.raw`"\x20"`,
  String.raw`"\uZZZZ"`,
  '"unterminated',
  "true false",
  "[1",
  '{"a":',
  '{"a",1}',
  "[1,]",
]) {
  rejects(bytes(invalid));
}

rejects(bytes(String.raw`"\ud800"`));
rejects(bytes(String.raw`"\udc00"`));
equal(canonical('"é"'), canonical(String.raw`"\u00e9"`));
equal(canonical('"😀"'), canonical(String.raw`"\ud83d\ude00"`));

rejects(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
for (const invalidUtf8 of [
  [0xc0, 0xaf],
  [0xe2, 0x82],
  [0x80],
  [0xed, 0xa0, 0x80],
]) {
  rejects(
    Buffer.concat([
      bytes('{"value":"'),
      Buffer.from(invalidUtf8),
      bytes('"}'),
    ]),
  );
}

const replacementBytes = Buffer.concat([
  bytes('{"value":"'),
  Buffer.from([0xef, 0xbf, 0xbd]),
  bytes('"}'),
]);
equal(
  canonicalizeJsonBytes(new Uint8Array(replacementBytes)),
  replacementBytes,
);

const rfc8785Input = bytes(String.raw`{
  "\u20ac":"Euro Sign",
  "\r":"Carriage Return",
  "\ufb33":"Hebrew Letter Dalet With Dagesh",
  "1":"One",
  "\ud83d\ude00":"Emoji: Grinning Face",
  "\u0080":"Control",
  "\u00f6":"Latin Small Letter O With Diaeresis"
}`);
equal(
  canonicalizeJsonBytes(rfc8785Input).toString("utf8"),
  '{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
);

const bundleOne = [
  ["host/browser-runtime/protocol/codex-app-server-0.144.5/z.json", bytes('{"b":2,"a":1}')],
  ["host/browser-runtime/protocol/codex-app-server-0.144.5/2.json", bytes('[1,2]')],
  ["host/browser-runtime/protocol/codex-app-server-0.144.5/10.json", bytes('9007199254740993')],
];
const bundleTwo = [
  ["host\\browser-runtime\\protocol\\codex-app-server-0.144.5\\10.json", bytes('9007199254740993')],
  ["host/browser-runtime/protocol/codex-app-server-0.144.5/z.json", bytes('{"a":1,"b":2}')],
  ["host/browser-runtime/protocol/codex-app-server-0.144.5/2.json", bytes('[1,2]')],
];
equal(
  hashCanonicalSchemaBundle(bundleOne),
  hashCanonicalSchemaBundle(bundleTwo),
);
differs(
  hashCanonicalSchemaBundle(bundleOne),
  hashCanonicalSchemaBundle(
    bundleOne.map(([path, raw]) => [
      path,
      path.endsWith("2.json") ? bytes('[2,1]') : raw,
    ]),
  ),
);
differs(
  hashCanonicalSchemaBundle(bundleOne),
  hashCanonicalSchemaBundle(
    bundleOne.map(([path, raw]) => [
      path,
      path.endsWith("z.json") ? bytes('{"a":1,"b":3}') : raw,
    ]),
  ),
);

const framed = createHash("sha256");
for (const [path, raw] of bundleOne.toSorted(([left], [right]) => {
  const a = left.replaceAll("\\", "/");
  const b = right.replaceAll("\\", "/");
  return a < b ? -1 : a > b ? 1 : 0;
})) {
  framed.update(path.replaceAll("\\", "/"), "utf8");
  framed.update(Buffer.from([0]));
  framed.update(canonicalizeJsonBytes(raw));
  framed.update(Buffer.from([0]));
}
equal(hashCanonicalSchemaBundle(bundleOne), framed.digest("hex"));

cases += 1;
assert.throws(
  () =>
    hashCanonicalSchemaBundle([
      ["schema/a.json", bytes("{}")],
      ["schema\\a.json", bytes("{}")],
    ]),
  /duplicate_schema_path/,
);

const root = await mkdtemp(join(tmpdir(), "codex-schema-canonicalizer-test-"));
try {
  const file = join(root, "schema.json");
  await writeFile(file, '{"2":2,"10":10,"value":0.100000000000000005}');
  await canonicalizeJsonFile(file);
  equal(
    await readFile(file, "utf8"),
    '{"10":10,"2":2,"value":0.100000000000000005}',
  );
} finally {
  await rm(root, { force: true, recursive: true });
}

process.stdout.write(
  `codex_browser_schema_canonicalizer: PASS cases=${cases}\n`,
);
