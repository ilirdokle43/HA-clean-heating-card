/**
 * clean-heating-card
 *
 * A combined gas-cylinder + room-heating Lovelace card.
 * Replaces the `gauge` + `custom:button-card` pair used by the
 * `kaldaja_block_*` decluttering templates.
 *
 * Supports one room (the original flat config) or several rooms via a `rooms:`
 * list, with a visual editor that lets you add, reorder, edit and remove rooms.
 *
 * No external dependencies: no button-card, no card-mod, no CDN, no fonts.
 * Icons come from Home Assistant's own <ha-icon>.
 *
 * Rendering note
 * --------------
 * A standalone `/local/` module cannot reliably obtain LitElement from the
 * Home Assistant frontend -- HA does not export it on a stable global, and the
 * old `Object.getPrototypeOf(customElements.get("ha-panel-lovelace"))` trick no
 * longer yields usable `html`/`css` tag functions. Rather than bundle a copy of
 * Lit (an external library) this card is a plain custom element that builds its
 * shadow DOM once and then performs targeted text/class/style updates.
 *
 * That is also what the brief asks for: nothing is ever re-rendered wholesale,
 * so a rapid sequence of +/- presses is never interrupted by a re-render, and
 * state changes land on the next `hass` assignment.
 *
 * @license MIT
 */

const CARD_TYPE = "clean-heating-card";
const CARD_VERSION = "1.1.3";

/* ------------------------------------------------------------------ config */

const DEFAULTS = Object.freeze({
  temperature_step: 0.5,
  gas_warning: 25,
  gas_critical: 15,
  show_name: true,
});

/** Per-room options. These may sit at the top level (single room) or in `rooms[]`. */
const ROOM_KEYS = [
  "room_name",
  "heating_entity",
  "room_temp_entity",
  "target_temp_entity",
  "boiler_entity",
  "automation_entity",
  "script_entity",
  "temp_override_entity",
];

/** Per-room options that are entity ids. */
const ROOM_ENTITY_KEYS = ROOM_KEYS.filter((k) => k !== "room_name");

/** Options that apply to the whole card. */
const GLOBAL_KEYS = [
  "gas_entity",
  "gas_warning",
  "gas_critical",
  "temperature_step",
  "show_name",
];

/** Each room needs at least these. */
const REQUIRED_ROOM_KEYS = ["room_temp_entity", "target_temp_entity"];

const STATUS_TEXT = Object.freeze({
  active: "Heating now",
  enabled: "Heating enabled",
  override: "Temperature mode",
  off: "Off",
});

/* ----------------------------------------------------------------- helpers */

const NON_VALUES = new Set(["unknown", "unavailable", "none", ""]);

/** True when `v` is a state string we can safely turn into a number. */
function isNumeric(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (s === "" || NON_VALUES.has(s.toLowerCase())) return false;
  return Number.isFinite(Number(s));
}

function clamp(n, lo, hi) {
  if (Number.isFinite(lo)) n = Math.max(lo, n);
  if (Number.isFinite(hi)) n = Math.min(hi, n);
  return n;
}

/** Kill float drift from repeated 0.5 additions (19.000000000000004). */
function tidy(n) {
  return Math.round(n * 1000) / 1000;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function icon(name) {
  const i = document.createElement("ha-icon");
  i.setAttribute("icon", name);
  return i;
}

/* -------------------------------------------------------------------- card */

class CleanHeatingCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._cfg = null;
    this._rooms = [];
    this._hass = null;
    this._built = false;
    this._el = {};
    /** Per-target-entity pending value, so rapid presses accumulate without
     *  ever being *displayed* before HA confirms them. */
    this._pending = new Map();
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Accepts either the flat single-room shape (backwards compatible) or a
   * `rooms:` list. The flat shape is normalised into a one-entry list so the
   * rest of the card only ever deals with one code path.
   */
  static normaliseRooms(config) {
    if (Array.isArray(config.rooms)) {
      return config.rooms.map((r) => ({ ...r }));
    }
    const flat = {};
    for (const k of ROOM_KEYS) {
      if (config[k] !== undefined) flat[k] = config[k];
    }
    return [flat];
  }

  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("clean-heating-card: configuration is missing.");
    }

    const rooms = CleanHeatingCard.normaliseRooms(config);

    if (!rooms.length) {
      throw new Error(
        "clean-heating-card: `rooms` is empty. Add at least one room, or use " +
          "the flat single-room form with room_temp_entity / target_temp_entity.",
      );
    }

    rooms.forEach((room, i) => {
      const where = Array.isArray(config.rooms) ? `rooms[${i}]` : "config";
      const missing = REQUIRED_ROOM_KEYS.filter((k) => !room[k]);
      if (missing.length) {
        throw new Error(
          `clean-heating-card: ${where} is missing ` +
            `${missing.join(", ")}. Every room needs room_temp_entity and ` +
            "target_temp_entity.",
        );
      }
      for (const key of ROOM_ENTITY_KEYS) {
        const v = room[key];
        if (v !== undefined && (typeof v !== "string" || !v.includes("."))) {
          throw new Error(
            `clean-heating-card: ${where}.${key} must be an entity id, got ` +
              `${JSON.stringify(v)}.`,
          );
        }
      }
    });

    if (
      config.gas_entity !== undefined &&
      (typeof config.gas_entity !== "string" || !config.gas_entity.includes("."))
    ) {
      throw new Error("clean-heating-card: gas_entity must be an entity id.");
    }

    const step = Number(config.temperature_step);
    if (config.temperature_step !== undefined && (!Number.isFinite(step) || step <= 0)) {
      throw new Error("clean-heating-card: temperature_step must be a positive number.");
    }

    this._cfg = {
      ...DEFAULTS,
      ...config,
      temperature_step: Number.isFinite(step) && step > 0 ? step : DEFAULTS.temperature_step,
      gas_warning: Number.isFinite(Number(config.gas_warning))
        ? Number(config.gas_warning)
        : DEFAULTS.gas_warning,
      gas_critical: Number.isFinite(Number(config.gas_critical))
        ? Number(config.gas_critical)
        : DEFAULTS.gas_critical,
    };
    this._rooms = rooms;

    this._built = false;
    this._pending.clear();
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  get hass() {
    return this._hass;
  }

  get _multi() {
    return this._rooms.length > 1;
  }

  getCardSize() {
    return this._multi ? 1 + this._rooms.length : 3;
  }

  /** Sections dashboard sizing. One HA grid row is ~56px. */
  getGridOptions() {
    const px = this._multi
      ? 28 + (this._cfg && this._cfg.gas_entity ? 52 : 0) + this._rooms.length * 66
      : 146;
    const rows = Math.max(2, Math.ceil(px / 56));
    return { columns: 12, rows, min_columns: 6, min_rows: Math.max(2, rows - 1) };
  }

  getLayoutOptions() {
    const g = this.getGridOptions();
    return {
      grid_columns: g.columns,
      grid_rows: g.rows,
      grid_min_columns: g.min_columns,
      grid_min_rows: g.min_rows,
    };
  }

  static getStubConfig() {
    return {
      type: `custom:${CARD_TYPE}`,
      rooms: [{ room_name: "Room", room_temp_entity: "", target_temp_entity: "" }],
    };
  }

  static async getConfigElement() {
    if (!customElements.get("ha-form")) return undefined;
    return document.createElement(`${CARD_TYPE}-editor`);
  }

  /* ------------------------------------------------------------ state read */

  _stateOf(id) {
    if (!id || !this._hass) return undefined;
    return this._hass.states[id];
  }

  _roomState(room, key) {
    return this._stateOf(room[key]);
  }

  _roomOn(room, key) {
    const s = this._roomState(room, key);
    return !!s && s.state === "on";
  }

  /**
   * Per-room heating state. Computed fresh from *this* room's entities every
   * time -- never cached or shared between rows.
   *
   * The room's own `heating_entity` is authoritative. The boiler is a shared
   * central appliance: it says the burner is running for *someone*, not for
   * whom, so on its own it must never mark a room active. It only upgrades an
   * already-enabled room from "enabled" to "firing".
   *
   *   heating   boiler   ->  mode
   *   off       off          off
   *   off       on           off        <- the bug: this used to be "active"
   *   on        off          enabled
   *   on        on           active
   *
   * Temperature override is checked only once the room is known not to be
   * enabled, matching the old button-card (heating on -> red, else override
   * -> cyan, else grey).
   */
  _heatMode(room) {
    const boilerId = room.boiler_entity || this._cfg.boiler_entity;
    const boilerState = this._stateOf(boilerId);
    const boilerRunning = !!boilerState && boilerState.state === "on";

    // A room with no heating_entity of its own has nothing else to go on, so
    // the boiler stands in for it (the original single-room behaviour).
    const enabled = room.heating_entity
      ? this._roomOn(room, "heating_entity")
      : boilerRunning;

    if (enabled && boilerRunning) return "active";
    if (enabled) return "enabled";
    if (this._roomOn(room, "temp_override_entity")) return "override";
    return "off";
  }

  _tempUnit(room) {
    const cfgUnit =
      this._hass &&
      this._hass.config &&
      this._hass.config.unit_system &&
      this._hass.config.unit_system.temperature;
    if (cfgUnit) return cfgUnit;
    const s = room && this._roomState(room, "room_temp_entity");
    const u = s && s.attributes && s.attributes.unit_of_measurement;
    return u || "°C";
  }

  _degree(room) {
    const unit = this._tempUnit(room);
    return unit.startsWith("°") ? "°" : ` ${unit}`;
  }

  _locale() {
    const l = this._hass && this._hass.locale && this._hass.locale.language;
    return l || (typeof navigator !== "undefined" ? navigator.language : "en") || "en";
  }

  /** Locale-aware fixed-decimal number, e.g. "22,6" in de-DE. */
  _num(value, digits) {
    const d = digits === undefined ? 1 : digits;
    try {
      return new Intl.NumberFormat(this._locale(), {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      }).format(value);
    } catch (_e) {
      return Number(value).toFixed(d);
    }
  }

  _roomName(room) {
    if (room.room_name) return room.room_name;
    for (const k of ["heating_entity", "room_temp_entity", "target_temp_entity"]) {
      const s = this._roomState(room, k);
      if (s && s.attributes && s.attributes.friendly_name) return s.attributes.friendly_name;
    }
    return "Heating";
  }

  /* --------------------------------------------------------------- actions */

  _callService(domain, service, data, target) {
    if (!this._hass || typeof this._hass.callService !== "function") return;
    this._hass.callService(domain, service, data || {}, target);
  }

  _pressPower(room, ev) {
    ev.stopPropagation();
    if (!room.script_entity) return;
    this._callService(
      "script",
      "turn_on",
      { variables: { mode: "manual" } },
      { entity_id: room.script_entity },
    );
  }

  _pressAuto(room, ev) {
    ev.stopPropagation();
    if (!room.automation_entity) return;
    this._callService("automation", "toggle", {}, { entity_id: room.automation_entity });
  }

  /**
   * Step a room's target temperature.
   *
   * The new number is never written to the DOM -- the display only follows
   * `hass`. But the requested value is remembered per target entity so that
   * three fast taps go 19 -> 19.5 -> 20 -> 20.5 instead of sending 19.5 three
   * times while the round trip is still in flight.
   */
  _step(room, dir, ev) {
    ev.stopPropagation();
    const id = room.target_temp_entity;
    const s = this._stateOf(id);
    if (!s) return;

    const attrs = s.attributes || {};
    const min = Number(attrs.min);
    const max = Number(attrs.max);
    const step = this._cfg.temperature_step;

    const base = this._effectiveTarget(room);
    if (!Number.isFinite(base)) return;

    const next = tidy(clamp(base + dir * step, min, max));
    if (next === base) return; // already at the limit

    this._pending.set(id, { value: next, at: Date.now() });
    this._callService("input_number", "set_value", { value: next }, { entity_id: id });
    this._syncStepButtons(this._refsFor(room), room);
  }

  /** Pending value if still fresh, else the confirmed state. */
  _effectiveTarget(room) {
    const id = room.target_temp_entity;
    const p = this._pending.get(id);
    if (p && Date.now() - p.at < 4000) return p.value;
    const s = this._stateOf(id);
    return s && isNumeric(s.state) ? Number(s.state) : NaN;
  }

  _fireMoreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Minimal but correct support for HA's standard action config. */
  _cardAction(room) {
    const cfg = this._cfg.tap_action || { action: "more-info" };
    const r = room || this._rooms[0] || {};
    const fallbackEntity =
      r.heating_entity || r.room_temp_entity || r.target_temp_entity || this._cfg.gas_entity;

    switch (cfg.action) {
      case "none":
        return;
      case "more-info":
        this._fireMoreInfo(cfg.entity || fallbackEntity);
        return;
      case "toggle": {
        const id = cfg.entity || r.heating_entity;
        if (id) this._callService("homeassistant", "toggle", {}, { entity_id: id });
        return;
      }
      case "navigate":
        if (cfg.navigation_path) {
          history.pushState(null, "", cfg.navigation_path);
          window.dispatchEvent(
            new CustomEvent("location-changed", { bubbles: true, composed: true }),
          );
        }
        return;
      case "url":
        if (cfg.url_path) window.open(cfg.url_path, cfg.new_tab === false ? "_self" : "_blank");
        return;
      case "call-service":
      case "perform-action": {
        const full = cfg.perform_action || cfg.service;
        if (!full || !full.includes(".")) return;
        const [d, s] = full.split(".");
        this._callService(d, s, cfg.data || cfg.service_data || {}, cfg.target);
        return;
      }
      default:
        this._fireMoreInfo(fallbackEntity);
    }
  }

  /* ----------------------------------------------------------------- build */

  _refsFor(room) {
    return this._el.rooms[this._rooms.indexOf(room)];
  }

  /** The four controls, shared by both layouts. */
  _buildControls(room) {
    const wrap = el("div", "controls");

    const mk = (cls, label, child) => {
      const b = el("button", `ctl ${cls}`);
      b.type = "button";
      b.title = label;
      if (typeof child === "string") b.textContent = child;
      else b.appendChild(child);
      b.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      });
      wrap.appendChild(b);
      return b;
    };

    const minus = mk("minus", "Lower target temperature", icon("mdi:minus"));
    const plus = mk("plus", "Raise target temperature", icon("mdi:plus"));
    const power = mk("power", "Toggle heating", icon("mdi:power"));
    const auto = mk("auto", "Toggle automatic control", "AUTO");

    minus.addEventListener("click", (e) => this._step(room, -1, e));
    plus.addEventListener("click", (e) => this._step(room, +1, e));
    power.addEventListener("click", (e) => this._pressPower(room, e));
    auto.addEventListener("click", (e) => this._pressAuto(room, e));

    return { wrap, minus, plus, power, auto };
  }

  _buildFlame() {
    const flame = el("div", "flame");
    flame.setAttribute("aria-hidden", "true");
    flame.appendChild(icon("mdi:fire"));
    return flame;
  }

  _buildRoomText() {
    const text = el("div", "roomtext");
    const name = el("div", "name");
    const cur = el("div", "big cur");
    const line = el("div", "targetline");
    const target = el("span", null, "Target —");
    const delta = el("span", "delta");
    delta.hidden = true;
    line.append(target, delta);
    const status = el("div", "status", "Off");
    text.append(name, cur, line, status);
    return { text, name, cur, target, delta, status };
  }

  _buildGas() {
    const gas = el("section", "gas");
    gas.setAttribute("aria-label", "Gas cylinder level");

    const head = el("div", "head");
    head.append(icon("mdi:gas-cylinder"), el("span", null, "Gazi"));

    const value = el("div", "big");
    const num = el("span", null, "—");
    const unit = el("i", "unit", "%");
    value.append(num, unit);

    const bar = el("div", "bar");
    const fill = el("div", "fill");
    bar.appendChild(fill);

    gas.append(head, value, bar);
    return { gas, value, num, fill };
  }

  _build() {
    const root = this.shadowRoot;
    root.innerHTML = `<style>${CleanHeatingCard.styles}</style>`;

    const card = document.createElement("ha-card");
    const surface = el("div", "surface");
    surface.setAttribute("role", "button");
    surface.tabIndex = 0;

    const notice = el("div", "notice");
    notice.hidden = true;
    surface.appendChild(notice);

    this._el = { surface, notice, rooms: [] };

    if (this._multi) {
      surface.classList.add("multi");

      if (this._cfg.gas_entity) {
        const g = this._buildGas();
        g.gas.classList.add("strip");
        surface.appendChild(g.gas);
        Object.assign(this._el, { gasSection: g.gas, gasValue: g.value, gasNum: g.num, gasFill: g.fill });
      }

      const list = el("div", "rooms");
      for (const room of this._rooms) {
        const row = el("div", "roomrow");
        const flame = this._buildFlame();
        const t = this._buildRoomText();
        const c = this._buildControls(room);
        row.append(flame, t.text, c.wrap);
        list.appendChild(row);
        this._el.rooms.push({
          row,
          flame,
          name: t.name,
          cur: t.cur,
          target: t.target,
          delta: t.delta,
          status: t.status,
          minus: c.minus,
          plus: c.plus,
          power: c.power,
          auto: c.auto,
        });
      }
      surface.appendChild(list);
    } else {
      const room = this._rooms[0];
      const grid = el("div", "grid");

      const flame = this._buildFlame();
      grid.appendChild(flame);

      if (this._cfg.gas_entity) {
        const g = this._buildGas();
        grid.appendChild(g.gas);
        Object.assign(this._el, { gasSection: g.gas, gasValue: g.value, gasNum: g.num, gasFill: g.fill });
      } else {
        grid.classList.add("no-gas");
      }

      const roomSection = el("section", "room");
      const t = this._buildRoomText();
      roomSection.appendChild(t.text);
      grid.appendChild(roomSection);

      const c = this._buildControls(room);
      grid.appendChild(c.wrap);

      surface.appendChild(grid);
      this._el.rooms.push({
        row: roomSection,
        flame,
        name: t.name,
        cur: t.cur,
        target: t.target,
        delta: t.delta,
        status: t.status,
        minus: c.minus,
        plus: c.plus,
        power: c.power,
        auto: c.auto,
      });
    }

    surface.addEventListener("click", () => this._cardAction(this._rooms[0]));
    surface.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._cardAction(this._rooms[0]);
      }
    });

    card.appendChild(surface);
    root.appendChild(card);
    this._built = true;
  }

  /* ---------------------------------------------------------------- render */

  _render() {
    if (!this._cfg || !this._hass) return;
    if (!this._built) this._build();

    this._renderNotice();
    this._renderGas();
    this._rooms.forEach((room, i) => {
      const refs = this._el.rooms[i];
      this._renderRoom(refs, room);
      this._renderControls(refs, room);
    });
  }

  _renderNotice() {
    const missing = [];
    if (this._cfg.gas_entity && !this._hass.states[this._cfg.gas_entity]) {
      missing.push(this._cfg.gas_entity);
    }
    for (const room of this._rooms) {
      for (const k of ROOM_ENTITY_KEYS) {
        if (room[k] && !this._hass.states[room[k]]) missing.push(room[k]);
      }
    }
    const n = this._el.notice;
    if (!missing.length) {
      n.hidden = true;
      n.textContent = "";
      return;
    }
    n.hidden = false;
    n.textContent = `Entity not found: ${[...new Set(missing)].join(", ")}`;
  }

  _renderGas() {
    if (!this._el.gasSection) return;
    const cfg = this._cfg;
    const s = this._stateOf(cfg.gas_entity);
    const raw = s ? s.state : undefined;

    if (!isNumeric(raw)) {
      this._el.gasNum.textContent = "—";
      this._el.gasFill.style.width = "0%";
      this._el.gasValue.classList.remove("gas-low", "gas-crit");
      this._el.gasFill.classList.remove("gas-low", "gas-crit");
      this._el.gasSection.setAttribute("aria-label", "Gas cylinder level unavailable");
      return;
    }

    const pct = Number(raw);
    const shown = clamp(pct, 0, 100); // bar clamps; label shows the real value
    const crit = pct <= cfg.gas_critical;
    const warn = !crit && pct <= cfg.gas_warning;

    this._el.gasNum.textContent = this._num(pct, 0);
    this._el.gasFill.style.width = `${shown}%`;

    this._el.gasValue.classList.toggle("gas-low", warn);
    this._el.gasValue.classList.toggle("gas-crit", crit);
    this._el.gasFill.classList.toggle("gas-low", warn);
    this._el.gasFill.classList.toggle("gas-crit", crit);

    this._el.gasSection.setAttribute(
      "aria-label",
      `Gas cylinder ${this._num(pct, 0)} percent${crit ? ", critically low" : warn ? ", low" : ""}`,
    );
  }

  _renderRoom(refs, room) {
    const mode = this._heatMode(room);
    const deg = this._degree(room);

    refs.flame.className = `flame ${mode}`;
    refs.status.textContent = STATUS_TEXT[mode];
    refs.status.className = `status ${mode}`;

    if (this._cfg.show_name === false) {
      refs.name.hidden = true;
    } else {
      refs.name.hidden = false;
      refs.name.textContent = this._roomName(room);
    }

    const cur = this._roomState(room, "room_temp_entity");
    const curOk = cur && isNumeric(cur.state);
    refs.cur.textContent = curOk ? `${this._num(Number(cur.state))}${deg}` : "—";

    const tgt = this._roomState(room, "target_temp_entity");
    const tgtOk = tgt && isNumeric(tgt.state);
    refs.target.textContent = tgtOk ? `Target ${this._num(Number(tgt.state))}${deg}` : "Target —";

    // Drop the pending value once HA confirms it.
    const p = this._pending.get(room.target_temp_entity);
    if (p && tgtOk && Number(tgt.state) === p.value) {
      this._pending.delete(room.target_temp_entity);
    }

    const d = refs.delta;
    if (curOk && tgtOk) {
      const diff = tidy(Number(cur.state) - Number(tgt.state));
      d.hidden = false;
      if (Math.abs(diff) < 0.05) {
        d.textContent = "at target";
        d.className = "delta even";
      } else {
        d.textContent = `${diff > 0 ? "▲" : "▼"} ${this._num(Math.abs(diff))}${deg}`;
        d.className = `delta ${diff > 0 ? "above" : "below"}`;
      }
    } else {
      d.hidden = true;
    }

    refs.row.setAttribute(
      "aria-label",
      `${this._roomName(room)}. ${STATUS_TEXT[mode]}. ` +
        `Current ${curOk ? this._num(Number(cur.state)) + deg : "unavailable"}, ` +
        `target ${tgtOk ? this._num(Number(tgt.state)) + deg : "unavailable"}.`,
    );
  }

  _renderControls(refs, room) {
    refs.power.hidden = !room.script_entity;
    refs.auto.hidden = !room.automation_entity;

    const autoOn = this._roomOn(room, "automation_entity");
    refs.auto.classList.toggle("on", autoOn);
    refs.auto.classList.toggle("off", !autoOn);
    refs.auto.setAttribute("aria-pressed", String(autoOn));
    refs.auto.setAttribute(
      "aria-label",
      `${this._roomName(room)}: automatic control ${autoOn ? "enabled" : "disabled"}`,
    );
    refs.auto.title = `Automatic control is ${autoOn ? "on" : "off"} — tap to toggle`;

    const mode = this._heatMode(room);
    refs.power.classList.toggle("on", mode === "active" || mode === "enabled");
    refs.power.setAttribute(
      "aria-label",
      `${this._roomName(room)}: ${STATUS_TEXT[mode]}. Toggle heating`,
    );

    this._syncStepButtons(refs, room);
  }

  /** Disable +/- at the entity's own min/max. */
  _syncStepButtons(refs, room) {
    if (!refs) return;
    const s = this._stateOf(room.target_temp_entity);
    if (!s) {
      refs.plus.disabled = true;
      refs.minus.disabled = true;
      return;
    }
    const a = s.attributes || {};
    const min = Number(a.min);
    const max = Number(a.max);
    const cur = this._effectiveTarget(room);

    if (!Number.isFinite(cur)) {
      refs.plus.disabled = true;
      refs.minus.disabled = true;
      return;
    }
    const step = this._cfg.temperature_step;
    refs.plus.disabled = Number.isFinite(max) && tidy(cur + step) > max;
    refs.minus.disabled = Number.isFinite(min) && tidy(cur - step) < min;

    const deg = this._degree(room);
    const name = this._roomName(room);
    refs.plus.setAttribute("aria-label", `${name}: raise target by ${this._num(step)}${deg}`);
    refs.minus.setAttribute("aria-label", `${name}: lower target by ${this._num(step)}${deg}`);
  }

  /* ----------------------------------------------------------------- style */

  static get styles() {
    return `
      :host { display: block; }

      ha-card {
        container-type: inline-size;
        container-name: chc;
        overflow: hidden;
        height: 100%;
        box-sizing: border-box;
      }

      .surface {
        padding: 14px 16px;
        box-sizing: border-box;
        height: 100%;
        cursor: pointer;
        outline: none;
      }
      .surface:focus-visible {
        box-shadow: inset 0 0 0 2px var(--primary-color, #03a9f4);
        border-radius: var(--ha-card-border-radius, 12px);
      }

      .notice {
        margin: 0 0 8px;
        padding: 5px 9px;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.3;
        color: var(--warning-color, #ffa726);
        background: rgba(255, 167, 38, 0.14);
      }

      section { min-width: 0; }
      [hidden] { display: none !important; }

      /* ================================================== single-room grid */
      .grid {
        display: grid;
        grid-template-columns: minmax(96px, 0.8fr) minmax(128px, 1.2fr) auto;
        grid-template-areas: "gas room controls";
        gap: 14px;
        align-items: center;
        min-height: 118px;
      }
      .grid.no-gas {
        grid-template-columns: minmax(128px, 1fr) auto;
        grid-template-areas: "room controls";
      }
      .grid > .gas { grid-area: gas; }
      .grid > .room { grid-area: room; }
      .grid > .controls { grid-area: controls; }

      /* The flame shares the gas cell rather than stacking inside it: as a
         grid item in the same area it overlaps the gas content, so it never
         adds to the row height. */
      .grid > .flame {
        grid-area: gas;
        align-self: start;
        justify-self: end;
        margin-top: 10px;
      }
      .grid.no-gas > .flame { grid-area: room; align-self: start; justify-self: end; }

      .grid > .room {
        display: flex;
        align-items: center;
        padding-left: 14px;
        border-left: 1px solid var(--divider-color, rgba(128,128,128,0.25));
      }
      .grid.no-gas > .room { padding-left: 0; border-left: none; }

      .grid > .controls {
        display: grid;
        grid-template-columns: repeat(2, minmax(48px, auto));
        gap: 8px;
        justify-content: end;
        align-content: center;
      }

      /* ==================================================== multi-room list */
      .multi .gas.strip {
        display: grid;
        grid-template-columns: auto auto 1fr;
        align-items: center;
        gap: 12px;
        padding-bottom: 11px;
        border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.25));
      }
      .multi .gas.strip .big { font-size: 21px; }
      .multi .gas.strip .bar { width: 100%; }

      .multi .rooms { display: flex; flex-direction: column; }

      .multi .roomrow {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        /* Top-align, so the flame relates to the room name / temperature
           group rather than being centred against the whole row height
           (name + target + status). Controls opt back into centring. */
        align-items: start;
        gap: 12px;
        padding: 11px 0;
      }
      .multi .roomrow + .roomrow {
        border-top: 1px solid var(--divider-color, rgba(128,128,128,0.25));
      }
      .multi .roomrow > .controls { align-self: center; }
      .multi .flame { width: 38px; height: 38px; border-radius: 12px; margin-top: 2px; }
      .multi .flame ha-icon { --mdc-icon-size: 22px; width: 22px; height: 22px; }
      .multi .roomtext {
        display: grid;
        grid-template-columns: auto auto;
        align-items: baseline;
        column-gap: 10px;
        row-gap: 1px;
      }
      .multi .name { grid-column: 1 / -1; }
      .multi .big.cur { font-size: 24px; }
      .multi .targetline { margin-top: 0; }
      .multi .status { grid-column: 1 / -1; margin-top: 2px; }
      .multi .controls {
        display: grid;
        grid-template-columns: repeat(4, minmax(44px, auto));
        gap: 7px;
        justify-content: end;
      }
      .multi .ctl { min-width: 44px; min-height: 40px; }

      /* ============================================================ shared */
      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--secondary-text-color, #8a8a8a);
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .head ha-icon {
        --mdc-icon-size: 17px;
        width: 17px;
        height: 17px;
        /* Optically align the cylinder with the GAZI cap-height. */
        transform: translateY(-3px);
      }
      .multi .head ha-icon { transform: none; }

      .gas { display: flex; flex-direction: column; gap: 7px; }

      .big {
        font-size: 30px;
        font-weight: 600;
        line-height: 1.05;
        color: var(--primary-text-color, #e1e1e1);
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      }
      .unit {
        font-size: 15px;
        font-weight: 500;
        font-style: normal;
        color: var(--secondary-text-color, #8a8a8a);
        margin-left: 2px;
      }

      .gas .big { color: var(--chc-gas, #29b6f6); }
      .gas .big.gas-low  { color: var(--chc-gas-warn, #ffb300); }
      .gas .big.gas-crit { color: var(--chc-gas-crit, #e53935); }

      .bar {
        height: 6px;
        border-radius: 999px;
        background: var(--divider-color, rgba(128,128,128,0.25));
        overflow: hidden;
      }
      .fill {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: var(--chc-gas, #29b6f6);
        transition: width 0.45s ease, background-color 0.3s ease;
      }
      .fill.gas-low  { background: var(--chc-gas-warn, #ffb300); }
      .fill.gas-crit { background: var(--chc-gas-crit, #e53935); }

      .roomtext { min-width: 0; }

      .flame {
        position: relative;
        flex: 0 0 auto;
        width: 46px;
        height: 46px;
        display: grid;
        place-items: center;
        border-radius: 14px;
        color: var(--disabled-text-color, #6f6f6f);
        transition: color 0.3s ease;
      }
      .flame::before {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: currentColor;
        opacity: 0.14;
        transition: opacity 0.3s ease;
      }
      .flame ha-icon {
        position: relative;
        /* Optical, not geometric: the mdi:fire path is symmetric in its
           viewBox, but the glyph is bottom-heavy and tapers to a point, so a
           geometrically centred flame reads as sitting low. Offset via top
           rather than transform, so it cannot conflict with the chc-sway
           animation, which owns transform on this element.
           Override --chc-flame-nudge to retune without editing the card. */
        top: var(--chc-flame-nudge, -3px);
        --mdc-icon-size: 26px;
        width: 26px;
        height: 26px;
      }

      .flame.enabled  { color: var(--chc-enabled, #ffa726); }
      .flame.override { color: var(--chc-override, #27d1f6); }
      .flame.active   { color: var(--chc-active, #ff1a1a); }
      .flame.active::before { opacity: 0.2; }
      .flame.active::after {
        content: "";
        position: absolute;
        inset: -7px;
        border-radius: 20px;
        background: radial-gradient(closest-side, currentColor, transparent 72%);
        opacity: 0.3;
        pointer-events: none;
        animation: chc-glow 2.8s ease-in-out infinite;
      }
      @keyframes chc-glow {
        0%, 100% { opacity: 0.2;  transform: scale(0.95); }
        50%      { opacity: 0.44; transform: scale(1.06); }
      }

      /* Firing: the flame sways side to side. Horizontal only -- no rotation
         and no vertical jump, so it reads as flicker rather than jitter. */
      .flame.active ha-icon { animation: chc-sway 0.72s ease-in-out infinite; }
      @keyframes chc-sway {
        0%, 100% { transform: translateX(-2.2px); }
        25%      { transform: translateX(1.8px); }
        50%      { transform: translateX(-1.3px); }
        75%      { transform: translateX(2.2px); }
      }

      .name {
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--secondary-text-color, #8a8a8a);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .big.cur { margin-top: 1px; }

      .targetline {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 3px;
        font-size: 15px;
        font-weight: 600;
        color: var(--secondary-text-color, #8a8a8a);
        font-variant-numeric: tabular-nums;
      }
      .delta {
        font-size: 12px;
        font-weight: 700;
        padding: 1px 7px;
        border-radius: 999px;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .delta.above { color: var(--chc-gas, #29b6f6); background: rgba(41,182,246,0.15); }
      .delta.below { color: var(--chc-enabled, #ffa726); background: rgba(255,167,38,0.16); }
      .delta.even  { color: var(--secondary-text-color, #8a8a8a); background: rgba(128,128,128,0.16); }

      .status {
        margin-top: 5px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--disabled-text-color, #6f6f6f);
        transition: color 0.3s ease;
      }
      .status.enabled  { color: var(--chc-enabled, #ffa726); }
      .status.override { color: var(--chc-override, #27d1f6); }
      .status.active   { color: var(--chc-active, #ff1a1a); }

      .ctl {
        -webkit-tap-highlight-color: transparent;
        appearance: none;
        border: none;
        margin: 0;
        min-width: 48px;
        min-height: 44px;
        padding: 0 10px;
        border-radius: 12px;
        display: grid;
        place-items: center;
        cursor: pointer;
        font-family: inherit;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--primary-text-color, #e1e1e1);
        background: rgba(128, 128, 128, 0.16);
        transition: transform 0.12s ease, background-color 0.2s ease, color 0.2s ease;
      }
      .ctl ha-icon { --mdc-icon-size: 20px; width: 20px; height: 20px; }
      .ctl:hover { background: rgba(128, 128, 128, 0.26); }
      .ctl:active { transform: scale(0.93); }
      .ctl:focus-visible { outline: 2px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
      .ctl:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }

      .ctl.power.on { color: var(--chc-active, #ff1a1a); background: rgba(255, 26, 26, 0.18); }
      .ctl.auto.on  { color: var(--chc-auto-on, #1db954); background: rgba(29, 185, 84, 0.18); }
      .ctl.auto.off { color: var(--chc-auto-off, #e05252); background: rgba(224, 82, 82, 0.15); }

      /* ======================================================== responsive */
      @container chc (max-width: 430px) {
        .grid {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
          grid-template-areas: "gas room" "controls controls";
          gap: 12px 14px;
          min-height: 0;
        }
        .grid.no-gas {
          grid-template-columns: minmax(0, 1fr);
          grid-template-areas: "room" "controls";
        }
        .grid > .controls {
          grid-template-columns: repeat(4, minmax(48px, 1fr));
          justify-content: stretch;
          padding-top: 2px;
        }
        .big { font-size: 26px; }
        .grid > .flame { width: 40px; height: 40px; }
        .grid > .flame ha-icon { --mdc-icon-size: 23px; width: 23px; height: 23px; }

        .multi .roomrow {
          grid-template-columns: auto minmax(0, 1fr);
          row-gap: 9px;
        }
        .multi .controls {
          grid-column: 1 / -1;
          grid-template-columns: repeat(4, minmax(44px, 1fr));
          justify-content: stretch;
        }
        .multi .big.cur { font-size: 22px; }
      }

      @container chc (max-width: 260px) {
        .grid {
          grid-template-columns: minmax(0, 1fr);
          grid-template-areas: "gas" "room" "controls";
        }
        .grid > .room { border-left: none; padding-left: 0; }
      }

      /* Safety net for engines without container queries. */
      @supports not (container-type: inline-size) {
        @media (max-width: 500px) {
          .grid {
            grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
            grid-template-areas: "gas room" "controls controls";
            min-height: 0;
          }
          .grid > .controls {
            grid-template-columns: repeat(4, minmax(48px, 1fr));
            justify-content: stretch;
          }
          .multi .roomrow { grid-template-columns: auto minmax(0, 1fr); row-gap: 9px; }
          .multi .controls { grid-column: 1 / -1; grid-template-columns: repeat(4, 1fr); }
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .flame.active::after { animation: none; opacity: 0.32; }
        .flame.active ha-icon { animation: none; transform: none; }
        .fill, .ctl, .flame, .status { transition: none; }
        .ctl:active { transform: none; }
      }
    `;
  }
}

/* ------------------------------------------------------------------ editor */

const GLOBAL_SCHEMA = [
  { name: "gas_entity", selector: { entity: { domain: ["sensor"] } } },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "temperature_step", selector: { number: { min: 0.1, max: 5, step: 0.1, mode: "box" } } },
      { name: "gas_warning", selector: { number: { min: 0, max: 100, step: 1, mode: "box" } } },
      { name: "gas_critical", selector: { number: { min: 0, max: 100, step: 1, mode: "box" } } },
    ],
  },
  { name: "show_name", selector: { boolean: {} } },
];

const ROOM_SCHEMA = [
  { name: "room_name", selector: { text: {} } },
  { name: "room_temp_entity", required: true, selector: { entity: { domain: ["sensor"] } } },
  { name: "target_temp_entity", required: true, selector: { entity: { domain: ["input_number"] } } },
  { name: "heating_entity", selector: { entity: { domain: ["input_boolean", "switch"] } } },
  { name: "temp_override_entity", selector: { entity: { domain: ["input_boolean", "switch"] } } },
  { name: "boiler_entity", selector: { entity: { domain: ["light", "switch", "binary_sensor"] } } },
  { name: "script_entity", selector: { entity: { domain: ["script"] } } },
  { name: "automation_entity", selector: { entity: { domain: ["automation"] } } },
];

const LABELS = {
  gas_entity: "Gas cylinder sensor",
  temperature_step: "Step (°)",
  gas_warning: "Low gas (%)",
  gas_critical: "Critical gas (%)",
  show_name: "Show room names",
  room_name: "Room name",
  room_temp_entity: "Room temperature",
  target_temp_entity: "Target temperature",
  heating_entity: "Heating status",
  temp_override_entity: "Temperature override",
  boiler_entity: "Boiler",
  script_entity: "Toggle script",
  automation_entity: "Automation",
};

class CleanHeatingCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._rooms = [];
    this._open = 0;
    this._built = false;
  }

  setConfig(config) {
    const rooms = CleanHeatingCard.normaliseRooms(config);
    // HA may set `hass` before `setConfig`, in which case an empty shell has
    // already been built -- that must be rebuilt. Once the list is up, only a
    // change in room count needs a rebuild; anything else syncs in place so
    // typing in a field does not lose focus on every keystroke.
    const rebuild = !this._built || rooms.length !== this._rooms.length;
    this._config = { ...config };
    this._rooms = rooms;
    this._render(rebuild);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._render(first && !this._built);
  }

  /* Always emit the `rooms:` form so the shape is predictable once edited. */
  _emit() {
    const out = { type: `custom:${CARD_TYPE}` };
    for (const k of GLOBAL_KEYS) {
      if (this._config[k] !== undefined && this._config[k] !== "") out[k] = this._config[k];
    }
    if (this._config.tap_action) out.tap_action = this._config.tap_action;
    out.rooms = this._rooms.map((r) => {
      const o = {};
      for (const k of ROOM_KEYS) if (r[k] !== undefined && r[k] !== "") o[k] = r[k];
      return o;
    });
    this._config = { ...out };
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: out },
        bubbles: true,
        composed: true,
      }),
    );
    this._render(true);
  }

  _label(s) {
    return LABELS[s.name] || (s.name ? s.name.replace(/_/g, " ") : "");
  }

  _render(force) {
    if (!this._hass) return;
    if (!customElements.get("ha-form")) {
      this.textContent = "Edit this card in YAML — ha-form is unavailable.";
      return;
    }
    if (this._built && !force) {
      this._syncForms();
      return;
    }
    this.innerHTML = "";
    this._built = true;

    const style = document.createElement("style");
    style.textContent = `
      .chc-ed { display: flex; flex-direction: column; gap: 14px; }
      .chc-sec-title {
        font-size: 12px; font-weight: 700; letter-spacing: .06em;
        text-transform: uppercase; color: var(--secondary-text-color);
        margin: 4px 0 -4px;
      }
      .chc-room {
        border: 1px solid var(--divider-color); border-radius: 10px;
        overflow: hidden; background: var(--secondary-background-color, transparent);
      }
      .chc-room-head {
        display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px;
      }
      .chc-room-title { flex: 1; min-width: 0; }
      .chc-room-title b { display: block; font-size: 14px; }
      .chc-room-title span {
        display: block; font-size: 12px; color: var(--secondary-text-color);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .chc-room-body { padding: 0 12px 12px; }
      .chc-ico {
        appearance: none; border: none; background: transparent; cursor: pointer;
        color: var(--secondary-text-color); border-radius: 8px;
        width: 34px; height: 34px; display: grid; place-items: center; flex: 0 0 auto;
      }
      .chc-ico:hover { background: rgba(128,128,128,.18); color: var(--primary-text-color); }
      .chc-ico:disabled { opacity: .3; cursor: not-allowed; }
      .chc-ico.danger:hover { color: var(--error-color, #e05252); }
      .chc-add {
        appearance: none; cursor: pointer; font: inherit; font-size: 14px;
        padding: 9px 14px; border-radius: 10px; align-self: flex-start;
        border: 1px dashed var(--divider-color); background: transparent;
        color: var(--primary-color); display: flex; align-items: center; gap: 6px;
      }
      .chc-add:hover { background: rgba(128,128,128,.12); }
    `;
    this.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "chc-ed";

    // ---- global options
    const gTitle = document.createElement("div");
    gTitle.className = "chc-sec-title";
    gTitle.textContent = "Card";
    wrap.appendChild(gTitle);

    const gForm = document.createElement("ha-form");
    gForm.hass = this._hass;
    gForm.schema = GLOBAL_SCHEMA;
    gForm.computeLabel = (s) => this._label(s);
    gForm.data = { ...DEFAULTS, ...this._config };
    gForm.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      this._config = { ...this._config, ...ev.detail.value };
      this._emit();
    });
    wrap.appendChild(gForm);
    this._gForm = gForm;

    // ---- rooms
    const rTitle = document.createElement("div");
    rTitle.className = "chc-sec-title";
    rTitle.textContent = `Rooms (${this._rooms.length})`;
    wrap.appendChild(rTitle);

    this._roomForms = [];
    this._roomHeads = [];
    this._rooms.forEach((room, i) => {
      wrap.appendChild(this._buildRoomEditor(room, i));
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = "chc-add";
    const plusIcon = document.createElement("ha-icon");
    plusIcon.setAttribute("icon", "mdi:plus");
    add.append(plusIcon, document.createTextNode("Add room"));
    add.addEventListener("click", () => {
      this._rooms = [...this._rooms, { room_name: "", room_temp_entity: "", target_temp_entity: "" }];
      this._open = this._rooms.length - 1;
      this._emit();
    });
    wrap.appendChild(add);

    this.appendChild(wrap);
  }

  _buildRoomEditor(room, i) {
    const box = document.createElement("div");
    box.className = "chc-room";
    box.dataset.roomIndex = String(i);

    const head = document.createElement("div");
    head.className = "chc-room-head";

    const title = document.createElement("div");
    title.className = "chc-room-title";
    const b = document.createElement("b");
    b.textContent = room.room_name || `Room ${i + 1}`;
    const sub = document.createElement("span");
    sub.textContent = room.target_temp_entity || "not configured";
    title.append(b, sub);
    this._roomHeads[i] = { name: b, sub };

    const mkIco = (ic, label, cls) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `chc-ico${cls ? " " + cls : ""}`;
      btn.title = label;
      btn.setAttribute("aria-label", label);
      const ie = document.createElement("ha-icon");
      ie.setAttribute("icon", ic);
      btn.appendChild(ie);
      return btn;
    };

    const up = mkIco("mdi:arrow-up", "Move up");
    up.disabled = i === 0;
    up.addEventListener("click", () => this._move(i, -1));

    const down = mkIco("mdi:arrow-down", "Move down");
    down.disabled = i === this._rooms.length - 1;
    down.addEventListener("click", () => this._move(i, +1));

    const isOpen = this._open === i;
    const edit = mkIco(isOpen ? "mdi:chevron-up" : "mdi:pencil", isOpen ? "Collapse" : "Edit room");
    edit.addEventListener("click", () => {
      this._open = isOpen ? -1 : i;
      this._render(true);
    });

    const del = mkIco("mdi:close", "Remove room", "danger");
    del.disabled = this._rooms.length <= 1;
    del.addEventListener("click", () => {
      this._rooms = this._rooms.filter((_, j) => j !== i);
      if (this._open >= this._rooms.length) this._open = this._rooms.length - 1;
      this._emit();
    });

    head.append(title, up, down, edit, del);
    box.appendChild(head);

    if (isOpen) {
      const body = document.createElement("div");
      body.className = "chc-room-body";
      const form = document.createElement("ha-form");
      form.hass = this._hass;
      form.schema = ROOM_SCHEMA;
      form.computeLabel = (s) => this._label(s);
      form.data = { ...room };
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._rooms = this._rooms.map((r, j) => (j === i ? { ...r, ...ev.detail.value } : r));
        this._emit();
      });
      body.appendChild(form);
      box.appendChild(body);
      this._roomForms[i] = form;
    }

    return box;
  }

  _move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this._rooms.length) return;
    const next = [...this._rooms];
    [next[i], next[j]] = [next[j], next[i]];
    this._rooms = next;
    if (this._open === i) this._open = j;
    else if (this._open === j) this._open = i;
    this._emit();
  }

  _syncForms() {
    if (this._gForm) {
      this._gForm.hass = this._hass;
      this._gForm.data = { ...DEFAULTS, ...this._config };
    }
    (this._roomForms || []).forEach((f, i) => {
      if (f) {
        f.hass = this._hass;
        f.data = { ...this._rooms[i] };
      }
    });
    // Headers echo the room name / target entity, so keep them current when
    // syncing in place rather than rebuilding.
    (this._roomHeads || []).forEach((h, i) => {
      const r = this._rooms[i];
      if (!h || !r) return;
      h.name.textContent = r.room_name || `Room ${i + 1}`;
      h.sub.textContent = r.target_temp_entity || "not configured";
    });
  }
}

/* ---------------------------------------------------------------- register */

if (!customElements.get(CARD_TYPE)) {
  customElements.define(CARD_TYPE, CleanHeatingCard);
}
if (!customElements.get(`${CARD_TYPE}-editor`)) {
  customElements.define(`${CARD_TYPE}-editor`, CleanHeatingCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Clean Heating Card",
    description: "Gas cylinder level plus one or more room heating controls.",
    preview: false,
  });
}

console.info(
  `%c CLEAN-HEATING-CARD %c v${CARD_VERSION} `,
  "background:#29b6f6;color:#0b1220;font-weight:700;border-radius:3px 0 0 3px;padding:2px 4px",
  "background:#ff1a1a;color:#fff;font-weight:700;border-radius:0 3px 3px 0;padding:2px 4px",
);

export { CleanHeatingCard };
