# LLM Subscription Limit Card

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

This is a new card type (`custom:llm-subscription-limit-card`), distinct from
the older local `custom:usage-meter-card`, so existing dashboards remain
unchanged and both can be loaded together.

```yaml
type: custom:llm-subscription-limit-card
entity: sensor.example_usage
title: Monthly
subtitle: OpenCode Go
```

The refresh badge from the original local card is not part of this package.
The visual editor and installation must be tested in a running Home Assistant.
