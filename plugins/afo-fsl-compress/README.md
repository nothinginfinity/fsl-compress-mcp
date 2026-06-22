# AFO FSL Compress Skill Pack

This skill pack teaches agents how to use the AFO FSL Compress MCP as a repo intelligence operating system.

The pack is intentionally workflow-first. It does not replace the MCP tools; it tells agents when to use each tool, how to recover when a batch is blocked, how to verify an index, and when a repo mutation requires explicit approval.

## Included skills

- `compress-large-repo` — compress a GitHub repo from offset 0 through completion and verify the index.
- `recover-failed-offset` — resume safely when a batch is blocked, partial, or failed.
- `query-compressed-repo` — inspect a compressed repo using cheap index-first operations before selective decompression.
- `generate-v4readme` — produce a repo operating manual from the compressed index.
- `approve-and-commit-v4readme` — gate repo mutations behind explicit approval before committing generated artifacts.

## Operating principles

1. Prefer compressed inspection before full decompression.
2. Preserve `owner`, `repo`, `branch`, `sha`, `job_id`, `offset`, and `next_offset` in every handoff.
3. Treat `done: true` plus `list_chunks` verification as the minimum success condition.
4. Lower batch size when a compression batch is blocked.
5. Never commit generated files unless the user explicitly approves the mutation.
6. Leave receipts for actions that mutate GitHub, D1, R2, KV, or a published repo artifact.

## Tool family

See `references/tool-map.yml`.
