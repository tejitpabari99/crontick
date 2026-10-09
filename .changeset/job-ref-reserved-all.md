---
"crontick": minor
---

Job id-or-alias lookup now lives in one shared resolver. The alias `all` is reserved (it is the `jobs delete all` keyword) and is rejected on create, update and import.
