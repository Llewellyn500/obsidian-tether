Tether 1.0.16 makes Push mirror the real local vault structure to Google Drive, including cleanup of older cloud items that were missing from local sync state.

## What changed

- Push now inventories the complete Drive vault instead of checking only paths recorded in `.obsidian/gdrive-sync.json`.
- Cloud files and folders that no longer exist locally are removed even when they were never tracked, fixing stale folders after a vault restructure.
- Unchanged local files are verified against the expected Drive path so missing or moved remote copies are recreated correctly.
- Stale cloud branches are removed only after local uploads finish successfully.
- Deleting a stale folder uses one Drive operation for the folder branch instead of issuing redundant requests for every descendant.

## Safety

- An empty local vault scan never triggers remote deletion.
- A manual push asks for confirmation when 80% or more of existing Drive items would be deleted, allowing an intentional full restructure to proceed.
- Background push pauses large deletion batches instead of confirming them automatically.
- Remote cleanup is skipped when any local upload fails.
- Existing exclusions such as `.git`, `.codex-worktrees`, `node_modules`, build folders, partial downloads, and Tether's sync-state file remain protected.

## Validation

- Added regression coverage for untracked stale Drive folders and complete local restructures.
- All nine sync regression tests pass.
- The production Obsidian bundle builds successfully.
- GitHub Actions rebuilds and attests `main.js`, `manifest.json`, and `styles.css` before publishing them.

**Full changelog:** https://github.com/Llewellyn500/obsidian-tether/compare/1.0.15...1.0.16
