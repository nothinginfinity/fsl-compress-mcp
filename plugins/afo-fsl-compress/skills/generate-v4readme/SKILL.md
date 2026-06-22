# Generate v4readme

Use this skill after a repo has been compressed and verified.

## Goal

Generate a compact repo operating manual from the FSL compressed index.

## Procedure

1. Confirm the repo has an index with `list_chunks`.
2. Inspect `get_feature_vector`.
3. Query likely architecture terms.
4. Call `generate_v4readme`.
5. Read the generated artifact with `get_v4readme`.
6. Report what was generated and where it should be committed.
7. Do not commit it unless the user explicitly approves.

## Recommended v4readme sections

- Repo identity
- Compression stats
- Top-level tree map
- Important paths
- Entry points
- Runtime and deployment notes
- Storage and schema notes
- API or MCP surface
- Test strategy
- Security-sensitive areas
- Suggested future query terms
- Known limitations of the compressed view

## Do not

- Do not generate a v4readme before compression verification.
- Do not commit generated output automatically.
- Do not claim the v4readme is source-of-truth; it is an operating manual derived from the compressed index.
