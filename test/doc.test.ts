import test from "node:test";
import assert from "node:assert/strict";
import { Doc } from "../dist/manager/doc.js";

test("Doc reads keys in a section and keeps the last duplicate", () => {
  const doc = Doc.parse("[global]\nindex-url = https://a\nindex-url = https://b\n");
  assert.equal(doc.get("global", "index-url"), "https://b");
  assert.equal(doc.get("", "index-url"), undefined);
});

test("Doc rewrites in place and preserves CRLF and unrelated lines", () => {
  const src = "[global]\r\ntimeout = 5\r\nindex-url = https://old\r\n";
  const doc = Doc.parse(src);
  doc.set("global", "index-url", "https://new");
  assert.equal(doc.toString(), "[global]\r\ntimeout = 5\r\nindex-url = https://new\r\n");
});

test("Doc quotes values when asked and inserts missing sections", () => {
  const doc = Doc.parse("");
  doc.set("source.mirrorhub", "registry", "https://mirror.example.com/", { sep: " = ", quote: '"' });
  assert.equal(doc.toString(), '[source.mirrorhub]\nregistry = "https://mirror.example.com/"\n');
});

test("Doc deletes only the requested key and the section when empty", () => {
  const doc = Doc.parse("[source.crates-io]\nreplace-with = \"ustc\"\n[net]\ngit-fetch-with-cli = true\n");
  assert.equal(doc.delete("source.crates-io", "replace-with"), true);
  assert.equal(doc.delete("source.crates-io", "replace-with"), false);
  doc.deleteSection("source.crates-io");
  assert.equal(doc.toString(), "[net]\ngit-fetch-with-cli = true\n");
});

test("Doc parses yarnrc whitespace syntax and strips trailing comments", () => {
  const doc = Doc.parse('registry "https://registry.yarnpkg.com" # comment\nstrict-ssl false\n');
  assert.equal(doc.get("", "registry"), "https://registry.yarnpkg.com");
  assert.equal(doc.get("", "strict-ssl"), "false");
});

test("Doc ignores array-of-table headers as sections", () => {
  const doc = Doc.parse("[[package]]\nname = \"x\"\n");
  assert.equal(doc.hasSection("package"), false);
  assert.equal(doc.get("", "name"), "x");
});
