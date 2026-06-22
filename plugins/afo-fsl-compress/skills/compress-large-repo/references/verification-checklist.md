# Compression Verification Checklist

Use this checklist before reporting completion.

- `compress_repo.ok` is true.
- `compress_repo.done` is true.
- Final `next_offset` is recorded.
- Final `sha` is recorded.
- `files_found` is recorded.
- `total_chunks_indexed` is recorded.
- `orig_bytes` and `compressed_bytes` are recorded.
- `ratio` is recorded.
- `list_chunks.ok` is true.
- `list_chunks.total_files` is plausible for the repo.
- `get_feature_vector.ok` is true when available.
- Any blocked offsets or reduced batch sizes are disclosed.
