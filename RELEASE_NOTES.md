Tether 1.0.15 prevents mobile crashes while pulling large vault updates and media files.

## What changed

- Large files on mobile are downloaded in 2 MB byte ranges instead of loading the entire file into Obsidian's WebView memory.
- Chunked downloads are assembled in an excluded `.tether-part` file and moved into place only after the complete file arrives.
- Completed chunked files are saved to sync state immediately so an interrupted pull does not repeat expensive work.
- Older Obsidian versions without binary append support defer large files safely instead of risking an app crash.
- Mobile pulls yield to the app more frequently, render status less often, and reduce full sync-state rewrites.
- Completed Drive folder listings and download buffers are released earlier, and pull deletion tracking no longer keeps a second copy of every remote path.
- `.codex-worktrees` and incomplete `.tether-part` files are excluded from synchronization.

## Safety

- Downloads remain sequential on mobile, keeping only one 2 MB response chunk in active plugin memory at a time.
- Existing destination files stay intact until a replacement has downloaded completely.
- Google Drive must return the exact requested byte range; unexpected or incomplete responses fail safely.
- The existing duplicate-folder prevention and repair behavior from 1.0.14 remains included.

## Validation

- Confirmed the fix on the affected mobile pull containing a large `.mov` attachment.
- Added regression coverage for Google Drive byte-range requests.
- All seven sync regression tests pass.
- The production Obsidian bundle builds successfully.
- GitHub Actions rebuilds and attests `main.js`, `manifest.json`, and `styles.css` before publishing them.

**Full changelog:** https://github.com/Llewellyn500/obsidian-tether/compare/1.0.14...1.0.15
