# How AI was used

AI coding agents wrote almost all of the code, tests and docs in this repository. A human set the
goals, the scope and the fixed decisions (stack, privacy rule, availability definition, what
"today" means) and approved merges. The interesting part is not that agents wrote code; it is the
process that caught them when they were wrong.

## The process

- **Requirements first.** Every requirement and every data trap found by profiling the source data
  got an ID and a pass/fail done check before any code was written. Agents built against those
  checks, not against a vague goal.
- **Test-first pairs.** For each milestone a QA agent wrote failing tests and hand-made fixtures
  (invented names and addresses that mimic each source's shape) and committed them. A separate BE
  agent made them pass and was not allowed to edit the tests; if a test looked wrong, it had to
  stop and ask. This stops the most common agent failure, quietly weakening a test until it
  passes.
- **Fresh validators.** After each milestone a new agent with no shared context checked the branch
  against the requirements only: it ran the gate, ran setup on the real data, wrote its own SQL
  and its own MCP client, and reported each requirement as met, partial or not met with evidence.
  Validators never saw the builders' notes, so they couldn't inherit their assumptions.
- **Independent expected answers.** The six benchmark answers in `eval/expected/` were derived from
  the raw source files by an agent that never read the implementation, with a recorded derivation
  and tolerance for each. The eval then compares the two.
- **A decisions log.** Every agent appended each design choice, the alternatives and the tradeoff.
  The project lead cross-checked merges against it, which is how several of the problems below
  surfaced.

## Where AI output was wrong, and how it was caught

**1. The history search counted the right number of jobs but cited the wrong records.** The Q1
tool's per-trade totals looked right, but the eval's job-ID recall (how many of the expected job
IDs appear in the answer) was 623 of 988. Two separate mistakes: for jobs with several visits, the
tool cited only the visit IDs, while the counted unit was the job, whose own ID never appeared;
and it converted half a mile to 804.672 m exactly, while the requirements fix the radius at
804.7 m, which dropped one job sitting at 804.70 m. **Caught by the eval.** The fix cites the
parent job next to its visits and rounds the radius to 0.1 m: 1,007 of 1,007 jobs and 988 of 988
IDs.

**2. Visits had no parent.** The source nests visits under jobs, and the adapter emitted each
visit with a pointer to its parent job, but never emitted the parent itself. The pointer led
nowhere, so "one job with many visits" was only grouped by a string key in a view. The unit tests
passed because they checked the visits, not the parent. **Caught by a fresh validator** querying
the canonical tables directly. The fix emits each parent as its own record, so all visits now link
to a real parent row with its own provenance.

**3. Fixing the parents broke the citations from fix 1.** The two fixes were built on separate
branches. The citation fix parsed the old string key to find the parent's record; the parent fix
removed that key. Each branch passed its own tests. **Caught by a cross-check** of the merged
result against the decisions log before merging to main: the parent citations had silently
disappeared. The citation code was rewritten to read the canonical parent's own sources.

**4. The adapter dropped the link from estimate to job.** One CRM records which approved estimate
a job came from. The adapter didn't carry that field, so the estimate and the job it became would
have counted as two separate pieces of work. **Caught by a validator** checking the trap's done
check against the real data. After the fix, 178 estimates fold into the jobs created from them.

**5. Facts computed correctly, then thrown away.** Three gap fixes worked in isolation: a
calendar's `TENTATIVE` status, a profile's "24/7" hours flag and a "rescheduled from" date were all
parsed correctly by the adapters and handled correctly by the availability engine's unit tests.
None of them was ever written to the canonical tables, so the server, which reads only the views,
couldn't see them: a tentative hold looked confirmed, and a 24/7 profile read as open around the clock, which would
offer openings at 3 a.m.
**Caught by a validator** that traced each fact from source file to tool output instead of
trusting unit tests. A follow-up pair persisted them and pinned the behaviour end to end.

**6. The eval passed while a live agent would have choked.** The first history search returned
every matching job with all of its citations: about 946 KB for the benchmark address. The
scripted eval read that JSON without complaint and scored Q1 as a pass, because nothing checked
how big the answer was. **Caught by a fresh validator** that called the tool the way an agent
client would and saw the response was far past what one turn can read. The fix answers with
per-trade counts, 3 samples per trade and a paged job list (about 41 KB by default), and the eval
now fails a default answer over 50 KB and pages the full list to keep checking every job ID.

## What we took from it

Agents are good at making the test in front of them pass and weak at noticing what no test asks
about: a field nobody reads yet, a fact that stops one layer short of the output, two correct
branches that conflict. Every catch above came from a check outside the builder's own loop:
independent expected answers, a validator with no shared context, or a cross-check at merge time.
