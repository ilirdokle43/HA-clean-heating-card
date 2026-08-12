# Clean Heating Card

[![hacs][hacs-badge]][hacs-url]
[![release][release-badge]][release-url]
[![license][license-badge]](LICENSE)

A single Lovelace card that combines a **gas cylinder gauge** with **room heating controls** —
one room or several, stacked vertically and each independently controlled.

Built for radiator setups where a shared central boiler serves rooms that each have their own
heating flag, target temperature and automation.

## Why

Most heating dashboards either bury each room in its own card or lean on `custom:button-card`
plus `card-mod` to look decent. This card has **no dependencies at all** — no button-card, no
card-mod, no CDN, no web fonts. It uses Home Assistant's own `<ha-icon>` and theme variables, so
it inherits your theme in both light and dark mode.

## Features

- **Gas cylinder panel** — percentage, thin progress bar, cyan → amber → red thresholds, clamped
  to 0–100%, shows `—` instead of `NaN` when the sensor is unavailable.
- **Per-room heating state** with a correct shared-boiler model (see [State logic](#state-logic)).
- **Target temperature stepper** — `+` / `−` respect the `input_number`'s own `min` / `max`, never
  display an optimistic value, and accumulate correctly under rapid presses.
- **Heating power button** and an **AUTO toggle** per room.
- **One or many rooms** — a single compact card, or a vertical list sharing one gas panel.
- **Visual editor** — add, reorder, edit and remove rooms without touching YAML.
- Responsive down to very narrow columns via container queries; touch-friendly targets;
  keyboard accessible; respects `prefers-reduced-motion`.

## Installation

### HACS (recommended)

This is not yet in the HACS default store, so add it as a custom repository:

1. HACS → **Frontend** → ⋮ → **Custom repositories**
2. Repository: `https://github.com/ilirdokle43/clean-heating-card`
3. Category: **Lovelace**
4. **Add**, then install **Clean Heating Card**
5. Hard-refresh your browser (`Ctrl` + `Shift` + `R`)

### Manual

1. Copy `clean-heating-card.js` into `<config>/www/custom-lovelace/`
2. Settings → Dashboards → ⋮ → **Resources** → **Add resource**
   - URL: `/local/custom-lovelace/clean-heating-card.js`
   - Type: **JavaScript module**
3. Hard-refresh your browser

## Configuration

### Single room

```yaml
type: custom:clean-heating-card
room_name: Jora
gas_entity: sensor.gas_cylinder_percent
heating_entity: input_boolean.heating_jora
room_temp_entity: sensor.jora_temperature
target_temp_entity: input_number.jora_target
boiler_entity: light.boiler
automation_entity: automation.jora_thermostat
script_entity: script.jora_toggle
temp_override_entity: input_boolean.jora_temp_mode
```

### Several rooms

Rooms stack vertically and share one gas panel.

```yaml
type: custom:clean-heating-card
gas_entity: sensor.gas_cylinder_percent
temperature_step: 0.5
gas_warning: 25
gas_critical: 15
rooms:
  - room_name: Jora
    heating_entity: input_boolean.heating_jora
    room_temp_entity: sensor.jora_temperature
    target_temp_entity: input_number.jora_target
    boiler_entity: light.boiler
    automation_entity: automation.jora_thermostat
    script_entity: script.jora_toggle
    temp_override_entity: input_boolean.jora_temp_mode
  - room_name: Nio
    heating_entity: input_boolean.heating_nio
    room_temp_entity: sensor.nio_temperature
    target_temp_entity: input_number.nio_target
    boiler_entity: light.boiler
    automation_entity: automation.nio_thermostat
    script_entity: script.nio_toggle
    temp_override_entity: input_boolean.nio_temp_mode
```

### Options

Card-level:

| Option             | Type   | Default   | Description                                             |
| ------------------ | ------ | --------- | ------------------------------------------------------- |
| `gas_entity`       | string | —         | Gas cylinder percentage sensor. Omit to hide the panel. |
| `gas_warning`      | number | `25`      | At or below this %, the gas readout turns amber.        |
| `gas_critical`     | number | `15`      | At or below this %, it turns red.                       |
| `temperature_step` | number | `0.5`     | Degrees added or removed per `+` / `−` press.           |
| `show_name`        | bool   | `true`    | Show room names.                                        |
| `rooms`            | list   | —         | One entry per room. Omit for the flat single-room form. |
| `tap_action`       | action | more-info | Standard Home Assistant action config.                  |

Per room (top level when using the single-room form, otherwise inside `rooms:`):

| Option                 | Type   | Required | Description                                    |
| ---------------------- | ------ | -------- | ---------------------------------------------- |
| `room_name`            | string | no       | Falls back to a friendly name.                 |
| `room_temp_entity`     | string | **yes**  | Current room temperature sensor.               |
| `target_temp_entity`   | string | **yes**  | `input_number` holding the target temperature. |
| `heating_entity`       | string | no       | Whether this room is calling for heat.         |
| `boiler_entity`        | string | no       | Shared boiler. May also be set at card level.  |
| `temp_override_entity` | string | no       | Thermostat / temperature mode flag.            |
| `script_entity`        | string | no       | Script the power button runs.                  |
| `automation_entity`    | string | no       | Automation the AUTO button toggles.            |

Any per-room entity you omit simply hides its control.

## State logic

The room's own `heating_entity` is authoritative. A shared boiler says the burner is running for
*someone* — not for whom — so on its own it never marks a room as heating. It only upgrades a room
that is already enabled:

| `heating_entity` | `boiler_entity` | Shown             |
| ---------------- | --------------- | ----------------- |
| `off`            | `off`           | `OFF`             |
| `off`            | `on`            | `OFF`             |
| `on`             | `off`           | `HEATING ENABLED` |
| `on`             | `on`            | `HEATING NOW`     |

`temp_override_entity` is only consulted once the room is known not to be enabled, and shows
`TEMPERATURE MODE`. If a room has no `heating_entity` configured, the boiler stands in for it.

## Service calls

The card calls only these, and only ever with the entities of the room you pressed:

| Control   | Call                                                                        |
| --------- | --------------------------------------------------------------------------- |
| Power     | `script.turn_on` on `script_entity` with `data: {variables: {mode: manual}}` |
| AUTO      | `automation.toggle` on `automation_entity`                                  |
| `+` / `−` | `input_number.set_value` on `target_temp_entity`                            |

## Theming

Every colour falls back to a sensible default but can be overridden:

| Variable            | Default   | Used for                          |
| ------------------- | --------- | --------------------------------- |
| `--chc-gas`         | `#29b6f6` | Normal gas level                  |
| `--chc-gas-warn`    | `#ffb300` | Gas at or below `gas_warning`     |
| `--chc-gas-crit`    | `#e53935` | Gas at or below `gas_critical`    |
| `--chc-active`      | `#ff1a1a` | Room actively heating             |
| `--chc-enabled`     | `#ffa726` | Room enabled, boiler not firing   |
| `--chc-override`    | `#27d1f6` | Temperature mode                  |
| `--chc-auto-on`     | `#1db954` | AUTO enabled                      |
| `--chc-auto-off`    | `#e05252` | AUTO disabled                     |
| `--chc-flame-nudge` | `-3px`    | Optical offset of the flame glyph |

## Licence

MIT — see [LICENSE](LICENSE).

[hacs-badge]: https://img.shields.io/badge/HACS-Custom-41BDF5.svg
[hacs-url]: https://github.com/hacs/integration
[release-badge]: https://img.shields.io/github/v/release/ilirdokle43/clean-heating-card
[release-url]: https://github.com/ilirdokle43/clean-heating-card/releases
[license-badge]: https://img.shields.io/github/license/ilirdokle43/clean-heating-card
