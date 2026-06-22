# Approve and Commit v4readme

Use this skill when a user wants generated FSL artifacts committed back to a GitHub repo.

## Goal

Protect repo mutations with explicit approval and a clear receipt.

## Mutation tools

- `commit_v4readme_to_repo`
- Any future tool that writes to GitHub, R2, D1, KV, or published artifacts

## Approval checklist

Before committing, present:

- target owner/repo
- branch
- source repo sha used for generation
- artifact names
- summary of generated content
- whether existing files will be created or overwritten
- commit message
- rollback note

Ask for explicit approval unless the user already gave direct instruction to commit.

## Procedure

1. Verify the generated v4readme exists with `get_v4readme`.
2. Prepare a concise mutation summary.
3. Request approval if approval has not already been granted.
4. After approval, call `commit_v4readme_to_repo`.
5. Report commit result and any returned URL or sha.
6. Store or print a receipt containing the mutation details.

## Do not

- Do not commit just because generation succeeded.
- Do not write to the wrong branch.
- Do not overwrite manually edited docs without warning.
- Do not omit the source sha.
