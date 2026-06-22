# Compress Large Repo

Use this skill when a user asks to compress or index a GitHub repository with AFO FSL Compress.

## Goal

Create a durable compressed index for the requested repo and verify that the index can be queried after compression.

## Required inputs

- GitHub owner
- GitHub repo
- Branch, default `main` unless the user provided another branch

## Procedure

1. Call `compress_repo` with `owner`, `repo`, `branch`, `offset: 0`, and a reasonable `max_files`.
2. Preserve the returned `job_id`, `sha`, `files_found`, `next_offset`, `done`, `total_chunks_indexed`, `orig_bytes`, `compressed_bytes`, and `ratio`.
3. If `done` is false, call `compress_repo` again with the same `owner`, `repo`, `branch`, and the returned `next_offset`.
4. Continue until `done: true`.
5. Verify the completed index with `list_chunks`.
6. Get a repo-level summary with `get_feature_vector`.
7. Report the final repo, branch, sha, files found, chunks indexed, source bytes, compressed bytes, ratio, and whether verification succeeded.

## Batch sizing

Start with a larger batch for small repos. For large repos, prefer controlled batches and follow `next_offset`.

If a batch is blocked or fails, switch to the `recover-failed-offset` skill.

## Success condition

The run is complete only when:

- `compress_repo` returns `ok: true`
- `done: true`
- `list_chunks` returns `ok: true`
- `list_chunks.total_files` is consistent with the final indexed total
- the final answer includes the compression ratio and indexed chunk count

## Do not

- Do not restart from offset 0 after partial progress unless the user asks for a rebuild.
- Do not skip verification.
- Do not claim the repo is fully indexed if `done` is false.
- Do not commit generated artifacts as part of compression. Use the approval skill for mutation.
