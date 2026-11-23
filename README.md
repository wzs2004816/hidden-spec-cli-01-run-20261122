# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wzs2004816/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wzs2004816/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is a small command-line tool that applies a patch to a tree of text
files. It reads a patch in one of four formats, finds the lines each edit
names, and writes every change or none: a failed edit changes nothing, later
edits still run, and when any edit fails no file is written at all.

```
node main.ts [--format=<name>] [--check] [--strict] [--] [PATCH]
```

`PATCH` is a file, or standard input when it is omitted or `-`. The working
directory is the root of the tree. Node 22, standard library only.

## The four formats

- **unified** — a git-style diff: `diff --git` lines, `---`/`+++` headers,
  `rename from`/`rename to`, `new file mode`/`deleted file mode`, and `@@`
  hunks whose body lines start with ` ` (context), `-` (old), `+` (new), or
  `\` (the line before it has no line break). A hunk takes the occurrence of
  its old lines nearest to its `-A` line, counting the shift from hunks
  already applied in the same section; an empty old side inserts after the
  first `A` lines.
- **search-replace** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks. The path is the nearest non-blank line before the block that does
  not start with three backticks; a later block reuses the previous block's
  path when it has none of its own. An empty old side creates the file.
- **v4a** — a patch wrapped in `*** Begin Patch` / `*** End Patch`, with
  `*** Add File:`, `*** Delete File:` and `*** Update File:` sections. An
  update section may start with `*** Move to:` and holds chunks that start at
  an `@@` anchor line (or, for the first chunk, at a body line) and may end
  with `*** End of File`. Chunks are applied in order from a cursor that moves
  past what each chunk wrote; an anchor first moves the cursor past the first
  line equal to it.
- **json** — one edit object per line (JSON Lines), or a JSON array of them.
  Commands are `create` (`file_text`), `str_replace` (`old_str`, `new_str`,
  exact, no tiers, at most one occurrence) and `insert` (`insert_line`,
  `new_str`).

With `--format=auto` (the default) the format is detected from the patch:
`*** Begin Patch` first, then a leading `[` or `{`, then a `<<<<<<< SEARCH`
line, then a `diff --git` line or a `---`/`+++` pair. `--format=<name>` forces
one format.

## The three matching tiers

An edit's old lines are found at the first tier where they occur at least
once:

- **tier 0** — exact, byte for byte;
- **tier 1** — ignoring trailing spaces and tabs on both sides;
- **tier 2** — ignoring leading and trailing spaces and tabs on both sides.

`--strict` allows tier 0 only. In a unified hunk the occurrence nearest to
the hunk's line number wins (ties go to the earlier one); in a SEARCH/REPLACE
block the old lines must occur exactly once or the edit is `ambiguous`; in a
V4A chunk the first occurrence at or after the cursor wins, and an
end-of-file chunk only takes an occurrence ending at the file's last line.

At tier 2, context lines are written as the file's own matched lines, and
every other new line that is not empty, not only whitespace, and starts with
the leading whitespace of the old lines' first line has that whitespace
replaced by the leading whitespace of the file's first matched line.

## Atomicity, output and exit codes

Edits apply in patch order to the tree as earlier edits left it. Every path
an edit names is checked for safety (empty, absolute, or escaping the working
directory with `..`) before anything else about it.

- Exit **0** — one line per changed path, in byte order of the paths (UTF-8):
  `A <path>` created, `D <path>` deleted, `M <path>` modified, and
  `R <old> -> <new>` for a moved file (sorted by `<new>`), then
  `ok: <n> file` / `ok: <n> files`. A file whose bytes are unchanged is not
  listed; a patch that changes nothing prints only `ok: 0 files`.
- Exit **1** — one `error: <code> <path>` line per failed edit, in patch
  order, then `failed: <k> of <n> edits`. Nothing is written.
- Exit **2** — exactly one line, and nothing is written: `error: usage`
  (bad arguments), `error: no-patch` (the PATCH file cannot be read),
  `error: format` (the patch is none of the four formats), or
  `error: parse <line>` (the patch cannot be read; the line is 1-based).

`--check` reports what would change and writes nothing. A file keeps its own
line break (CRLF when its first line feed follows a carriage return, LF
otherwise); a file an edit creates is written with LF breaks. Standard error
is never compared.

## Trial hand-over

When `MAKEFUN_ENV_URL` is set and non-empty, `main.ts` hands over to
`runner.ts` (the trial runner, kept exactly as the kit ships it) instead of
running as the CLI. `runner.ts` is harness glue, not part of the tool.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zy5dg92r&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
