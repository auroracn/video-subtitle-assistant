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
- [x] Keep live authenticated 115 upload verification explicitly unclaimed.

### Task 4: Cover the screenshot's cloud-download parent and the actual sync action

**Files:** Modify `视频字幕一体助手.user.js`, `tests/115-local-sync.test.cjs`, and `README.md`.

**Interfaces:** `resolve115LocalSyncFolder(code, records, remoteItems, targetCid)` returns a safe destination CID. `find115TopLevelCloudDownloadFolder(cid)` returns the root's actual cloud-download folder, optionally selecting it by CID. The local sync action accepts an empty target field for automatic resolution.

- [x] Add and run regression tests through the actual sync action: two remote WMVs directly in cloud downloads and two missing local SRTs must create one numbered child and upload both subtitles; a video with an existing ordinary parent must upload the subtitle there without requiring a target CID.
- [x] Correct the resolver with the following destination selection before its existing numbered-folder reuse/create branch:

```javascript
const existingVideoCid = find115LocalSyncVideoFolder(remoteItems, records, code)
const parentCid = existingVideoCid || String(targetCid || '').trim()
if (parentCid && (!/^\d+$/.test(parentCid) || parentCid === '0')) {
    throw new Error('目标CID不能是115根目录；请选择“云下载”或其他已有目录')
}
const targetFolder = await find115TopLevelCloudDownloadFolder(parentCid)
if (existingVideoCid && !targetFolder) return existingVideoCid
```

- [x] Allow an empty CID in the top-level cloud-download lookup by changing its ID predicate to `(!cid || String(item.folderCid) === String(cid))`. After the cloud-download branch, reject an empty resolved parent with `throw new Error('没有找到115根目录下的“云下载”文件夹，请选择其他已有目录CID')`; otherwise verify and reuse that non-root parent.
- [x] Let the sync action reject only explicit invalid/root CIDs with `if (targetCid && (!/^\d+$/.test(targetCid) || targetCid === '0'))`. Persist the field when cleared, keep root CID invalid, and describe automatic existing-parent/cloud-download selection in its field help and README.
- [x] Run `node --test tests/115-local-sync.test.cjs` and `node --check 视频字幕一体助手.user.js`; all 14 regression tests and syntax checks passed. The upload API is mocked; this verifies routing and guards, not authenticated ingestion. No create request targets root or a nested folder called cloud downloads. Source/repository SHA-256 equality and `git diff --check` also passed.
- [ ] Synchronize the verified source and repository copy, verify SHA-256 equality and `git diff --check`, commit, and push `main`. Use per-command `git -c http.proxy= -c http.https://github.com.proxy=` for the unreachable local proxy; do not change global Git settings. Confirm the remote SHA equals local HEAD. Live authenticated upload remains unverified.
