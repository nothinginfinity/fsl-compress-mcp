# Recover Failed Offset

Use this skill when compression is blocked, partially complete, interrupted, or returns a failed tool call for a specific offset.

## Goal

Resume compression without losing progress and without duplicating already indexed chunks.

## Required state

- owner
- repo
- branch
- last successful `next_offset`
- failed offset, if different
- last successful `job_id`, if available
- last seen `sha`, if available

## Procedure

1. Keep the same owner, repo, and branch.
2. Retry the failed offset with a lower `max_files`.
3. If the retry succeeds, continue from the returned `next_offset`.
4. If the retry fails, keep reducing `max_files`.
5. If `max_files: 1` fails, report the isolated offset and do not fabricate completion.
6. When compression finishes, verify with `list_chunks`.
7. Summarize the recovery path in the final report.

## Recovery language

Say exactly what happened:

- "The original batch was blocked at offset N."
- "I retried with max_files M."
- "Compression resumed and completed at next_offset K."
- "One file could not be indexed" only if a single-file retry fails.

## Do not

- Do not hide safety/tool blocks.
- Do not skip already indexed chunks manually unless the tool requires it.
- Do not use a different branch during recovery.
- Do not change target repo mid-run.
