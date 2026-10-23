import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TRANSCRIPT_CHARACTERS, parseTranscriptDraft, validTranscriptId,
} from "../src/lib/transcript-validation.ts";
import { isBrowserAuthorized, isMcpAuthorized } from "../src/lib/api-auth.ts";

const sample = {
  id: "dc7dbe5e-80dd-4e1e-8d43-cd60239ebed5",
  filename: "demo.m4a",
  transcript: "sample words",
  at: "2026-10-23T18:00:00.000Z",
};

test("validates transcript records", () => {
  assert.equal(validTranscriptId(sample.id), true);
  assert.equal(validTranscriptId("../secrets"), false);
  assert.equal(parseTranscriptDraft(sample)?.filename, "demo.m4a");
  assert.equal(parseTranscriptDraft({ ...sample, id: "../secrets" }), null);
  assert.equal(parseTranscriptDraft({ ...sample, filename: "bad\nname" }), null);
  assert.equal(parseTranscriptDraft({ ...sample, transcript: "x".repeat(MAX_TRANSCRIPT_CHARACTERS + 1) }), null);
});

test("browser storage authentication fails closed", () => {
  const prev = process.env.ACCESS_PASSWORD;
  try {
    delete process.env.ACCESS_PASSWORD;
    assert.equal(isBrowserAuthorized(new Headers({ "x-access-password": "anything" })), false);
    process.env.ACCESS_PASSWORD = "sample-password";
    assert.equal(isBrowserAuthorized(new Headers({ "x-access-password": "wrong" })), false);
    assert.equal(isBrowserAuthorized(new Headers({ "x-access-password": "sample-password" })), true);
  } finally {
    if (prev === undefined) delete process.env.ACCESS_PASSWORD;
    else process.env.ACCESS_PASSWORD = prev;
  }
});

test("Codex MCP requires a separate long bearer token", () => {
  const prev = process.env.MCP_AUTH_TOKEN;
  try {
    delete process.env.MCP_AUTH_TOKEN;
    assert.equal(isMcpAuthorized(new Headers({ authorization: "Bearer x" })), false);
    process.env.MCP_AUTH_TOKEN = "short";
    assert.equal(isMcpAuthorized(new Headers({ authorization: "Bearer short" })), false);
    process.env.MCP_AUTH_TOKEN = "a".repeat(40);
    assert.equal(isMcpAuthorized(new Headers({ authorization: "Bearer " + "b".repeat(40) })), false);
    assert.equal(isMcpAuthorized(new Headers({ authorization: "Bearer " + "a".repeat(40) })), true);
  } finally {
    if (prev === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = prev;
  }
});
