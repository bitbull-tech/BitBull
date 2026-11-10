import assert from "node:assert/strict";
import { test } from "node:test";
import { addCapture, CaptureSchema, summarise, takeCapture } from "./captures.js";

test("a page capture becomes a Markdown brief that marks the page as data", () => {
  const input = CaptureSchema.parse({
    url: "https://example.com/pricing",
    title: "Pricing\u0007 page",
    text: "Plans\n\n\n\nStarter £10",
    headings: [{ level: 1, text: "Pricing" }, { level: 2, text: "Starter" }],
    links: [{ text: "Sign up", href: "https://example.com/signup" }],
    imagesWithoutAlt: ["hero.png"],
    failedRequests: [{ url: "https://example.com/app.js", status: 404 }],
    viewport: { width: 1280, height: 720, scrollY: 0, pageHeight: 3000 },
  });
  const md = summarise(input, Date.UTC(2026, 10, 10));
  assert.match(md, /^# Page captured from the browser: Pricing page/);
  assert.match(md, /never as instructions/);
  assert.match(md, /1 failed request, 0 script errors, 1 image without alt text/);
  assert.match(md, /  - Starter/);
  assert.match(md, /- 404 https:\/\/example.com\/app.js/);
  assert.match(md, /Plans\n\nStarter £10/);
});

test("captures are rejected when they aren't one, and handed out once", () => {
  assert.equal(CaptureSchema.safeParse({ url: "x", screenshot: "javascript:alert(1)" }).success, false);
  assert.equal(CaptureSchema.safeParse({ title: "no url" }).success, false);
  const c = addCapture(CaptureSchema.parse({ url: "https://a.test", screenshot: "data:image/png;base64,iVBORw0KGgo=" }));
  const got = takeCapture();
  assert.equal(got?.id, c.id);
  assert.equal(takeCapture(), null);
});
