---
name: zenium-browser
description: Drives the user's Zenium browser through its built-in MCP server politely, alongside the user and other agents. Use when a task needs a real browser in Zenium - open or read a web page, fill a form, click, type, scroll, hover, take a screenshot, manage tabs and tab groups, search browsing history - through the zen_* and browser_* MCP tools. Covers connecting, tab ownership etiquette, every tool with its arguments, and the mistakes to avoid.
license: Apache-2.0
compatibility: Needs Zenium (desktop or Android) with its MCP server enabled in Settings > AI Agents, and an MCP client connected to it (Streamable HTTP endpoint or the `zenium --mcp` command).
metadata:
  version: 0.4.51
  source: zenium
---

# Zenium browser (MCP)

Zenium is the user's own browser. The user browses in it while you work, and other agents may be working in it at the same time. Everything you touch must be yours, or explicitly handed to you by the user.

## Connect

- Streamable HTTP: `http://127.0.0.1:<port>/mcp`. Send the token as `Authorization: Bearer <token>` (or `?token=<token>` on the URL). Settings > AI Agents shows the port, the token and a ready-made `mcp.json`.
- stdio: run the command `zenium --mcp`. It relays to the running browser; Zenium must already be open with the server on.
- Without the token Zenium asks the user to approve you once. Connect with your real client name; the user sees it.
- If the server refuses or is unreachable, tell the user to enable it in Settings > AI Agents. Do not retry in a loop.

## First calls

1. `zen_status` - who you are, your mode, your groups and tabs, which other agents are present. Read it once at the start of every task and after any reconnect.
2. `zen_groups {"action":"create","name":"<task>"}` - your own tab group. Or skip it: your first `browser_tabs new` / `browser_navigate` creates your home group for you, in the shared Agents space.
3. Work inside your group. `browser_tabs {"action":"list"}` shows only your tabs and is cheaper than `zen_status`.

## Etiquette

- Address everything by id. Tab ids look like `tab_3f9a...`, group ids like `folder_...`. Copy them from a listing. Never send a list position (1, 2, 3): positions shift whenever anyone opens or closes a tab, and the server refuses them.
- Only touch what you created. Do not close, move, navigate, click or type in a tab that is not in one of your groups.
- Other agents exist. They have their own groups. Their tabs are refused to you even with `allowForeign`. Do not rename, close or adopt a group that another working agent owns. An agent quiet for over 2 minutes counts as gone (its client most likely dropped) - listings mark its groups `quiet 2 min - adoptable`; a working agent's group is taken only with `force: true`, and only because the user asked you to (that agent is told).
- `allowForeign: true` is for the user's own tabs, only when the user explicitly asked you to work on their page ("read this tab", "fill the form I have open"). Never use it to grab a free tab for yourself. It never makes the tab yours. The user's Essentials and pinned tabs are never closed, moved or grouped.
- Foreground needs the screen. Foreground mode acts in front of the user on a tab they are looking at. Bringing your tab in front first - which switches the user's space and active tab - takes `zen_mode {"mode":"foreground","takeScreen":true}`, and you pass that only when the user wants your work on screen (or the user set foreground as the default in Settings, which grants it). Without it, an action on a tab the user is not looking at runs in the background and the result says so. The screen is also a lease: if another agent holds it, your call runs in the background and the result says so - accept it, do not fight for the screen. When others are present, prefer `zen_mode {"mode":"background"}`.
- Notices. When the user or another agent closes or moves one of your tabs, the next result starts with a line like `Notice: tab tab_... "Title" was closed by the user.` Read it, re-list your tabs, and adapt. Never assume a tab still exists after a notice; never retry the same call blindly.
- Unexpected results (wrong page, missing element, unknown tab): `browser_tabs list`, then `browser_snapshot` on the tab you meant. Do not guess ids and do not open a second copy of a page you already have.
- Every error message names what would have worked (valid actions, open tabs, how to get a ref). Follow it.
- Clean up. When the task is done, `zen_session {"action":"end","closeTabs":true}` - unless the user wants to keep the results on screen, then end without `closeTabs` (your groups stay as orphaned folders the user can read). Ending keeps your connection: the next call simply starts a fresh session, no reconnect needed.
- Long tasks and reconnects. If your connection drops, your group is not destroyed: it becomes orphaned. After reconnecting, `zen_status` lists the orphaned groups a session with your name left; `zen_groups {"action":"adopt"}` (no `groupId`) takes them all back, `{"action":"adopt","groupId":"folder_..."}` one of them (`zen_groups {"action":"list","scope":"all"}` shows every group with `[orphaned, was "<name>"]`). Re-list the tabs; do not open the pages again. A session idle for half an hour is parked, not lost: its groups become orphaned meanwhile and are yours again on your next call (the result says so). A result opening with `Notice: your connection was resumed` means the browser restarted or your session had expired; your old groups are orphaned - adopt them.
- One call at a time. Your calls are serialised per session; sending several in parallel gains nothing.

## Reading vs acting

- `browser_read_page` - the cheapest way to read an article or answer questions about a page. Use it first when you only need text.
- `browser_snapshot` - the page as an accessibility tree with `[ref=eN]` handles. Use it when you need to click, type or select. Every action tool returns a fresh snapshot, so do not call `browser_snapshot` right after an action.
- `browser_take_screenshot` - for layout, images and visual checks only. Never for finding elements. Your model may not be able to see images; the text line the tool returns (`Screenshot (full page, 1280x3400 px, ...)`) is the proof that it worked.
- Keep snapshots small on long pages: `filter`, `interactiveOnly: true`, `maxChars`.

## Targets and coordinates

- A snapshot line reads `button "Sign in" [ref=e12]`. Pass `"target":"e12"` - the `eN` alone, not `[ref=e12]`.
- `target` also takes a CSS selector (`"#login"`, `"button.primary"`) or visible text (`"text=Sign in"`).
- `browser_click` and `browser_hover` also take `x` and `y`: CSS pixels from the top-left of the viewport, inside the viewport size the snapshot header reports. Scroll first if the point is off-screen.
- Refs stay valid until the element leaves the page. After a navigation, take a new snapshot before reusing refs.

## Tools

Every page tool takes `tabId` (required, an id from a listing, never a position) and `allowForeign` (see Etiquette). Examples show only the arguments that matter.

### zen_status

Who you are and what is in the browser: your name, session id, mode and foreground lease, your groups with their tabs (id, title, url), the other agents (name, mode, number of groups), the spaces, the server. It does not list the user's tabs; `browser_tabs {"action":"list","scope":"all"}` does.

- Call it first, and after a reconnect. Later use `browser_tabs list`.
- Example: `zen_status {}`

### zen_session

Your session.

- `{"action":"status"}` - same as `zen_status`.
- `{"action":"end","closeTabs":true}` - close your groups and their tabs, end the session. Without `closeTabs` your groups stay open as orphaned groups; a later session takes one back with `zen_groups {"action":"adopt","groupId":"..."}`. Your connection stays open either way: a call after `end` starts over as a fresh session under the same id.
- `{"action":"rename","name":"Research: invoices"}` - the label the user sees in the sidebar and on your cursor.
- Example: `zen_session {"action":"end","closeTabs":true}`
- Pitfall: ending is not optional. A session left open keeps its tabs claimed for a long time.

### zen_groups

Your tab groups (Zenium tab folders).

- `{"action":"list"}` - your groups with their tabs; `"scope":"all"` lists every agent group with its tabs and its owner (`[yours]`, `[owned by "<name>"]`, or `[orphaned, was "<name>"]` for a group whose agent left), then the user's folders as headers only (name, id, tab count - theirs, not yours to use).
- `{"action":"create","name":"<task>"}` - a new group in the shared Agents space; returns `groupId`. `"space":"own"` creates a private space named after you; `"space":"<spaceId>"` (id or name) uses an existing space: the Agents space or a space an agent made needs nothing, the user's spaces need `allowForeign: true`.
- `{"action":"rename","groupId":"folder_...","name":"..."}`
- `{"action":"close","groupId":"folder_..."}` - closes every tab in it and removes the folder. Own groups only.
- `{"action":"adopt","groupId":"folder_..."}` - take over an orphaned group (its owner session is gone) after a reconnect, or the group of an agent quiet for over 2 minutes. `{"action":"adopt"}` without `groupId` takes back every orphaned group a session with your name left. `"force":true` takes a working agent's group - only when the user asked you to; that agent is told.
- Example: `zen_groups {"action":"create","name":"Price check"}`
- Pitfall: a group is addressed by `groupId`, never by name. Two agents may use the same name.

### zen_spaces

Zenium spaces (workspaces).

- `{"action":"list"}`, `{"action":"create","name":"...","icon":"..."}`.
- `{"action":"switch","spaceId":"..."}` changes what the user sees; it needs foreground mode with the screen taken (`zen_mode {"mode":"foreground","takeScreen":true}`) and the screen lease, and is refused in background mode, without the screen, or while another agent holds it (active within 20 s).
- Example: `zen_spaces {"action":"list"}`
- Pitfall: you rarely need this. Your groups already keep your tabs apart from the user's. Do not switch the user's space to look at your own tabs; snapshots work on background tabs.

### zen_mode

- `{"mode":"foreground"}` - your actions happen in front of the user on a tab they are looking at; your cursor shows what you do; input is real (pop-ups and downloads open). A tab the user is not looking at is acted on in the background, and the result says so.
- `{"mode":"foreground","takeScreen":true}` - as above, and your tab is brought in front before each action (the user's space and active tab change). Pass it only when the user wants your work on screen.
- `{"mode":"background"}` - you work without changing what the user sees; input is synthetic.
- Example: `zen_mode {"mode":"background"}`
- Pitfall: a result that says `input: synthetic` in foreground mode names the reason - the screen not taken, another agent holding it, or the page not yet on screen or painted; in the last case wait a moment and retry once, otherwise stay in background.

### zen_history

Search the user's browsing history by title or URL. Read-only.

- `{"query":"invoice","limit":20}`; an empty query lists the most recent pages. Words match at word starts.
- Example: `zen_history {"query":"github pull","limit":10}`
- Pitfall: this is the user's data. Use it only when the task calls for it and quote from it sparingly.

### browser_tabs

Tab management inside your groups.

- `{"action":"list"}` - your tabs (id, title, url, group). `"scope":"group","groupId":"folder_..."` for one group; `"scope":"all"` for everything, with `[user's active tab]`, `[owned by <agent>]` and `[orphaned]` flags.
- `{"action":"new","url":"https://example.com"}` - opens a tab in your home group and returns its `tabId`; `"groupId"` picks another of your groups; `"background":true` keeps it off the user's screen even in foreground mode.
- `{"action":"close","tabId":"tab_..."}` - your tab only (the user's only with `allowForeign`, and only when the user asked).
- `{"action":"move","tabId":"tab_...","groupId":"folder_..."}` - between your groups; `"index"` reorders within one (1 = first). `allowForeign` does not apply to `move`: a tab that is not yours cannot be moved into your groups (that would make it yours); an orphaned group is taken over whole with `adopt`.
- `select` is deprecated: there is no current tab; pass `tabId` to every page tool instead. `group` / `ungroup` are aliases of `zen_groups create` plus `move`.
- Example: `browser_tabs {"action":"new","url":"https://example.com","background":true}`
- Pitfalls: `tabId` is one id, not a comma-joined list. Never `close` a tab you did not open. `spaceId` on `new` naming one of the user's spaces needs `allowForeign`, and the tab it opens sits outside your groups, so it is not yours (every later call on it needs `allowForeign` too); `groupId` is the way.

### browser_navigate

Load a URL in your tab. Plain words are searched with the user's default search engine. Returns a snapshot of the loaded page.

- `{"tabId":"tab_...","url":"https://example.com/login"}`. With no owned tab at all, it opens one in your home group and says so.
- Example: `browser_navigate {"tabId":"tab_3f9a...","url":"https://news.ycombinator.com"}`
- Pitfalls: this is also how you change the page of an existing tab; do not open a new tab per URL. If the result says `still loading`, follow with `browser_wait_for`.

### browser_navigate_back

Back one page in the tab's history. Returns a snapshot.

- Example: `browser_navigate_back {"tabId":"tab_3f9a..."}`
- Pitfall: use this, not `browser_evaluate` with `history.back()` and not keyboard shortcuts.

### browser_navigate_forward

Forward one page, after going back. Returns a snapshot.

- Example: `browser_navigate_forward {"tabId":"tab_3f9a..."}`
- Pitfall: same as back - the tool exists, do not script it.

### browser_reload

Reload the tab's page. `"ignoreCache":true` forces a fresh download of every resource.

- Example: `browser_reload {"tabId":"tab_3f9a...","ignoreCache":true}`
- Pitfall: do not press F5 or run `location.reload()` instead.

### browser_snapshot

The page as an accessibility tree with `[ref=eN]` handles. Read-only.

- `{"tabId":"tab_..."}`; `"filter":"Checkout"` keeps only lines containing the text; `"interactiveOnly":true` keeps links, buttons, fields and headings; `"boxes":true` appends `[box=x,y,w,h]` for coordinates; `"maxChars":8000` truncates.
- Example: `browser_snapshot {"tabId":"tab_3f9a...","interactiveOnly":true}`
- Pitfalls: not needed right after an action (every action returns one). Refs from an old snapshot may be gone after a navigation.

### browser_click

Click an element or a point, then return a snapshot.

- `{"tabId":"tab_...","target":"e12"}` or `{"tabId":"tab_...","x":400,"y":250}`; `"doubleClick":true`, `"button":"right"`, `"modifiers":["Shift"]`.
- Example: `browser_click {"tabId":"tab_3f9a...","target":"text=Accept all"}`
- Pitfalls: `target` is `e12`, not `[ref=e12]`. A disabled element is reported, not clicked. For checkboxes and radios click them; for `<select>` use `browser_select_option`.

### browser_type

Type into an editable field: clicks it, replaces its value (unless `"clear":false`), optionally presses Enter.

- `{"tabId":"tab_...","target":"e7","text":"hello","submit":true}`
- Example: `browser_type {"tabId":"tab_3f9a...","target":"#email","text":"me@example.com"}`
- Pitfalls: `text` is the field's value, not a label. A non-editable target is refused with the tool to use instead. Do not type into a `<select>`.

### browser_press_key

Press one key in the page, sent to the focused element.

- `{"tabId":"tab_...","key":"Enter"}`; keys: `Enter`, `Tab`, `Escape`, `ArrowDown`, `PageDown`, `a`; `"modifiers":["Control"]`.
- Example: `browser_press_key {"tabId":"tab_3f9a...","key":"Escape"}`
- Pitfall: one key per call; whole strings go through `browser_type`. Never use key chords to manage tabs or history; the browser tools do that.

### browser_hover

Move the mouse over an element or a point without clicking (hover menus, tooltips). Returns a snapshot with what appeared.

- `{"tabId":"tab_...","target":"e12"}` or `{"tabId":"tab_...","x":400,"y":250}`.
- Example: `browser_hover {"tabId":"tab_3f9a...","x":400,"y":250}`
- Pitfall: do not simulate hovers with `browser_evaluate` and synthetic events; they do not trigger real hover styles.

### browser_scroll

Scroll the page: by a viewport in a `direction` (default down), by `amount` pixels, to a `target` element, or `"to":"top"` / `"to":"bottom"`. Returns a snapshot that states the new scroll position.

- Example: `browser_scroll {"tabId":"tab_3f9a...","to":"bottom"}`
- Pitfall: content that loads on scroll appears only after scrolling; use `browser_wait_for` for it rather than repeated scrolls.

### browser_select_option

Choose option(s) of a `<select>` (role `combobox` in snapshots) by value or visible label.

- `{"tabId":"tab_...","target":"e9","values":["Germany"]}` (a single string is accepted).
- Example: `browser_select_option {"tabId":"tab_3f9a...","target":"#country","values":["DE"]}`
- Pitfall: for custom drop-downs built from divs, click to open them and click the option instead.

### browser_wait_for

Wait until `text` appears, `textGone` disappears, a CSS `selector` matches, or for `time` seconds. `timeout` (default 10 s, max 30) bounds the condition.

- Example: `browser_wait_for {"tabId":"tab_3f9a...","text":"Order confirmed","timeout":15}`
- Pitfalls: prefer a condition over `time`. A timeout returns an error with a snapshot; look at the snapshot before waiting again.

### browser_take_screenshot

An image of the tab: the viewport by default, `"fullPage":true` for the whole scrollable page, `"target":"e12"` (or a CSS selector) for one element; `"type":"png"` or `"jpeg"`.

- Example: `browser_take_screenshot {"tabId":"tab_3f9a...","fullPage":true}`
- Pitfalls: never zoom, hide or restyle the page to fake a full-page or element capture; the options exist. Use `browser_snapshot` to find elements, screenshots only to look. `The page could not be captured` names the reason (the tab off screen in background mode, the screen not taken or held by another agent, the first frame not painted yet); follow it - a retry after a moment, or the readers `browser_snapshot` / `browser_read_page` - instead of switching modes blindly.

### browser_read_page

The readable text of the page as plain text: the article (title, byline, body) when the page is one, otherwise all visible text. `"maxChars"` truncates (default 20000).

- Example: `browser_read_page {"tabId":"tab_3f9a...","maxChars":6000}`
- Pitfall: much cheaper than a snapshot; reach for it first when you only need to read.

### browser_evaluate

Run JavaScript in the page and get the JSON result: an expression (`"document.title"`), an arrow function (`"() => document.body.dataset.build"`) or statements ending in a value.

- Off unless the user enabled "Allow agents to run JavaScript in pages" in Settings > AI Agents. If the tool is missing or answers that scripting is disabled, say so and use `browser_snapshot`, `browser_read_page` and the interaction tools instead. Do not ask the user to enable it for something another tool does.
- Example: `browser_evaluate {"tabId":"tab_3f9a...","expression":"document.querySelector('#chart').dataset.points"}`
- Pitfalls: not for navigation, history, reload, scrolling, hovering or screenshots - dedicated tools exist. `Script threw: ...` is the page's own error; read it, do not switch to `view-source:` as a workaround.

## Before you say "done"

- Every claim about the page comes from a tool result you received in this session.
- If the user should see the outcome, leave the tab open and say which tab (title and URL). Otherwise end the session with `closeTabs: true`.
- Report notices you received (a tab the user closed) instead of silently re-opening pages.
