import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// egress.ts reads DATA_DIR and the proxy setting at import time
const dir = mkdtempSync(path.join(tmpdir(), "bitbob-egress-"));
process.env.DATA_DIR = dir;
process.env.HTTPS_PROXY = "http://egress:3128";
process.env.NETWORK_REQUEST_TIMEOUT_S = "30";
const eg = await import("./egress.js");

test("normalizeHost accepts hosts and URLs, rejects IPs and junk", () => {
  assert.equal(eg.normalizeHost("https://Foo.Example.com:443/x?y"), "foo.example.com");
  assert.equal(eg.normalizeHost("*.example.org"), "example.org");
  assert.equal(eg.normalizeHost(".example.org"), "example.org");
  assert.equal(eg.normalizeHost("user@host.example.com"), "host.example.com");
  assert.equal(eg.normalizeHost("10.0.0.1"), null);
  assert.equal(eg.normalizeHost("localhost"), null);
  assert.equal(eg.normalizeHost("exa mple.com"), null);
  assert.equal(eg.normalizeHost("example.com\nOK"), null);
  assert.equal(eg.normalizeHost(""), null);
});

test("domainOf handles registry second levels", () => {
  assert.equal(eg.domainOf("a.b.example.com"), "example.com");
  assert.equal(eg.domainOf("discovery.nationalarchives.gov.uk"), "nationalarchives.gov.uk");
  assert.equal(eg.domainOf("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(eg.domainOf("example.com"), "example.com");
});

test("proxy refuses unknown hosts and remembers them as blocked", () => {
  eg._reset();
  assert.equal(eg.proxyCheck("tracker.example.net"), false);
  assert.equal(eg.proxyCheck("tracker.example.net"), false);
  const b = eg.networkState().blocked.find((x) => x.host === "tracker.example.net");
  assert.equal(b?.count, 2);
  assert.equal(eg.proxyCheck("not a host"), false);
});

test("an agent request waits for the user; host approval lets only that host through", async () => {
  eg._reset();
  const pending = eg.requestAccess({ domain: "https://api.cwgc.org/records", reason: "Look up a casualty record" });
  await new Promise((r) => setTimeout(r, 10));
  const req = eg.networkState().requests.find((r) => r.status === "pending");
  assert.ok(req);
  assert.equal(req.host, "api.cwgc.org");
  assert.equal(req.domain, "cwgc.org");
  assert.equal(eg.proxyCheck("api.cwgc.org"), false);
  eg.decide(req.id, "host");
  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(eg.proxyCheck("api.cwgc.org"), true);
  assert.equal(eg.proxyCheck("www.cwgc.org"), false);
  // in memory only: nothing the agent's shell could edit is written
  assert.equal(existsSync(path.join(dir, "egress-approved.json")), false);
});

test("domain approval covers subdomains; revoke removes it", async () => {
  eg._reset();
  const p = eg.requestAccess({ domain: "discovery.nationalarchives.gov.uk", reason: "Service records" });
  await new Promise((r) => setTimeout(r, 10));
  const req = eg.networkState().requests[0];
  eg.decide(req.id, "domain");
  assert.equal((await p).ok, true);
  assert.equal(eg.proxyCheck("www.nationalarchives.gov.uk"), true);
  assert.equal(eg.proxyCheck("nationalarchives.gov.uk"), true);
  assert.equal(eg.proxyCheck("gov.uk"), false);
  assert.equal(eg.revoke("nationalarchives.gov.uk", "domain"), true);
  assert.equal(eg.proxyCheck("www.nationalarchives.gov.uk"), false);
});

test("deny is final for a while, and duplicate requests share one card", async () => {
  eg._reset();
  const a = eg.requestAccess({ domain: "evil.example.com", reason: "x" });
  const b = eg.requestAccess({ domain: "evil.example.com", reason: "y" });
  await new Promise((r) => setTimeout(r, 10));
  const pend = eg.networkState().requests.filter((r) => r.status === "pending");
  assert.equal(pend.length, 1);
  eg.decide(pend[0].id, "deny");
  assert.equal((await a).ok, false);
  assert.equal((await b).ok, false);
  const again = await eg.requestAccess({ domain: "evil.example.com", reason: "please" });
  assert.equal(again.ok, false);
  assert.match(again.text, /denied/);
  assert.equal(eg.proxyCheck("evil.example.com"), false);
});

test("requests need a reason and a real host", async () => {
  eg._reset();
  assert.equal((await eg.requestAccess({ domain: "example.com", reason: "  " })).ok, false);
  assert.equal((await eg.requestAccess({ domain: "192.168.1.1", reason: "router" })).ok, false);
});

test("approving from Settings answers a matching pending request", async () => {
  eg._reset();
  const p = eg.requestAccess({ domain: "cdn.example.org", reason: "fonts" });
  await new Promise((r) => setTimeout(r, 10));
  eg.addApproval("example.org", "domain");
  assert.equal((await p).ok, true);
});
