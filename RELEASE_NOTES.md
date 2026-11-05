Tether 1.0.17 preserves the writing layout of notes annotated with Handwriting by Alan, helping phone handwriting stay beside the correct paragraphs when opened in the desktop editor.

## What changed

- Handwritten notes use the text width and font size recorded by the largest group of anchored strokes. These notes may have a narrower text column on desktop.
- Layout support follows open notes, checks for ink sidecar updates, and removes its styles when Tether is disabled.
- Custom ink folders configured in Handwriting are supported.
- Original stroke coordinates and note content are left unchanged. The hidden `.handwriting` folder continues to sync with the vault.

## Limitations

- This workaround covers the Markdown editor. Handwriting's separate Reading view renderer is not covered.
- Mixed writing layouts, different fonts or themes, and older ink without line anchors may still need adjustment.
- Desktop alignment was visually checked against the reported note. A fresh physical phone-to-PC sync has not been verified.

## Validation

- All 11 regression tests pass, including handwriting layout selection and byte-preserving transfer of hidden ink files.
- The production plugin bundle builds successfully.

**Full changelog:** https://github.com/Llewellyn500/obsidian-tether/compare/1.0.16...1.0.17
