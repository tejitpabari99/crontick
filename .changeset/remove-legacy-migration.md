---
"crontick": patch
---

Remove pre-production migration, legacy, and back-compatibility code: fold all columns and the alias-uniqueness index directly into the base SQLite schema (no `ALTER TABLE` upgrades), drop on-disk job-file migration, and remove the `coerceLegacyIdToAlias` shim and its public export.
