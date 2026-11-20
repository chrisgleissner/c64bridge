# Round 6 mass review - common brief (read fully before starting)

Repository: /home/claude/c64bridge, branch `feat/hardening-5` (head 44822528). C64 Bridge is an MCP
server (TypeScript, Node 24) that lets an LLM client control and program a Commodore 64: Ultimate
hardware (C64 Ultimate, Ultimate 64, Ultimate II+) over REST and UDP streams, and the VICE emulator
over its binary monitor. The owner's bar: "super fast, hardened, free and exceptionally helpful for
controlling and programming a C64 and C64U", especially game development in assembly and C. Five
review rounds already ran; your job is to find what they missed in YOUR area, exhaustively.

## You report only
- Do not edit, create or delete anything inside /home/claude/c64bridge. No commits, no pushes.
- Scratch scripts and their outputs go under /tmp/h6/<your-area-name>/ only.
- Return your findings as the text of your final answer. Do not write a report file.
- Never contact real hardware or a real emulator: no `mcp__c64bridge__*` tools, no host names
  `c64u`, `u64`, `u2`, no non-loopback addresses. Peers are loopback mocks only
  (`scripts/mockC64Server.mjs`, `src/vice/mockServer.ts`, or small servers in your script).
- Do not run anything that allocates gigabytes or runs for minutes. Bound every experiment.
- Run `. /home/claude/env.sh` first in every shell (Node 24, hermetic test variables). TypeScript
  sources import directly: `node --import tsx/esm script.mts` or `bun script.mts` (run from the
  repository root so imports resolve; keep the script file itself under /tmp/h6/...).
- Other reviewers run at the same time. Do not run the full test suites (`npm test`, `npm run
  build`); run single files or your own scripts only. If you start a server, bind 127.0.0.1 on a
  random free port and stop it.

## Lenses (apply all four to every file in your area)
1. Security: hostile tool arguments (prompt-injected LLM), untrusted data from device/emulator/
   network, other local users/processes, secrets in results/logs, access modes
   (`C64BRIDGE_ACCESS`), unbounded memory/time, crashes that end the process.
2. Correctness: wrong results, off-by-one, wrong C64 facts (addresses, PETSCII/screen codes,
   timing, opcodes, register bits), error paths that report success, races, state left behind.
3. Performance: needless round trips to the device, sequential awaits that could be one call,
   repeated work per call (parsing, schema building, file reads), O(n^2) on large inputs, polling
   intervals and timeouts that make a tool slow, startup cost, response sizes that waste the
   client's context window.
4. Helpfulness for an LLM client: unclear or misleading descriptions and error messages, results
   that omit what the client needs next (addresses, next step), missing operations a C64 developer
   needs, inconsistent parameter names or units across sibling operations, defaults that surprise.

## Known and already settled (do not report again)
- `doc/reviews/hardening/03-fable/review.md` sections "Decisions for the owner" and "Needs
  hardware confirmation"; findings of rounds 03, 04, 05 (see the tables in
  `doc/reviews/hardening/0{4,5}-fable/review.md` and `05-fable/worklog.md`).
- Intended behaviour is described in `doc/hardening-behavior.md` and `AGENTS.md`.

## Standard of evidence
A finding counts only if you REPRODUCED it (script path + observed output) or it follows from
direct, unambiguous code reading (file:line + the exact input that triggers it). Mark each
CONFIRMED or CODE-READ. No style remarks, no speculative hardening, no "consider". For C64 facts,
state the fact you rely on and be certain of it; if unsure, mark the finding UNSURE and say what
would settle it. Prefer ten solid findings over thirty weak ones, but do not stop early: read every
file in your area.

## Report format (final answer)
For each finding: ID (<AREA>-1, ...), lens (SEC/BUG/PERF/HELP), severity (P1 exploitable, crash,
data loss or badly wrong result; P2 wrong result, real weakness or clearly wasted time; P3 minor),
location (file:line), trigger (exact arguments or input), observed vs expected, evidence, proposed
fix (one or two sentences), test idea that fails before the fix. Sort by severity. Then: files read
completely, files only skimmed, what you could not verify. Keep the report under 1,500 words;
evidence excerpts short.
