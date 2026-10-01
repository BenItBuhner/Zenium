---
subagentId: bc-2ada03c6-da33-5bea-a37f-ccdfcc8a8797
pr: 755
branch: cursor/android-agent-prompts-9271
base: main
stackedOn: 745
---

# W6-S27-b — Android: file chooser, client certificate, downloads' Save As and print through `agentPrompts`

PR: https://github.com/BenItBuhner/Zenium/pull/755 (draft, base `main`).

The task said to stack on `cursor/mcp-native-prompts-5c87` (#745). #745 merged to `main` while this
was being built and its branch was deleted, so the PR is opened against `main` with `main` merged in
(merge commits `a5c0703d6` and, after #743/#752 landed, `9c5c8cafc`; no rebase). Everything here sits
on top of #745's `AgentService.takesPrompt`,
`routePrompt`, the `AgentPromptQueue` (2-minute TTL, expiry takes the default action) and the
`nativePrompts.ts` specs; nothing in that machinery was changed.

Related store report (not edited here): `internal/mcp-reliability/native-prompts-report.md`.

## Status

Built, tested locally, draft PR open and green on GitHub Actions (see `## READY`).

- #743's `agentDriven` flag landed on `main` while this was open and is merged in. It is **not**
  reused: the core has two distinct hooks with different lifetimes. `TabView.setAgentDriven` is said
  before each action only while the tab is hidden and Kotlin clears it on every show (a tab brought in
  front is the user's again); `TabView.interceptAgentPrompts` is on from the session's `prepare()` to
  its `detach()` and the core decides per request with `takesPrompt`. So `TabWebView` keeps both
  booleans, `agentDriven` (beforeunload) and `interceptsAgentPrompts` (this PR), each set by its own
  `view.*` command, matching the core's contract one to one.
- Nothing an agent answers is remembered for the user: no `rememberedCertificates` entry, no
  download-folder change, no file-chooser memory.
- No OS UI is shown over an agent-driven tab for any routed kind. The system UI only appears when the
  agent answers `user` (hand to the user) or the agent is not driving the tab.

## What routes where

Kotlin only asks the core when `TabWebView.interceptsAgentPrompts` is on; the core (`AgentService`)
decides with `takesPrompt(tabId, kind)` and otherwise falls through to the user's path exactly as
before. Default on 2-minute expiry comes from `nativePrompts.ts` and is unchanged.

| Prompt                                   | Kotlin hook                                                                               | Bridge                                                                                                                                                              | Core                                                                                                                            | Agent answer → Kotlin                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File chooser (`<input type=file>`)       | `TabWebView.onShowFileChooser` holds the `ValueCallback` as `HeldFileChooser(fc_N)`       | view event `fileChooser {requestId, multiple, accept}` → `AndroidTabView.onFileChooser` → `events.onFileChooser(fileChooserSpec)`                                   | `fileChooserSpec` (default **cancel**)                                                                                          | `view.fileChooserAnswer`: `files` → inline bytes only, written to `cache/agent-uploads/u-<now>-<hex>/<i>/<name>` and handed back as `FileProvider` URIs (`<pkg>.files`, new `cache-path agent-uploads`); an answer naming a path is refused whole (cancel + notice to the agent, nothing of it reaches Kotlin); `cancel` → `onReceiveValue(null)`; `user` → `BrowserActivity.showFileChooser` (system picker)                                                                                                                            |
| `setInputFiles`                          | —                                                                                         | `AndroidTabView.setInputFiles(selector, files)` → `executeJavaScript(setInputFilesScript)`                                                                          | —                                                                                                                               | Builds a `DataTransfer` of `File`s from inline bytes in the page (document and same-origin frames), sets `input.files`, fires `input`/`change`. Path files are refused with an error (the page cannot read device paths).                                                                                                                                                                                                                       |
| Client certificate                       | `TabWebView.onReceivedClientCertRequest` → `Security.onClientCertRequest(tab, request)`   | host event `certificate.request {requestId, tabId, host, port, certificates[]}` → `platform.ts` → `browser.security.clientCertificate(host, certificates, tabId)`   | `clientCertificateSpec` (default **none**); `SecurityPrompts.clientCertificate` returns `null` for an empty list before routing | `certificate.respond`: `{index}` → `request.proceed(key, chain)` with `key = null` so nothing is remembered; `{index: null}` → `request.cancel()`; `{user: true}` → `KeyChain.choosePrivateKeyAlias` as before. Empty candidate list → `request.cancel()` + `AgentService.refuseClientCertificate` pushes a notice to the driver. Remembered user picks for the same host still win first (that is user memory, applied to the user's tab too). |
| Download: ask where to save              | `Downloads.announce` now carries `saveAs` (true when Kotlin would open the Save As sheet) | `download.started` → `platform.ts bind()`: if `downloadAsksWhere(settings, saveAs)` and the agent takes `download` → `browser.agents.downloadDestination(tabId, …)` | `downloadSpec` (default **save** with the suggested name)                                                                       | `download.bind` with `destination.agent = {filename}` → Kotlin clears `saveAs`, uses `AgentPrompts.downloadName(agentName, suggested)` and does not let the `Content-Disposition` rename override the agent's name (`namedByAgent`); `{kind:'cancel'}` → `download.refuse` + record removed. Folder/default placement unchanged; user tabs unchanged.                                                                                           |
| HTTP auth, permission, external protocol | already routed by #745's Android work                                                     | —                                                                                                                                                                   | —                                                                                                                               | unchanged, still listed in `agentPrompts`                                                                                                                                                                                                                                                                                                                                                                                                       |

`platform.ts` `HostCapabilities.agentPrompts` is now exactly:
`['file-chooser', 'download', 'http-auth', 'client-certificate', 'permission', 'external-protocol']`.

## Limits

1. **Print is not routed and not listed.** Android `WebView` does not surface `window.print()`: there is
   no `WebChromeClient` callback and the call is a no-op in the engine, so there is nothing to intercept.
   Zenium's own print path (`PrintManager` from the menu) is user-initiated and not a page prompt.
   `pageScript.ts` has no window-API override pattern, so no shim was added; `print` is not in
   `agentPrompts`.
2. **File System Access pickers do not exist in WebView** (`showOpenFilePicker`, `showSaveFilePicker`,
   `showDirectoryPicker` are undefined). Nothing to route; nothing claimed.
3. **Client certificate candidates are the aliases the user has already picked this session for the
   same host** (another port of it; the exact `host:port` pick proceeds before the agent is asked),
   described via `KeyChain.getCertificateChain` and narrowed by the request's `keyTypes` / `principals`
   as the KeyChain narrows the user's own list. A pick the user made for a different host is never
   offered. Android's `KeyChain` has no enumeration API — `choosePrivateKeyAlias` _is_ the system UI —
   so in practice the list is almost always empty and the agent gets a refusal notice instead of a
   choice. A cert the user has never granted to the app cannot be offered to an agent.
4. **`webkitdirectory` is not supported by WebView**; the file chooser only sees `multiple` and `accept`.
   `fileChooserRequestOf` reports `source: 'input'`, mode `single`/`multiple`.
5. **Uploads are inline bytes only, on both paths.** `setInputFiles` and the chooser's `files` answer
   take `{name, base64, mimeType}` entries; an answer with a `path` entry is refused whole (the chooser is
   cancelled for the page, `setInputFiles` rejects) and the agent reads why with its next result. A path
   would be opened by the WebView as Zenium itself and handed to the page the agent drives, which no
   agent – loopback or not – may do; Kotlin has no code path that builds a `Uri` from agent input. Same-origin
   frames are searched (the input is told by tag and type, not `instanceof`, so a frame's own realm
   counts); cross-origin frames are not reachable.
6. **Agent uploads live in app cache** (`cache/agent-uploads/<answer>/<i>/<name>`, one folder per file so
   two files under one name stay two). A tab's folders are deleted when its agent lets the page go
   (`view.interceptAgentPrompts off`) or the view is destroyed – the page reads them at submit while the
   agent works it; a form still streaming at that instant would lose its file. Folders older than 5 hours
   are swept at app start and before each new answer is written. A very large inline upload is bounded by
   the bridge message size, not by this PR.
8. **The agent's download name takes the user's path**: `DownloadLogic.sanitizeFilename` (no folders,
   control characters, leading dot, reserved names; 200-char cap) and the type's extension when it has none,
   at bind and again once the response names the type. The `Content-Disposition` name still does not replace it.
7. **Downloads in the `ask` mode only route when the agent drives the source tab**; downloads without a
   source tab (e.g. from a notification) still ask the user.

## Per-file changes

Rule-(b) value: `git diff b5de02664 HEAD -- <file> | grep '^[+-][^+-]' | sha1sum | cut -c1-12`
(merge-base with `main` = `b5de02664`). The report itself is excluded from the table.

| Value          | File                                                               | Note                                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2d72fb071f80` | `src/core/agent/service.ts`                                        | **SHARED — needs Desktop nod.** Adds `refuseClientCertificate(tabId, host)`: pushes a notice to the driver and logs when no certificate can be offered on an agent's tab. No change to routing/queue.    |
| `63157c6c0ab3` | `src/android/agentPrompts.ts`                                      | New. Pure helpers: `fileChooserRequestOf`, `fileChooserAnswerWire`, `clientCertificatesOf`, `agentDownloadDestination`, `downloadAsksWhere`, `setInputFilesScript`.                                      |
| `4c727b71b83d` | `src/android/views.ts`                                             | `fileChooser` view event → `onFileChooser` → `events.onFileChooser`, answers via `view.fileChooserAnswer`; `interceptAgentPrompts(on)`; `setInputFiles`.                                                 |
| `cbd5bad6d7ce` | `src/android/platform.ts`                                          | `agentPrompts` list; `download.started` gains `saveAs` and routes Save As through `agents.downloadDestination`; `certificate.request` host event → `security.clientCertificate` → `certificate.respond`. |
| `3ed72be3d83b` | `src/android/__tests__/agentPrompts.test.ts`                       | New vitest for the helpers (6 tests).                                                                                                                                                                    |
| `ec8d69190920` | `src/android/__tests__/views.test.ts`                              | Adds "AndroidTabView and an agent's native prompts" (intercept toggle, chooser answers files/cancel/user, core-without-handler → user, `setInputFiles` ok/error).                                        |
| `fb98e326cfd5` | `android/app/src/main/kotlin/app/zen/chromium/AgentPrompts.kt`     | New. Pure logic: chooser event/answer parsing, `uploadFileName`, `CertificateAnswer`, `describeCertificate`, `commonNameOf`, `downloadName`; `AgentUploads.write/sweep`.                                 |
| `4ec9ea625554` | `android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt`       | `interceptsAgentPrompts`; holds `onShowFileChooser` callbacks; `answerFileChooser`; `onReceivedClientCertRequest` passes the tab to `Security`; held choosers cancelled on `destroy()`.                  |
| `eac45fd9f8ff` | `android/app/src/main/kotlin/app/zen/chromium/Security.kt`         | `onClientCertRequest(tab, request)`: remembered → KeyChain chooser → or `askAgent`; `respondClientCertificate`; `proceed(key: String?)` only remembers when `key != null`.                               |
| `174ac4a2f8b1` | `android/app/src/main/kotlin/app/zen/chromium/Downloads.kt`        | `saveAs` in `download.started`; `destination.agent` honoured in `bind` (no sheet, agent's filename, `namedByAgent` guards the header rename).                                                            |
| `de62f7599375` | `android/app/src/main/kotlin/app/zen/chromium/Host.kt`             | Commands `view.interceptAgentPrompts`, `view.fileChooserAnswer`, `certificate.respond`.                                                                                                                  |
| `1d59820565a2` | `android/app/src/main/kotlin/app/zen/chromium/BrowserActivity.kt`  | Start-up sweep also clears stale `agent-uploads`.                                                                                                                                                        |
| `d020799b3c90` | `android/app/src/main/res/xml/file_paths.xml`                      | `cache-path agent-uploads` for the FileProvider.                                                                                                                                                         |
| `82a0f15cfe85` | `android/app/src/test/kotlin/app/zen/chromium/AgentPromptsTest.kt` | New. 10 JUnit tests over `AgentPrompts` and `AgentUploads`.                                                                                                                                              |

## Tests run

Local, on the tree with `main` merged (`944196b87`, after #743/#752):

| Command                                                                                                                                                 | Result                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                                     | pass                                                                  |
| `npm run lint`                                                                                                                                          | exit 0; 16 pre-existing prettier warnings, none in files touched here |
| `npm test` (full vitest)                                                                                                                                | 1148 files passed, 3 skipped; 16220 tests passed, 5 skipped           |
| `npx vitest run src/android/__tests__/agentPrompts.test.ts src/android/__tests__/views.test.ts`                                                         | 28 passed                                                             |
| `cd android && ANDROID_HOME=$HOME/android-sdk ./gradlew testDebugUnitTest assembleDebug compileDebugAndroidTestKotlin -PskipWeb --no-daemon` (CI's set) | BUILD SUCCESSFUL; `AgentPromptsTest` tests=10 failures=0 errors=0     |

CI (PR #755, head `944196b87`): run [36840613003](https://github.com/BenItBuhner/Zenium/actions/runs/36840613003)
— Typecheck, lint, test / Android debug APK / Desktop boot smoke (Linux) / Bundle on a case-insensitive
filesystem / Accounts backend and website / Workflow lint (actionlint): all pass.

Note: the first three pushes produced no Actions run because `main` had moved (#743, #752) and the PR
was `mergeable_state: dirty`; GitHub creates no `pull_request` run for a conflicting PR. Merging `main`
(`9c5c8cafc`) fixed that.

## WORDS

none — no new user-facing strings. The one new sentence is the agent-facing notice in
`AgentService.refuseClientCertificate` (delivered to the MCP driver, never shown in the UI).

## Follow-ups

- OS-40 part B (#743's TODO): route `alert`/`confirm`/`prompt` of an agent-driven page through
  `PageDialogService` on Android the same way; `interceptsAgentPrompts` is the flag to key it on.
- Desktop nod on `src/core/agent/service.ts` `refuseClientCertificate`; Desktop could call it too when
  its candidate list is empty, instead of silently answering none.
- If a `KeyChain` enumeration ever appears (or Zenium gains its own cert store), `Security.askAgent`
  should describe that list instead of the session's picked aliases.
- Consider a size cap / streaming path for inline agent uploads if agents start sending large files.

## READY

- Head at the green run: `944196b87a62ae00506d4ad31f3b8dae962b40e3` (`cursor/android-agent-prompts-9271`,
  draft PR #755 against `main`). The commit adding this section touches only this report.
- CI: run 36840613003 — success on all six jobs.
- One line: on Android, the file chooser, the client-certificate pick and the download's Save As of a tab an
  agent drives now go to the agent through `agentPrompts` (2-minute default, nothing remembered, no OS UI
  over the agent's tab); print and File System Access pickers are recorded as WebView limits, not listed.

## REVIEW FOLDED

Review: store `internal/design-reviews/pr-755-first-line-review.md` (FAIL at `197462f82`: B1, SF1–4, N1–4).
Folded in `868244e80`; `main` merged after it as `a04907dc2`, and again as `925161d9c` (merge commits, no
rebase; merge-base now `f83345782`). `git diff --stat f83345782 HEAD -- src/main src/shared/types.ts src/renderer`
is empty.

- **B1** – the chooser's `files` answer is inline bytes only. `AgentPrompts.UploadFile` is one data class
  (`AgentPrompts.kt:36`), `UploadFile.Path` and the `Uri.fromFile` branch are gone (`TabWebView.kt:1278-1308`
  builds URIs from `AgentUploads.write` alone). `AgentPrompts.fileChooserAnswer` cancels the whole answer when
  any entry has a `path` (`AgentPrompts.kt:54-69`). TS refuses first: `fileChooserAnswerWire` → `cancel`
  (`agentPrompts.ts:52-62`), `uploadPathsRefusal` is the one sentence both it and `setInputFilesScript` use
  (`:68-72`), and `AndroidTabView.onFileChooser` pushes `fileChooserPathsNotice` to the driving session through
  `AndroidTabViewHost.agentNotices` (`views.ts:490-494`, `:1256`), which `AndroidPlatform.bind` points at
  `browser.agents.driver(tabId)?.notices` (`platform.ts:1925`) – no new core method. Pins:
  `AgentPromptsTest.anAnswerNamingAPathCancelsTheChooserWhole`, `…KeepTheirOrderAndTheirNamesLoseTheirFolders`;
  `agentPrompts.test.ts` "refuses an answer naming a path…"; `views.test.ts` fc_4 case (cancel + notice, the path
  never on the bridge); `platformAgentPrompts.test.ts` "reaches the driving session's notices". Limits 5/6 updated.
- **SF1** – `AgentPrompts.downloadName(agentName, suggested, mimeType, extensionFor)` runs the name through
  `DownloadLogic.sanitizeFilename` then `DownloadLogic.filenameFor(suggestedName=…)` for the extension fill
  (`AgentPrompts.kt:207-211`); `Downloads.bind` passes `l.mimeType`/`DownloadSink::extensionFor` (`Downloads.kt:247`),
  and `readHeaders` keeps the extension fill for `namedByAgent` while still skipping the header rename
  (`Downloads.kt:731-740`). Pin: `AgentPromptsTest.theAgentNameIsSanitisedAndGivenItsExtensionAsEveryDownloadNameIs`
  (leading dot, `../`, control char, `CON`, 300 chars, missing extension, empties).
- **SF2** – `setInputFilesScript` checks `input.tagName !== 'INPUT' || input.type !== 'file'`
  (`agentPrompts.ts:186`); no `instanceof HTMLInputElement`. Pin: `agentPrompts.test.ts` "tells a file input by its
  tag and type".
- **SF3** – `Security.askAgent` offers `AgentPrompts.candidateAliases(certificateChoices, request.host)` – the
  user's picks for the same host only – and drops a chain that fails
  `AgentPrompts.certificateFits(chain, request.keyTypes, request.principals)` (key algorithm in `keyTypes`;
  a chain subject/issuer among the canonical `principals`) (`Security.kt:83-92`, `AgentPrompts.kt:104-132`).
  Pins: `AgentPromptsTest.theAgentIsOfferedOnlyThePicksTheUserMadeForTheSameHost`,
  `aCandidateMustAnswerTheServersKeyTypesAndIssuersWhenItNamedAny`. Limit 3 updated.
- **SF4** – the record-gone branch of the agent's download wait now `downloadTokens.delete` + `download.refuse`
  (`platform.ts:2268-2275`). Pin: `platformAgentPrompts.test.ts` "refuses the transfer when the record went while
  the agent was asked" (+ save → bind, cancel → refuse + remove, and the `certificate.request` handler's three
  branches).
- **N1** – `TabHost.adopt` and `bind` call `view.setInterceptAgentPrompts(false)` beside `agentDriven = false`
  (`TabHost.kt:209`, `:233`).
- **N2** – `TabWebView.setInterceptAgentPrompts(false)` and `destroy()` delete the tab's upload folders
  (`clearAgentUploads`, `TabWebView.kt:1248-1251`, `:433`, `:1312-1317`); `answerFileChooser` sweeps stale folders
  before writing (`:1290`).
- **N3** – `AgentUploads.write` puts each file in its own numbered folder under the answer's
  (`AgentPrompts.kt:232-241`), so the page still sees the agent's names and two alike stay two. Pin:
  `AgentPromptsTest.inlineFilesAreWrittenUnderTheirNamesEachInItsOwnFolderAndStaleFoldersAreSwept`.
- **N4** – `AndroidTabView.onFileChooser` answers `cancel` when `onFileChooser` rejects (`views.ts:495`);
  a core without the handler still answers `user`. Pin: `views.test.ts` fc_3 case.

Rule-(b) values against the new merge-base `f83345782` (identical against `1be1aa877`)
(`git diff f83345782 HEAD -- <file> | grep '^[+-][^+-]' | sha1sum | cut -c1-12`; the report excluded):

| Value          | File                                                               |
| -------------- | ------------------------------------------------------------------ |
| `2d72fb071f80` | `src/core/agent/service.ts` (unchanged hunk)                       |
| `38b4fb247409` | `src/android/agentPrompts.ts`                                      |
| `09f921c7000a` | `src/android/views.ts`                                             |
| `284113ce56ca` | `src/android/platform.ts`                                          |
| `1183eea121e0` | `src/android/__tests__/agentPrompts.test.ts`                       |
| `84ac8808eabb` | `src/android/__tests__/views.test.ts`                              |
| `62b410fd4dc6` | `src/android/__tests__/platformAgentPrompts.test.ts` (new)         |
| `5c7e0c2af3a2` | `android/app/src/main/kotlin/app/zen/chromium/AgentPrompts.kt`     |
| `7372159624cf` | `android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt`       |
| `7f1b0439d319` | `android/app/src/main/kotlin/app/zen/chromium/Security.kt`         |
| `7ea25642d5c5` | `android/app/src/main/kotlin/app/zen/chromium/Downloads.kt`        |
| `aa4d34e5a445` | `android/app/src/main/kotlin/app/zen/chromium/TabHost.kt` (new)    |
| `de62f7599375` | `android/app/src/main/kotlin/app/zen/chromium/Host.kt`             |
| `1d59820565a2` | `android/app/src/main/kotlin/app/zen/chromium/BrowserActivity.kt`  |
| `d020799b3c90` | `android/app/src/main/res/xml/file_paths.xml`                      |
| `d7450625b81a` | `android/app/src/test/kotlin/app/zen/chromium/AgentPromptsTest.kt` |

Checks on `a04907dc2`: `npm run typecheck` pass; `npm run lint` 0 errors (pre-existing prettier warnings, none in
PR files); `npx vitest run src/android/__tests__/agentPrompts.test.ts src/android/__tests__/views.test.ts
src/android/__tests__/platformAgentPrompts.test.ts` 37 passed; `cd android && ./gradlew :app:testDebugUnitTest
-PskipWeb --no-daemon` BUILD SUCCESSFUL, `AgentPromptsTest` tests=14 failures=0 (SDK ad hoc under `/tmp/android-sdk`,
no `local.properties`); full `npm test` 1153 files / 16259 tests passed, full `testDebugUnitTest` 0 failures.
CI: run [36851638723](https://github.com/BenItBuhner/Zenium/actions/runs/36851638723) on `925161d9c` (the second
`main` merge, code as folded) – all six jobs pass; so did run 36847972983 on `6aa54bddf` (first report commit). Runs
36847606927 and 36849298590 were superseded by the pushes that followed them. The commit correcting this paragraph
touches only this report.

service.ts moved: **no** (old `2d72fb071f80` → new `2d72fb071f80`).
