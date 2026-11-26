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
card._pointsSource = "statistics";
card._points = [[window.start, 0], [window.start + 3600000, 3]];
assert.equal(card._estimatedHistory(window, window.start + 6 * day).length, 0,
  "a statistics bucket exactly at the window start is recorded history");
card._points = [[window.start + 40 * 60000, 5]];
assert.equal(card._estimatedHistory(window, window.start + 6 * day).length, 0,
  "an hourly bucket less than one hour after start does not establish a gap");
card._points = [[window.start + 3600000, 5]];
assert.ok(card._estimatedHistory(window, window.start + 6 * day).length,
  "a full missing hourly bucket remains estimated");
card._pointsSource = "history";
card._points = [[window.start + 40 * 60000, 5]];
assert.ok(card._estimatedHistory(window, window.start + 6 * day).length,
  "hourly statistics tolerance must not suppress a raw-history gap");
card._points = [[window.start + 4 * day, 32], [window.start + 5 * day, 40]];
card.clientWidth = 500;
const svg = card._svg({ percent: 40, projected: null, now: window.start + 6 * day }, window);
assert.doesNotMatch(svg, /stroke-dasharray="5 5"/);
const projectedSvg = card._svg({ percent: 40, projected: 120, now: window.start + 6 * day }, window);
assert.match(projectedSvg, /stroke-dasharray="5 5"/);
assert.match(svg, /stroke-dasharray="2 4"/);
assert.match(svg, /fill-opacity="0.05"/);
assert.match(svg, /fill="url\(#estimated-usage-hatch\)" opacity="0.55"/);
assert.match(svg, /stroke="var\(--line-usage\)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/);

const Badge = registry.get("llm-subscription-refresh-badge");
assert.ok(Badge, "refresh badge element must be registered");
assert.equal(
  JSON.stringify(Array.from(Badge.getConfigForm().schema, (field) => field.name)),
  '["entity","refresh_entity"]'
);
assert.equal(context.window.customCards[1].type, "llm-subscription-refresh-badge");

const badge = Object.create(Badge.prototype);
badge.shadowRoot = { innerHTML: "" };
assert.throws(() => badge.setConfig({}), /entity/);
assert.throws(() => badge.setConfig({ entity: "sensor.next" }), /refresh_entity/);

const due = new Date(Date.now() + 90 * 1000).toISOString();
badge.setConfig({ entity: "sensor.next", refresh_entity: "button.refresh" });
badge._hass = { states: { "sensor.next": { state: due, attributes: {} } } };
assert.match(badge._status(), /^Refreshing in 1:[0-9]{2}$/);
badge._hass = { states: { "sensor.next": { state: "unavailable", attributes: {} } } };
assert.equal(badge._status(), "Waiting for the first poll");
badge._hass = { states: {} };
assert.equal(badge._status(), "Next refresh sensor not found");
badge._hass = { states: { "sensor.next": { state: new Date(Date.now() - 5000).toISOString(), attributes: {} } } };
assert.equal(badge._status(), "Due now");
badge._pending = true;
assert.equal(badge._status(), "Refreshing…");
badge._refreshedUntil = Date.now() + 1000;
assert.equal(badge._status(), "Refreshed", "confirmation wins over the countdown");
badge._refreshedUntil = 0;

// A changed timestamp ends the pending state without any timer.
badge._hass = { states: { "sensor.next": { state: due, attributes: {} } } };
badge._pending = true;
const set = Object.getOwnPropertyDescriptor(Badge.prototype, "hass").set;
set.call(badge, { states: { "sensor.next": { state: new Date(Date.now() + 60 * 1000).toISOString(), attributes: {} } } });
assert.equal(badge._pending, false);
assert.ok(badge._refreshedUntil > Date.now(), "a landed poll shows the confirmation");

console.log("Card registration and visual form smoke tests passed");
