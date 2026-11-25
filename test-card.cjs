const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const registry = new Map();
const context = {
  HTMLElement: class {},
  customElements: { define: (name, value) => registry.set(name, value) },
  window: {},
  console,
};
vm.runInNewContext(fs.readFileSync("ha-llm-subscription-limit-card.js", "utf8"), context);
const Card = registry.get("llm-subscription-limit-card");
assert.ok(Card);
assert.equal(registry.has("usage-meter-card"), false);
const form = Card.getConfigForm();
assert.deepEqual(Array.from(form.schema, (field) => field.name), ["entity", "title", "subtitle"]);
const hass = { states: { "sensor.go": { attributes: { resets_at: "2026-12-01T00:00:00Z" } } } };
assert.equal(Card.getStubConfig(hass, ["sensor.go"], []).entity, "sensor.go");
assert.equal(context.window.customCards[0].type, "llm-subscription-limit-card");
const card = Object.create(Card.prototype);
const day = 86400000;
const window = { start: 1000000, end: 1000000 + 10 * day };
card._points = [[window.start + 4 * day, 32], [window.start + 5 * day, 40]];
const original = JSON.stringify(card._points);
const estimate = card._estimatedHistory(window, window.start + 6 * day);
assert.equal(estimate[0][0], window.start);
assert.equal(estimate[0][1], 0);
assert.equal(estimate.at(-1)[0], card._points[0][0]);
assert.equal(estimate.at(-1)[1], 32);
assert.equal(JSON.stringify(estimate), JSON.stringify(card._estimatedHistory(window, window.start + 6 * day)));
assert.equal(JSON.stringify(card._points), original, "recorded points must remain untouched");
for (let i = 1; i < estimate.length; i++) {
  assert.ok(estimate[i][0] > estimate[i - 1][0]);
  assert.ok(estimate[i][1] >= estimate[i - 1][1] && estimate[i][1] <= 32);
}
assert.notEqual(estimate[1][1], 8, "intermediate points should have a small variation");
card._points = [];
assert.equal(card._estimatedHistory(window, window.start + 6 * day).length, 0);
card._points = [[window.start + 60 * 1000, 5]];
assert.equal(card._estimatedHistory(window, window.start + 6 * day).length, 0);
card._points = [[window.start + 4 * day, 32], [window.start + 5 * day, 40]];
card.clientWidth = 500;
const svg = card._svg({ percent: 40, projected: null, now: window.start + 6 * day }, window);
assert.match(svg, /stroke-dasharray="2 4"/);
assert.match(svg, /fill-opacity="0.05"/);
assert.match(svg, /fill="url\(#estimated-usage-hatch\)" opacity="0.55"/);
assert.match(svg, /stroke="var\(--line-usage\)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/);
console.log("Card registration and visual form smoke tests passed");
