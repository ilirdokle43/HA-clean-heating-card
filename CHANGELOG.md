# Changelog

## 1.2.0

- New `gas_label` option, defaulting to `Gas`. The gas panel label was previously hardcoded,
  so it could not be translated. Set `gas_label` to keep a different word.
- README screenshots.

## 1.1.3

- Increase the optical offset of the flame glyph to `-3px` and expose it as
  `--chc-flame-nudge`. The `mdi:fire` path is symmetric in its viewBox, but the glyph is
  bottom-heavy and tapers to a point, so a geometrically centred flame reads as low.

## 1.1.2

- Multi-room rows: top-align the flame with the room name / temperature group instead of
  centring it against the whole row height. Controls stay vertically centred.

## 1.1.1

- **Fix:** with a shared `boiler_entity`, every room showed `HEATING NOW` as soon as the boiler
  fired. The boiler was tested before the room's own `heating_entity` and returned early. A room
  is now active only when its own heating flag *and* the boiler are on.

## 1.1.0

- Multi-room support via a `rooms:` list, rendered as a vertical stack sharing one gas panel.
- Visual editor: add, reorder, expand-to-edit and remove rooms.
- The flat single-room config remains supported and renders unchanged.
- **Fix:** the editor rendered no rooms when Home Assistant set `hass` before `setConfig`.

## 1.0.0

- Initial release: gas cylinder panel, room temperature and target, `+` / `−` stepper,
  power and AUTO controls, responsive layout, visual editor.
