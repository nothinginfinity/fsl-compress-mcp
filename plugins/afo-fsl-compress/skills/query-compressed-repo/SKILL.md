# Query Compressed Repo

Use this skill when a user asks what is inside a compressed repo, whether something is present, where a feature lives, or what could be adapted from a repo.

## Goal

Answer repo questions using compressed index tools first and selective decompression only when necessary.

## Procedure

1. Start with `get_feature_vector` to understand repo-level signals.
2. Use `list_chunks` to inspect the tree and identify likely paths.
3. Use `query_compressed` with precise terms from the user's question.
4. Query several related terms instead of relying on one keyword.
5. Decompress only the smallest set of chunks needed to answer accurately.
6. Cite exact file paths and chunk IDs in the answer.
7. Separate confirmed findings from inferences.

## Query strategy

Use terms from these buckets:

- Architecture: `router`, `server`, `daemon`, `session`, `store`, `schema`, `api`
- MCP: `mcp`, `tool`, `approval`, `permission`, `session header`, `tool use`
- UI: `component`, `props`, `hook`, `dialog`, `table`
- Storage: `sqlite`, `d1`, `sql`, `migration`, `kv`, `r2`
- Docs: `readme`, `claude`, `skill`, `plugin`, `marketplace`

## Do not

- Do not decompress an entire large repo to answer a narrow question.
- Do not treat keyword matches as proof without checking paths and context.
- Do not overstate certainty when only metadata was inspected.
