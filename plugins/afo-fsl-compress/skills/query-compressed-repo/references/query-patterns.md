# Query Patterns

## Find architecture

1. `get_feature_vector`
2. `list_chunks`
3. `query_compressed` terms: `router`, `server`, `api`, `daemon`, `store`, `session`

## Find MCP behavior

1. `query_compressed` term: `mcp`
2. `query_compressed` term: `approval`
3. `query_compressed` term: `permission`
4. Decompress only likely server or integration-test chunks.

## Find adaptation candidates

1. Query for the desired domain.
2. Prefer files with implementation and test pairs.
3. Check docs and generated models for API shape.
4. Summarize what can be adapted without copying blindly.

## Find generated or low-value chunks

Use tree paths and chunk types to distinguish generated SDKs, lockfiles, docs, and source files.
