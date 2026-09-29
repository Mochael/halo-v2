# Halo search

## Goal

Add literal, case-insensitive search in the active text file or conversation, and across saved workspace files and sessions. PDF and Office content is excluded. Search results must point to content Halo can open.

## Phases

1. **Active tab:** `CmdOrCtrl+F` opens a find bar scoped to the active text editor or visible user/assistant conversation. It reads unsaved editor state and streaming assistant text, counts matches, selects next/previous, and closes with Escape. Media previews do not offer content search.
2. **Workspace server:** a bounded RPC scans saved, previewable UTF-8 files (up to 5 MiB) and pages stored session messages. Literal case-insensitive matching returns bounded snippets and target locations. No persistent index or browser-side transcript download.
3. **Global UI:** `CmdOrCtrl+Shift+F` opens a search panel. It debounces input by about 300 ms and aborts stale requests. Results include filename/session title hits and open the target at its match.

## Current implementation

Active-tab find is implemented for text, Markdown, code, and visible session messages. The workspace server RPC and global UI remain planned in the following stack layers.

## Decisions

- Search case-folds with JavaScript `toLocaleLowerCase` on both sides and treats the query as literal text.
- Files follow the workspace navigator's hidden-directory and `node_modules` exclusions. PDF, Office, and binary media are omitted entirely. Oversized text files are counted as skipped.
- Saved session entries are read in pages from the existing database connection. Only user display text and assistant `text` parts are searched; tool calls, tool results, thinking, and bash execution are excluded.
- Results and snippets are capped by the server to bound response size.
