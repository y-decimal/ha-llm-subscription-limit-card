/*
 * usage-meter-card — a small, dependency-free card for the "Usage" view.
 *
 * Draws one OpenCode Go / ChatGPT Codex allowance the way the OpenCode console
 * does it: the x-axis is the meter's own window (window start → reset), the
 * solid line is real usage from long-term statistics, the dashed line is the
 * current average pace carried forward to the reset, and the footer states the
 * pace and where the allowance runs out.
 *
 * Configuration:
 *   type: custom:usage-meter-card
 *   entity: sensor.opencode_go_monthly_usage   # required
 *   title: Monthly                             # optional, shown before "21 % used"
 *   subtitle: Go usage                         # optional, e.g. "Go usage"
 *   refresh_seconds: 300                       # optional, matches the rest sensor's scan_interval
 *   targets: [sensor.a, sensor.b]              # optional, what a click refreshes
 *                                              (defaults to the usage sensors)
 *
 * Everything else comes from the entity's attributes, which the usage bridge
 * supplies: resets_at, window_started_at, projected_percent, rate_per_hour,
 * eta_to_limit_at. If a projection attribute is missing (the Codex sensors),
 * the card derives it from state + resets_at + window_seconds instead, so the
 * same card works for both providers.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Do not forecast from the first tenth of a window: a couple of hours into a
// month says nothing about the month, and the extrapolation reads as an alarm.
const EARLY_FRACTION = 0.10;

const CSS = `
  :host {
    display: block;
    --usage-amber: #e0a800;
    /* One shade lighter than the theme's green / the amber, keeping whatever
       hue the theme uses. The plain hex first is the fallback for browsers
       without color-mix(); the second declaration wins where supported. */
    --line-usage: #66bb6a;
    --line-usage: color-mix(in srgb, var(--success-color, #43a047) 75%, white);
    --line-amber: #f0b429;
    --line-amber: color-mix(in srgb, var(--usage-amber) 78%, white);
  }
  ha-card { padding: 12px 14px 10px; }
  .head { font-size: 20px; font-weight: 600; color: var(--primary-text-color); line-height: 1.2; }
  .head .num { font-weight: 600; }
  .sub { margin-top: 2px; font-size: 13px; color: var(--secondary-text-color); }
  .status { margin-top: 10px; font-size: 14px; font-weight: 500; }
  .status[hidden] { display: none; }
  .status.warn { color: var(--warning-color, #e0a800); }
  .status.ok { color: var(--secondary-text-color); }
  /* Fixed height on purpose: the SVG is replaced in place, and a collapsing
     box would shorten the page and pull the dashboard scroll to the top. */
  .chart { height: 230px; margin-top: 6px; }
  .chart svg { display: block; width: 100%; height: 230px; }
  .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 16px;
          margin-top: 6px; font-size: 13px; color: var(--secondary-text-color); }
  .legend { display: flex; align-items: center; gap: 14px; }
  .legend span.item { display: inline-flex; align-items: center; gap: 6px; }
  .legend span.item[hidden] { display: none; }
  .pill { display: inline-block; width: 4px; height: 13px; border-radius: 2px; }
  .pill.usage { background: var(--line-usage); }
  .pill.estimated { width: 13px; height: 0; border-top: 2px dotted var(--line-usage); border-radius: 0; }
  .pill.forecast { background: var(--line-amber); }
  .pill.limit { background: var(--secondary-text-color); opacity: .7; }
  .empty { padding: 18px 4px; color: var(--secondary-text-color); font-size: 14px; }
`;

class UsageMeterCard extends HTMLElement {
  static getStubConfig(hass, entities = [], entitiesFallback = []) {
    const suitable = [...entities, ...entitiesFallback].find((id) =>
      id.startsWith("sensor.") && hass?.states?.[id]?.attributes?.resets_at
    );
    return { entity: suitable || "sensor.select_usage_sensor" };
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
        { name: "title", selector: { text: {} } },
        { name: "subtitle", selector: { text: {} } },
      ],
      computeLabel: (field) => ({
        entity: "Usage sensor", title: "Title", subtitle: "Subtitle"
      })[field.name],
      computeHelper: (field) => field.name === "entity"
        ? "Choose a percentage sensor with reset and window attributes." : undefined,
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._points = null;
    this._fetchedAt = 0;
    this._fetchKey = "";
    this._fetching = false;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("usage-meter-card: 'entity' is required");
    }
    this.config = { title: "", subtitle: "", refresh_seconds: 300, ...config };
    this._points = null;
    this._fetchKey = "";
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeFetch();
    // HA hands us a new hass object on every state change in the instance.
    // Re-rendering on each one is wasteful, so render at most every 5 s and
    // only when something we display actually changed (state, checked_at or
    // the minute, which is what the countdowns tick on).
    const signature = this._signature();
    if (signature === this._signatureAt && Date.now() - this._renderedAt < 5000) return;
    this._signatureAt = signature;
    this._renderedAt = Date.now();
    this._render();
  }

  _signature() {
    const state = this._hass?.states?.[this.config.entity];
    return [
      state?.state,
      state?.attributes?.checked_at,
      Math.floor(Date.now() / 60000),
    ].join("|");
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    if (!this._observer && window.ResizeObserver) {
      this._observer = new ResizeObserver(() => this._render());
      this._observer.observe(this);
    }
  }

  disconnectedCallback() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  /* ---------- data helpers ---------- */

  _state() {
    return this._hass?.states?.[this.config.entity];
  }

  _attrs() {
    return this._state()?.attributes || {};
  }

  _window() {
    const a = this._attrs();
    const end = Date.parse(a.resets_at);
    let start = a.window_started_at ? Date.parse(a.window_started_at) : NaN;
    if (!isFinite(start) && a.window_seconds) {
      start = end - a.window_seconds * 1000;
    }
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    return { start, end };
  }

  _projection() {
    const st = this._state();
    const w = this._window();
    if (!st || !w) return null;
    const percent = Number(st.state);
    if (!isFinite(percent)) return null;

    const a = this._attrs();
    const now = Date.now();
    const elapsed = now - w.start;
    const total = w.end - w.start;
    const fraction = total > 0 ? elapsed / total : 0;

    let rate = Number(a.rate_per_hour);
    if (!isFinite(rate)) rate = elapsed > 0 ? (percent / (elapsed / 3600000)) : 0;

    // Already over the allowance: there is no pace left to forecast.
    if (percent >= 100) {
      return { percent, rate, projected: null, eta: null, now,
               early: false, reached: true, short: this._isShort(w) };
    }

    // A five-hour window is bursty: one long session can eat the whole
    // allowance in minutes, and extrapolating that average over the remaining
    // hours produces figures like "429 % by the reset". Short windows get the
    // real usage and the reset countdown, no forecast.
    if (this._isShort(w)) {
      return { percent, rate, projected: null, eta: null, now,
               early: false, reached: false, short: true };
    }

    let projected = Number(a.projected_percent);
    if (!isFinite(projected)) {
      // Extrapolating from a few hours of a multi-week window is noise, and it
      // reads as an alarm ("on pace to hit the limit") rather than information.
      if (fraction < EARLY_FRACTION) {
        return { percent, rate, projected: null, eta: null, now, early: true, short: false };
      }
      projected = percent / fraction;
    }

    let eta = a.eta_to_limit_at ? Date.parse(a.eta_to_limit_at) : NaN;
    if (!isFinite(eta) && projected > 100 && rate > 0) {
      eta = now + ((100 - percent) / rate) * 3600000;
    }
    return { percent, rate, projected, eta: isFinite(eta) ? eta : null,
             now, early: false, reached: false, short: false };
  }

  _maybeFetch() {
    const w = this._window();
    if (!w || !this._hass) return;
    const key = `${this.config.entity}|${w.start}|${w.end}`;
    const stale = Date.now() - this._fetchedAt > 5 * 60 * 1000;
    if (this._fetching || (key === this._fetchKey && !stale)) return;
    this._fetchKey = key;
    this._fetchedAt = Date.now();
    this._fetch(w);
  }

  async _fetch(window) {
    this._fetching = true;
    let points = [];
    let source = "statistics";
    if (!this._isShort(window)) {
      try {
        points = await this._statistics(window);
      } catch (error) {
        points = [];
      }
    }
    if (points.length < 2) {
      source = "history";
      try {
        points = await this._history(window);
      } catch (error) {
        points = [];
      }
    }
    this._points = points;
    this._pointsSource = source;
    this._fetching = false;
    this._render();
  }

  // The recorder answers in mixed shapes: ISO strings over REST, epoch seconds
  // in the history websocket command, epoch milliseconds in the statistics one.
  _toMs(value) {
    if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  async _statistics({ start, end }) {
    const result = await this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      statistic_ids: [this.config.entity],
      period: "hour",
      types: ["mean"],
    });
    const rows = (result && result[this.config.entity]) || [];
    return rows
      .filter((row) => row.mean !== null && row.mean !== undefined)
      .map((row) => [this._toMs(row.start), Number(row.mean)])
      // Buckets are aligned to the hour, so the first one usually starts before
      // the window does; keeping it would draw usage that predates the window.
      .filter(([t]) => Number.isFinite(t) && t >= start && t <= end);
  }

  async _history({ start, end }) {
    const result = await this._hass.callWS({
      type: "history/history_during_period",
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      entity_ids: [this.config.entity],
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    });
    const rows = (result && result[this.config.entity]) || [];
    return rows
      .map((row) => [
        this._toMs(row.lu ?? row.lc ?? row.last_changed ?? row.last_updated),
        Number(row.s ?? row.state),
      ])
      // Strictly inside: the history command prepends the state carried into
      // the window (the value from just before a reset) stamped at the start,
      // which would draw a vertical drop right at the left edge.
      .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && t > start && t <= end);
  }

  /* ---------- rendering ---------- */

  _fmtDate(ts) {
    const d = new Date(ts);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }

  _fmtTick(ts, shortWindow) {
    const d = new Date(ts);
    if (shortWindow) {
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`.toUpperCase();
  }

  // A date is useless on a five-hour window; anything inside a day counts down.
  _isShort(window) {
    return (window.end - window.start) <= 24 * 3600 * 1000;
  }

  _fmtRemaining(window, now) {
    const minutes = Math.round((window.end - now) / 60000);
    if (minutes <= 0) return "now";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours > 0 ? `${hours} h ${rest} m` : `${rest} m`;
  }

  // Reset format by proximity: more than a day out shows the date, under a day
  // shows the clock time, under an hour counts down in minutes.
  _resetPhrase(window, now) {
    const left = window.end - now;
    if (left <= 0) return { verb: "Resetting", detail: "now" };
    if (left >= 24 * 3600 * 1000) {
      return { verb: "Renews", detail: this._fmtDate(window.end) };
    }
    if (left >= 3600 * 1000) {
      return { verb: "Resets", detail: this._fmtClock(window.end) };
    }
    return { verb: "Resets", detail: `in ${this._fmtRemaining(window, now)}` };
  }

  _resetText(window, now) {
    const phrase = this._resetPhrase(window, now);
    return `${phrase.verb} ${phrase.detail}`;
  }

  _fmtClock(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  _fmtFull(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  _render() {
    if (!this.config) return;
    const st = this._state();
    if (!this._hass || !st) {
      // Transient states only; the skeleton is rebuilt once real data exists.
      this._refs = null;
      this._chartSig = "";
      this.shadowRoot.innerHTML = `<style>${CSS}</style><ha-card><div class="empty">${
        this._hass ? `${this.config.entity} not found` : "Loading…"}</div></ha-card>`;
      return;
    }

    const info = this._projection();
    const window = this._window();
    const percent = Number(st.state);
    const title = this.config.title || st.attributes.friendly_name || this.config.entity;
    const subtitleParts = [];
    if (this.config.subtitle) subtitleParts.push(this.config.subtitle);
    if (window) subtitleParts.push(this._resetText(window, Date.now()));

    let status = "";
    let statusClass = "ok";
    if (info && info.early) {
      status = "Window just started — no forecast yet";
    } else if (info && info.reached) {
      const phrase = this._resetPhrase(window, Date.now());
      status = `Limit reached — ${phrase.verb.toLowerCase()} ${phrase.detail}`;
      statusClass = "warn";
    } else if (info && info.projected !== null) {
      if (info.projected > 100 && info.eta) {
        status = `On pace to hit the limit ${this._fmtDate(info.eta)}`;
        statusClass = "warn";
      } else {
        status = `On pace to finish at ${Math.round(info.projected)} %`;
      }
    }

    const ratePerDay = info && isFinite(info.rate) ? info.rate * 24 : null;
    const unit = st.attributes.unit_of_measurement || "%";

    const refs = this._ensureDom();
    refs.title.textContent = title;
    refs.num.textContent = `${percent}${unit}`;
    refs.sub.textContent = subtitleParts.join(" · ");
    refs.status.textContent = status;
    refs.status.className = status ? `status ${statusClass}` : "status";
    refs.status.hidden = !status;
    refs.rate.textContent =
      ratePerDay !== null && isFinite(ratePerDay) && !(info && (info.early || info.reached || info.short))
        ? `Averaging ${Math.round(ratePerDay * 10) / 10} % a day`
        : "";
    refs.rate.hidden = !refs.rate.textContent;
    // No forecast series means no legend entry for it either.
    refs.legendForecast.hidden = !(info && info.projected !== null);
    refs.legendEstimated.hidden = !(window && info && this._estimatedHistory(window, info.now).length);

    // Rebuild only the drawing, and only when something about it changed: the
    // chart box has a fixed height, so swapping its contents cannot make the
    // page shorter and yank the scroll position.
    const last = (this._points && this._points.length) ? this._points[this._points.length - 1] : null;
    const signature = [
      this._points ? this._points.length : -1,
      this._pointsSource ?? "",
      this._points?.[0]?.[0] ?? "",
      this._points?.[0]?.[1] ?? "",
      last ? last[0] : "",
      last ? last[1] : "",
      window ? window.start : "",
      window ? window.end : "",
      info ? info.projected : "",
      percent,
      Math.round(this.clientWidth / 10),
    ].join("|");
    if (signature !== this._chartSig) {
      this._chartSig = signature;
      refs.chart.innerHTML = this._svg(info, window);
    }
  }

  _ensureDom() {
    if (this._refs) return this._refs;
    this.shadowRoot.innerHTML = `
      <style>${CSS}</style>
      <ha-card>
        <div class="head"><span class="title"></span> <span class="num"></span> used</div>
        <div class="sub"></div>
        <div class="status" hidden></div>
        <div class="chart"></div>
        <div class="foot">
          <span class="rate"></span>
          <span class="legend">
            <span class="item"><span class="pill usage"></span>Usage</span>
            <span class="item estimated" hidden><span class="pill estimated"></span>Estimated history</span>
            <span class="item forecast"><span class="pill forecast"></span>Forecast</span>
            <span class="item"><span class="pill limit"></span>Limit</span>
          </span>
        </div>
      </ha-card>`;
    const pick = (selector) => this.shadowRoot.querySelector(selector);
    this._refs = {
      title: pick(".head .title"),
      num: pick(".head .num"),
      sub: pick(".sub"),
      status: pick(".status"),
      chart: pick(".chart"),
      rate: pick(".rate"),
      legendForecast: pick(".legend .item.forecast"),
      legendEstimated: pick(".legend .item.estimated"),
    };
    return this._refs;
  }

  /* One point per local day, keeping the last value of that day. The console
     draws its usage line daily, and hourly buckets make a long window look
     jittery; collapsing keeps today's latest value as the final point. */
  _dailyPoints(points) {
    if (points.length < 3) return points;
    const perDay = new Map();
    for (const point of points) {
      const day = new Date(point[0]);
      perDay.set(`${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`, point);
    }
    const daily = [...perDay.values()];
    // A window whose sensor only started recording today collapses to a single
    // point, which draws nothing. Fall back to the hourly detail in that case.
    if (daily.length < 2) return points;
    // Keep the very first sample as well: otherwise the line starts at the last
    // value of the first day, leaving the start of a young window empty.
    if (points[0][0] < daily[0][0]) daily.unshift(points[0]);
    return daily;
  }

  /* Visual-only estimate between the window start and its first recorded
     point. Anchoring to that point gives a continuous join; it is not a claim
     that the user's real usage followed this curve. Never save these values. */
  _estimatedHistory(window, now) {
    const first = (this._points || [])
      .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v)
        && t >= window.start && t <= Math.min(now, window.end) && v >= 0 && v <= 100)
      .sort((a, b) => a[0] - b[0])[0];
    if (!first) return [];
    const gap = first[0] - window.start;
    // Hourly buckets cannot prove a gap smaller than their own resolution.
    // Raw history remains subject to the existing five-minute threshold.
    const threshold = this._pointsSource === "statistics" ? 60 * 60 * 1000 : 5 * 60 * 1000;
    if (gap < threshold) return [];
    const count = Math.max(4, Math.min(32, Math.ceil(gap / 86400000)));
    const points = [];
    for (let i = 0; i <= count; i += 1) {
      const f = i / count;
      // A fixed, bounded wobble: zero at either end and small enough to
      // preserve a nondecreasing trajectory. It never flickers on refresh.
      const variation = 0.04 * Math.sin(2 * Math.PI * f);
      points.push([window.start + gap * f, first[1] * (f + variation)]);
    }
    points[0] = [window.start, 0];
    points[points.length - 1] = [...first];
    return points;
  }

  /* Monotone cubic interpolation (Fritsch–Carlson) through the samples, in
     pixel space. Plain straight segments gave visible corners at every poll;
     this rounds them while staying monotone between points, so a quota step
     can never be drawn dipping below 0 % or above the last value. */
  _smoothPath(pixelPoints) {
    const points = pixelPoints.slice().sort((a, b) => a[0] - b[0]);
    const n = points.length;
    if (n < 2) return n === 1 ? `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}` : "";

    const dx = [];
    const slope = [];
    for (let i = 0; i < n - 1; i += 1) {
      dx[i] = points[i + 1][0] - points[i][0] || 1e-6;
      slope[i] = (points[i + 1][1] - points[i][1]) / dx[i];
    }

    const tangent = new Array(n);
    tangent[0] = slope[0];
    tangent[n - 1] = slope[n - 2];
    for (let i = 1; i < n - 1; i += 1) {
      if (slope[i - 1] * slope[i] <= 0) {
        tangent[i] = 0;
      } else {
        const average = (slope[i - 1] + slope[i]) / 2;
        const limit = 3 * Math.min(Math.abs(slope[i - 1]), Math.abs(slope[i]));
        tangent[i] = Math.sign(average) * Math.min(Math.abs(average), limit);
      }
    }

    let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
    for (let i = 0; i < n - 1; i += 1) {
      const h = dx[i];
      const c1x = points[i][0] + h / 3;
      const c1y = points[i][1] + (tangent[i] * h) / 3;
      const c2x = points[i + 1][0] - h / 3;
      const c2y = points[i + 1][1] - (tangent[i + 1] * h) / 3;
      path += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} `
        + `${points[i + 1][0].toFixed(1)},${points[i + 1][1].toFixed(1)}`;
    }
    return path;
  }

  _svg(info, window) {
    if (!window || !info) {
      return `<div class="empty">No window data yet</div>`;
    }
    const width = Math.max(320, this.clientWidth || 500);
    const height = 230;
    const pad = { l: 44, r: 16, t: 12, b: 26 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;

    const projected = info.projected !== null ? info.projected : info.percent;
    const yMax = Math.max(100, Math.ceil(Math.max(info.percent, projected, 100) / 50) * 50);
    const x = (ts) => pad.l + ((ts - window.start) / (window.end - window.start)) * innerW;
    const y = (v) => pad.t + innerH - (Math.max(0, Math.min(v, yMax)) / yMax) * innerH;
    const xEnd = x(window.end);
    const xNow = Math.min(x(info.now), xEnd);

    const grid = [];
    for (let v = 0; v <= yMax; v += 50) {
      const yy = y(v);
      grid.push(`<line x1="${pad.l}" y1="${yy}" x2="${width - pad.r}" y2="${yy}"
        stroke="var(--divider-color, rgba(128,128,128,.35))"
        stroke-width="${v === 0 ? 1 : 0.7}" opacity="${v === 0 ? 0.8 : 0.5}"/>`);
      grid.push(`<text x="${pad.l - 8}" y="${yy + 4}" text-anchor="end" font-size="11"
        fill="var(--secondary-text-color)">${v}%</text>`);
    }

    // The 100% threshold only needs a separate guide above the normal scale.
    if (yMax > 100) {
      grid.push(`<line x1="${pad.l}" y1="${y(100)}" x2="${width - pad.r}" y2="${y(100)}"
        stroke="var(--secondary-text-color)" stroke-width="1" stroke-dasharray="5 5" opacity="0.65"/>`);
    }

    // x labels: start, thirds, end. A window shorter than two days gets clock
    // times — four identical dates say nothing.
    const shortWindow = (window.end - window.start) <= 48 * 3600 * 1000;
    const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => window.start + f * (window.end - window.start));
    ticks.forEach((tick) => {
      grid.push(`<text x="${x(tick)}" y="${height - 6}" text-anchor="middle" font-size="11"
        fill="var(--secondary-text-color)">${this._fmtTick(tick, shortWindow)}</text>`);
    });

    // real usage, clipped to the window and to now; long windows are drawn at
    // daily resolution like the console's own chart
    let points = (this._points || [])
      .filter(([t]) => t >= window.start && t <= info.now)
      .map(([t, v]) => [t, v]);
    if (window.end - window.start > 2 * 86400000) {
      points = this._dailyPoints(points);
    }
    // Keep estimates separate from recorder data and from the solid line.
    const estimated = this._estimatedHistory(window, info.now);
    if (points.length && points[points.length - 1][0] < info.now) {
      points.push([info.now, info.percent]);
    }
    const pixelPoints = points.map(([t, v]) => [x(t), y(v)]);
    const usagePath = this._smoothPath(pixelPoints);
    // The area under the usage line is filled solid, like the over-limit region
    // but in a much quieter tone — closing the same curve down to the baseline.
    const usageArea = pixelPoints.length > 1
      ? `${usagePath} L${pixelPoints[pixelPoints.length - 1][0].toFixed(1)},${y(0).toFixed(1)}`
        + ` L${pixelPoints[0][0].toFixed(1)},${y(0).toFixed(1)} Z`
      : "";
    const usageFill = usageArea
      ? `<path d="${usageArea}" fill="var(--line-usage)" fill-opacity="0.12"/>`
      : "";
    const estimatePixels = estimated.map(([t, v]) => [x(t), y(v)]);
    const estimatePath = this._smoothPath(estimatePixels);
    const estimateFill = estimatePixels.length > 1
      ? (() => {
        const area = `${estimatePath} L${estimatePixels[estimatePixels.length - 1][0].toFixed(1)},${y(0).toFixed(1)}`
          + ` L${estimatePixels[0][0].toFixed(1)},${y(0).toFixed(1)} Z`;
        return `<path d="${area}" fill="var(--line-usage)" fill-opacity="0.05"/>
          <path d="${area}" fill="url(#estimated-usage-hatch)" opacity="0.55"/>`;
      })()
      : "";
    const estimateLine = estimatePixels.length > 1
      ? `<path d="${estimatePath}" fill="none" stroke="var(--line-usage)"
           stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`
      : "";
    const usage = points.length
      ? `<path d="${usagePath}" fill="none" stroke="var(--line-usage)"
           stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      : "";

    // forecast from now to the reset
    let forecast = "";
    let hatch = "";
    let pace = "";
    if (info.projected !== null) {
      // The forecast sits on the window's average-pace line, which starts at
      // 0 % when the window opened. Without that segment the line appears to
      // begin at the current point and looks flatter than the recent trend;
      // drawing it makes "you are using faster than the average" readable.
      pace = `<line x1="${x(window.start)}" y1="${y(0)}" x2="${xNow}" y2="${y(info.percent)}"
        stroke="var(--line-amber)" stroke-width="1.5"
        stroke-dasharray="3 4" opacity="0.75"/>`;
      forecast = `<line x1="${xNow}" y1="${y(info.percent)}" x2="${xEnd}" y2="${y(projected)}"
        stroke="var(--line-amber)" stroke-width="2" stroke-linecap="round"/>`;
      // A faint wash under the stripes: on its own the hatch read lighter than
      // the solid green and orange areas around it.
      const hatchPoints = `${xNow},${y(info.percent)} ${xEnd},${y(projected)} ${xEnd},${y(0)} ${xNow},${y(0)}`;
      hatch = `<polygon points="${hatchPoints}" fill="var(--line-amber)" fill-opacity="0.05"/>
        <polygon points="${hatchPoints}" fill="url(#usage-hatch)" opacity="0.55"/>`;
    }

    // The part of the forecast that sits above the allowance: the usage that
    // would happen after the limit is hit, shaded darker between the curve and
    // the 100 % line.
    let overLimit = "";
    if (info.projected !== null && projected > 100 && info.eta) {
      const xEta = Math.min(x(info.eta), xEnd);
      if (xEta < xEnd) {
        overLimit = `<polygon points="${xEta},${y(100)} ${xEnd},${y(projected)} ${xEnd},${y(100)}"
          fill="var(--usage-overlimit, #c46a00)" fill-opacity="0.26"/>`;
      }
    }

    // A vertical guide separates elapsed usage from the forecast.
    const nowGuide = `<line x1="${xNow}" y1="${pad.t}" x2="${xNow}" y2="${pad.t + innerH}"
      stroke="var(--line-usage)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>`;
    // markers: now (green), limit crossing and window end (amber)
    const dots = [`<circle cx="${xNow}" cy="${y(info.percent)}" r="4"
      fill="var(--line-usage)" stroke="var(--card-background-color)" stroke-width="2"/>`];
    if (info.projected !== null) {
      if (projected > 100 && info.eta) {
        const xEta = Math.min(x(info.eta), xEnd);
        dots.push(`<line x1="${xEta}" y1="${pad.t}" x2="${xEta}" y2="${pad.t + innerH}"
          stroke="var(--line-amber)" stroke-width="1" stroke-dasharray="4 4" opacity="0.55"/>`);
        dots.push(`<circle cx="${xEta}" cy="${y(100)}" r="4" fill="var(--line-amber)"
          stroke="var(--card-background-color)" stroke-width="2"/>`);
      }
      dots.push(`<circle cx="${xEnd}" cy="${y(projected)}" r="4" fill="var(--line-amber)"
        stroke="var(--card-background-color)" stroke-width="2"/>`);
      dots.push(`<text x="${xEnd - 6}" y="${y(projected) - 10}" text-anchor="end" font-size="12"
        font-weight="600" fill="var(--line-amber)">${Math.round(projected)}%</text>`);
    }

    return `<svg viewBox="0 0 ${width} ${height}" height="${height}" preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="estimated-usage-hatch" width="7" height="7" patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke="var(--line-usage)"
            stroke-width="1.2" opacity="0.32"/>
        </pattern>
        <pattern id="usage-hatch" width="7" height="7" patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke="var(--line-amber)"
            stroke-width="1.2" opacity="0.32"/>
        </pattern>
      </defs>
      ${grid.join("")}
      ${estimateFill}
      ${usageFill}
      ${hatch}
      ${pace}
      ${forecast}
      ${overLimit}
      ${estimateLine}
      ${usage}
      ${nowGuide}
      ${dots.join("")}
    </svg>`;
  }
}

customElements.define("llm-subscription-limit-card", UsageMeterCard);

/* A small footer card showing when the usage sensors poll next. Clicking it
   asks Home Assistant to poll them immediately; the entities are coordinator
   backed, so update_entity really does fetch fresh numbers. */
class SubscriptionRefreshBadge extends HTMLElement {
  static getStubConfig(hass, entities = [], entitiesFallback = []) {
    const suitable = [...entities, ...entitiesFallback].find((id) =>
      id.startsWith("sensor.") && hass?.states?.[id]?.attributes?.resets_at
    );
    return { entity: suitable || "sensor.select_usage_sensor", refresh_seconds: 300 };
  }

  static getConfigForm() {
    return {
      schema: [
        { name: "entity", required: true, selector: { entity: { domain: "sensor" } } },
        {
          name: "refresh_seconds",
          selector: { number: { min: 30, max: 3600, step: 30, mode: "box", unit_of_measurement: "s" } },
          default: 300,
        },
        { name: "targets", selector: { entity: { domain: "sensor", multiple: true } } },
      ],
      computeLabel: (field) => ({
        entity: "Anchor sensor",
        refresh_seconds: "Poll interval",
        targets: "Sensors to refresh",
      })[field.name],
      computeHelper: (field) => {
        if (field.name === "entity") {
          return "Any usage sensor; its last update sets the countdown.";
        }
        return field.name === "targets" ? "Defaults to the anchor sensor." : undefined;
      },
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("llm-subscription-refresh-badge: 'entity' is required");
    }
    this.config = { refresh_seconds: 300, ...config };
    this._pendingUntil = 0;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._timer = setInterval(() => this._render(), 1000);
    if (!this._clickBound) {
      this._clickBound = true;
      this.addEventListener("click", () => this._refreshNow());
    }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  get targets() {
    const configured = Array.isArray(this.config?.targets) ? this.config.targets : [];
    return configured.length ? configured : [this.config.entity];
  }

  async _refreshNow() {
    if (!this._hass) return;
    this._pendingUntil = Date.now() + 8000;
    this._render();
    try {
      await this._hass.callService("homeassistant", "update_entity", {
        entity_id: this.targets,
      });
    } catch (error) {
      this._pendingUntil = 0;
      this._render();
    }
  }

  _render() {
    if (!this.config) return;
    const state = this._hass?.states?.[this.config.entity];
    // last_updated only moves when state or attributes change, and last_reported
    // is skipped for identical writes — whichever is later anchors the countdown.
    const stamps = [Date.parse(state?.last_updated || ""), Date.parse(state?.last_reported || "")]
      .filter((value) => Number.isFinite(value));
    const polledAt = stamps.length ? Math.max(...stamps) : NaN;
    let text = "Waiting for the first poll";
    if (Number.isFinite(polledAt)) {
      const interval = (Number(this.config.refresh_seconds) || 300) * 1000;
      const left = Math.max(0, polledAt + interval - Date.now());
      const minutes = Math.floor(left / 60000);
      const seconds = Math.floor((left % 60000) / 1000);
      text = left > 0
        ? `Refreshing in ${minutes}:${String(seconds).padStart(2, "0")}`
        : "Refreshing…";
    }
    if (Date.now() < (this._pendingUntil || 0)) {
      text = "Refreshing…";
    }
    const html = `
      <style>
        :host { display: block; cursor: pointer; }
        ha-card { transition: opacity .15s ease; }
        ha-card:hover { opacity: .92; }
        /* centred, and only as wide as its own text */
        ha-card { display: flex; justify-content: center; align-items: center;
                  gap: 8px; width: fit-content; margin: 0 auto;
                  padding: 5px 14px; font-size: 12px;
                  color: var(--secondary-text-color);
                  background: color-mix(in srgb, var(--card-background-color) 80%, transparent);
                  border-radius: 999px; box-shadow: none; border: none;
                  backdrop-filter: blur(6px); }
        .dot { width: 7px; height: 7px; border-radius: 50%;
               background: var(--line-amber, #f0b429); opacity: .8; }
      </style>
      <ha-card title="Click to refresh now"><span class="dot"></span><span>${text}</span></ha-card>`;
    if (html !== this._html) {
      this._html = html;
      this.shadowRoot.innerHTML = html;
    }
  }
}

customElements.define("llm-subscription-refresh-badge", SubscriptionRefreshBadge);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "llm-subscription-limit-card",
  name: "LLM subscription limit",
  description: "Usage history and projected subscription limits",
  documentationURL: "https://github.com/y-decimal/ha-llm-subscription-limit-card",
});
window.customCards.push({
  type: "llm-subscription-refresh-badge",
  name: "Subscription refresh badge",
  description: "Shows when the usage sensors poll next; click to refresh now",
  documentationURL: "https://github.com/y-decimal/ha-llm-subscription-limit-card",
});
