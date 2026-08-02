---
"crontick": patch
---

Running `crontick` with no subcommand now prints help and exits `0` instead of
`1`. Previously the bare invocation used Commander's default "no command"
behavior (help to stderr, exit code 1), which PowerShell 7.4+ surfaces as a
noisy `NativeCommandExitException` on a purely informational invocation.
`crontick --help` and every subcommand are unchanged.
