Tether 1.0.14 prevents duplicate Google Drive folders and safely consolidates duplicates that already exist.

## What changed

- Prevented concurrent sync workers from creating multiple Drive folders for the same vault path, including case-only name differences.
- Made folder creation retry-safe by reserving a Drive file ID and reusing it after timeouts, API retries, access-token refreshes, and internal Drive-client replacements.
- Added automatic recursive repair for duplicate vault folders and duplicate nested folders. Tether chooses one deterministic folder, moves every reachable item into it, and updates local sync-state references.
- Preserved differing same-name files with a unique `Tether conflict` filename instead of overwriting either copy.
- Moved byte-identical duplicate files to Google Drive Trash.
- Moved duplicate folders to Trash only after a fresh Drive check confirms they are empty. File/folder type collisions stop the repair instead of risking data loss.
- Serialized sync-state saves so overlapping workers cannot let an older snapshot overwrite newer folder mappings.
- Added Drive-side conflict diagnostics and refreshed the documented sync behavior.

## Safety

- Folder repair moves existing Drive items without changing their file IDs.
- Duplicate cleanup uses recoverable Drive Trash rather than permanent deletion.
- Repair saves corrected state before renaming or trashing items, is safe to resume after interruption, and honors Stop Sync checks between mutations.
- Differing content is never silently folded into another file or discarded.

## Validation

- Added six regression tests covering concurrent folder creation, recursive folder merging, conflict preservation and rediscovery, retry reconciliation, timeout reservations across replacement clients, and serialized state writes.
- All six regression tests pass.
- The production Obsidian bundle builds successfully.
- GitHub Actions rebuilds and attests `main.js`, `manifest.json`, and `styles.css` before publishing them.

## Upgrade note

After updating, run a Pull or Push. Tether will consolidate duplicate Drive folders it encounters while preserving any differing same-name files.

**Full changelog:** https://github.com/Llewellyn500/obsidian-tether/compare/1.0.13...1.0.14
