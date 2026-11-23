# mend

mend is a command-line tool that applies text-file patches atomically. It accepts unified diffs, SEARCH/REPLACE blocks,
V4A patches, and JSON edit commands.

Run `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`. Omit `PATCH` or use `-` to read the patch from
standard input. `--format` accepts `auto`, `unified`, `search-replace`, `v4a`, or `json`; `auto` is the default.
`--check` reports changes without writing them, and `--strict` allows only exact line matches.

mend was built by an AI agent for make.fun.
