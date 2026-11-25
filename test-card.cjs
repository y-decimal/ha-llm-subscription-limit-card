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
console.log("Card registration and visual form smoke tests passed");
