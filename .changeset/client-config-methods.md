---
"crontick": minor
---

Add client `configList`/`configGet`/`configSet`/`configUnset` (file-direct, best-effort daemon reload, engine-removal warning, `inFlight` option). Remove the superseded `getConfigValue`, `setConfigValue`, `removeConfigValue`, `listEngines`, `addEngine`, `updateEngine`, `removeEngine` client methods and package exports; use `configSet engines.<name> <json>` / `configUnset engines.<name>` instead.
