# 115 Local Sync Upload Safety Implementation Plan

> **For agentic workers:** Inline execution in this task; steps use checkbox syntax for review.

**Goal:** Keep local video and subtitle matching independent, reuse the remote video's parent folder, and create a numbered folder only beneath the top-level `云下载` folder.

**Architecture:** Update the standalone userscript's local-sync helpers and destination resolver. Add a Node built-in regression test that extracts and exercises those helpers without requiring a logged-in 115 browser.

**Tech Stack:** Tampermonkey userscript JavaScript; Node.js built-in `node:test` and `vm`.

## Global Constraints

- Preserve the standalone userscript and existing upload protocol.
- Never create a numbered folder at CID `0`.
- Do not treat another episode or file type as an exact match.
- Live 115 account behavior remains subject to user browser acceptance.

---

### Task 1: Correct number parsing and remote matching

**Files:**
- Modify: `K:\Downloads\ZZ\工具\视频字幕一体助手.user.js`
- Test: `tests/115-local-sync.test.cjs`

- [x] Parse numeric hyphenated numbers such as `030413-279` as one complete code.
- [x] Match existing remote files by exact normalized name and media type.
- [x] Derive a folder name from the primary video while removing a trailing episode number.

### Task 2: Enforce destination-folder policy

**Files:**
- Modify: `K:\Downloads\ZZ\工具\视频字幕一体助手.user.js`
- Test: `tests/115-local-sync.test.cjs`

- [x] Reuse a matching remote video's non-root parent CID.
- [x] Reuse a matching numbered folder already below `云下载`.
- [x] Create a numbered folder only below the top-level `云下载` directory.
- [x] Use another selected non-root directory directly; reject root CID `0` when no safe existing parent applies.

### Task 3: Verify and publish

**Files:**
- Copy verified userscript to `视频字幕一体助手.user.js` in the public repository.
- Run the Node regression test, `node --check`, `git diff --check`, and SHA-256 comparison.

- [ ] Verify source and repository copy, commit, push `main`, and confirm remote HEAD.
- [ ] Keep live authenticated 115 upload verification explicitly unclaimed.
