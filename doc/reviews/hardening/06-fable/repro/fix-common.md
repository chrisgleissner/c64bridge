# Round 6 fixes - common rules (read fully)

You are fixing findings you (or a fellow reviewer) reported. The triage, the binding decisions D1
to D10 and the list of accepted findings per work package are in
`doc/reviews/hardening/06-fable/review.md` inside your worktree. Read the Decisions section and
your work package's list.

- You work ONLY in your own git worktree (path given in your message), on its branch. Never touch
  /home/claude/c64bridge or another worktree. Never push, never open a PR, never merge.
- Stay inside your work package's files. Other agents edit the other files at the same time; a
  change outside your files causes merge conflicts. If a fix needs a change elsewhere, make the
  smallest possible change there and list it in your report, or leave that part and report it.
- `. /home/claude/env.sh` first in every shell. `node_modules` is a symlink; do not run
  `npm install`, `npm ci`, `npm run build`, or the full suites. Run single test files:
  `bun test test/<file>.test.mjs` and `node --import tsx/esm --test test/<file>.test.mjs`; both
  must pass, with assertions from `#test/assert` only.
- No real hardware, no real VICE, no `mcp__c64bridge__*` tools, loopback mocks only.
- One commit per finding (or per tightly coupled group), finding ID(s) in the body, message style
  as in `git log -5`, no attribution or co-author lines. No `git stash`, `git reset --hard`,
  `git clean`, or `rm -rf` on variable paths.
- Every fix needs a test that fails without it. Prove it once per finding: keep your fixed files in
  /tmp, restore the pre-fix production file with `git show HEAD:<file> > <file>`, see the test
  fail, put the fixed file back. Tests must be fast and bounded.
- Existing tests that asserted the old behaviour: change them only where the review's decisions
  require the new behaviour, and say so in the commit.
- Backward compatibility: existing tool, operation and parameter names keep working; new
  parameters are optional. Behaviour changes only as the decisions state. No new runtime
  dependency.
- C64 facts in code (PETSCII and screen codes, register bits, addresses, timing, opcodes): a wrong
  fact is worse than none. State in the commit body the source for each fact you rely on (name the
  reference, for example "C64 Programmer's Reference Guide, appendix E" or the existing table in
  the repository you checked it against). If you are not certain, do not encode it; report it.
- Keep new tool descriptions short: `tools/list` has a size tripwire (71,000 bytes, in
  `test/suites/mcpServerToolsSuite.mjs`). Do not edit that file; report if you expect to exceed it.
- Do not edit `README.md`, `mcp/*.json`, `doc/hardening-behavior.md` or generated files (work
  package I owns README; the lead regenerates the rest). Put user-visible behaviour changes in your
  report instead.
- If a finding does not hold on closer look or cannot be fixed within these rules, do not force it:
  report the evidence.

Report (final answer, under 700 words): per finding: status (done / skipped + reason / partial),
commit hash, test name, "failed without fix: yes/no"; files touched outside your package;
user-visible behaviour changes (one line each); C64 facts relied on with their source; anything
left for a second wave.
