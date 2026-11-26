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

The package also provides `custom:llm-subscription-refresh-badge`, a small pill
showing when the sensors poll next. Clicking it refreshes them: it presses a
button entity if one is configured, otherwise it sends
`homeassistant.update_entity` to the targets.

The countdown interval is **read, never duplicated**: the badge prefers a number
entity (the companion integration's poll interval), then a `scan_interval`
attribute on the anchor, then the spacing it actually observed between polls.
`refresh_seconds` is only a fallback for sensors that expose none of those.

```yaml
type: custom:llm-subscription-refresh-badge
entity: sensor.example_monthly_usage            # anchor: its last update sets the clock
interval_entity: number.llm_subscription_limits_poll_interval
refresh_entity: button.llm_subscription_limits_refresh_now
```

Without those entities, the older form still works:

```yaml
type: custom:llm-subscription-refresh-badge
entity: sensor.example_monthly_usage
refresh_seconds: 300
targets:
  - sensor.example_5h_usage
  - sensor.example_weekly_usage
  - sensor.example_monthly_usage
```

When the anchor is overdue it reads `Last poll 3 min ago` instead of claiming a
refresh is in progress; `Refreshing…` is reserved for a click or a refresh that
is genuinely outstanding. Place it in a view's `footer` to keep it visible while
scrolling. The anchor must be a sensor that reports `last_updated`/`last_reported`
on every poll; one whose state and attributes never change is not usable.

The visual editor and installation must be tested in a running Home Assistant.

## Icon

The icon is the `chart-donut` glyph from [Material Design Icons](https://pictogrammers.com/library/mdi/icon/chart-donut/)
(Pictogrammers), Apache-2.0 — see [LICENSES/MDI-Apache-2.0.txt](LICENSES/MDI-Apache-2.0.txt).
It matches the glyph the companion integration's sensors use.
