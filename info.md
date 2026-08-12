# Clean Heating Card

A single Lovelace card combining a gas cylinder gauge with room heating controls — one room, or
several stacked vertically and each independently controlled.

No dependencies: no `button-card`, no `card-mod`, no CDN, no web fonts. Uses Home Assistant's own
icons and theme variables, so it follows your theme in light and dark mode.

- Gas panel with cyan → amber → red thresholds
- Correct shared-boiler logic: a room shows `HEATING NOW` only when **its own** heating flag *and*
  the boiler are on
- `+` / `−` target stepper that respects the `input_number`'s `min` / `max`
- Per-room power and AUTO buttons
- Visual editor for adding, reordering and editing rooms
- Responsive, keyboard accessible, honours `prefers-reduced-motion`

See the [README](https://github.com/ilirdokle43/HA-clean-heating-card) for full configuration.
