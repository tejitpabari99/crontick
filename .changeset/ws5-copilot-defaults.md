---
"crontick": patch
---

The built-in `copilot` prompt engine now works out of the box for non-interactive
runs. Its default args are `['--allow-all-tools', '-p']`, matching
`buildPromptRunCommand()` so the appended prompt text becomes the `-p` value.

Documentation now also explains the ordering rule for custom prompt-engine configs:
if an engine needs an explicit prompt-taking flag, keep that flag last in
`engine.args` and place any other non-interactive flags before it.
