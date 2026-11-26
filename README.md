# LLM Subscription Limit Card

![LLM Subscription Limit Card icon](icon.svg)

[![Open in Home Assistant Marketplace](https://my.home-assistant.io/badges/marketplace_repository.svg)](https://my.home-assistant.io/redirect/marketplace_repository/?owner=y-decimal&repository=ha-llm-subscription-limit-card&category=plugin)

An experimental Home Assistant dashboard card for subscription usage, history
and estimated forecasts. It is designed for the companion
[LLM Subscription Limits integration](https://github.com/y-decimal/ha-llm-subscription-limit-integration).

## Installation

In Marketplace, add this repository by URL as a Dashboard custom repository and
install it. Reload your browser, edit a dashboard, select **Add card**, then
choose **LLM subscription limit**. Select an appropriate percentage sensor in
the visual editor and optionally set a title and subtitle.

For YAML-managed dashboard resources, follow the installation dialog to add
the resource manually. Install the companion integration separately and
configure an account before adding the card. Entity IDs may differ between
installations.

Requires Home Assistant 2026.11 or newer. The card expects a percentage state
and `resets_at`, plus `window_started_at` or `window_seconds` attributes.
It uses recorder history/statistics when available. Forecasts are linear
estimates, not provider predictions, and monthly start dates may be estimates.
The five-hour window does not show a forecast.

When recorded data starts after the beginning of the window, the card draws a
dotted green **Estimated history** line and a faint, hatched shaded area up to the first
recorded reading. The curve assumes a zero start and an average pace to that
first value, with small repeatable variations. It is illustrative, not a
reconstruction of actual usage; it does not fill internal gaps or write any
history or statistics. No estimate is drawn without a recorded point.
For hourly statistics, gaps shorter than one hour cannot be distinguished from
bucket alignment and are not estimated; raw history uses a five-minute cutoff.

This is a new card type (`custom:llm-subscription-limit-card`), distinct from
the older local `custom:usage-meter-card`, so existing dashboards remain
unchanged and both can be loaded together.

```yaml
type: custom:llm-subscription-limit-card
entity: sensor.example_usage
title: Monthly
subtitle: OpenCode Go
```

## Refresh badge

`custom:llm-subscription-refresh-badge` counts down to the next poll and
refreshes on click. It is deliberately thin: the integration owns both the
schedule and the action, so the badge only reads a timestamp and presses a
button. Both fields are required, and there is nothing to configure twice.

```yaml
type: custom:llm-subscription-refresh-badge
entity: sensor.llm_subscription_limits_next_refresh   # timestamp sensor
refresh_entity: button.llm_subscription_limits_refresh_now
```

What it shows:

- `Refreshing in m:ss` — counting down to the timestamp.
- `Refreshed` — shown for about two seconds after a click, with a green dot and
  a short pop, so the press has visible feedback.
- `Refreshing…` — while a click's poll is still outstanding.
- `Due now` — the timestamp has passed and the poll has not landed yet.
- `Waiting for the first poll` — the sensor has no timestamp yet.
- `Next refresh sensor not found` — wrong entity configured.

Place it in a view's `footer` to keep it visible while scrolling. With the
companion integration it needs no polling interval and no target list: changing
the integration's poll interval changes this countdown automatically.

## Icon

The icon is the `chart-donut` glyph from [Material Design Icons](https://pictogrammers.com/library/mdi/icon/chart-donut/)
(Pictogrammers), Apache-2.0 — see [LICENSES/MDI-Apache-2.0.txt](LICENSES/MDI-Apache-2.0.txt).
It matches the glyph the companion integration's sensors use.
