---
name: chrome-use
description: Drive the user's own logged-in Chrome, headed, on a persistent profile. Use when a task needs to open a site, click through a flow, fill a form, or get past a login the user can do by hand. Not for plain fetching.
---

# chrome-use

One dedicated Chrome profile, started once, driven over CDP. The profile persists, so a login the user does by hand keeps working in later runs.

## Check first

```bash
chrome-use status        # running? which tabs?
```

If it is not running, `chrome-use start` opens a headed window. Start it once per session, not per command. `chrome-use start <url>` also navigates.

Startup and tab creation keep the browser in the background where supported. Actions use CDP with emulated page focus, so the user can keep working in another window.

Do not spawn a second Chrome. Do not use another profile: the login lives in this one.

The profile carries no proxy setting. If pages fail to load with `NETWORK`, close Chrome and start it again with the user's proxy:

```bash
chrome-use stop && chrome-use start -x http://127.0.0.1:7890
```

Ask the user for the proxy address instead of guessing when 7890 is not obviously in use.

## Three ways to work, cheapest first

**One command.** `snap`, then `click`, `type`, `select`, `upload`, `open`. No model is involved, so this is the cheapest and the most predictable. It is enough whenever you already know what to press:

```bash
chrome-use snap                        # text plus an element table
chrome-use click e12-9fk
chrome-use type e15-9fk "lisbon"
chrome-use press Enter
chrome-use upload e12-9fk ./receipt.png
```

`snap` prints `ref role "label" operations`. A ref looks like `e12-9fk`: the element number plus a token for the current document. Treat it as opaque, copy it exactly, and act only on refs from the latest snapshot. Never invent a selector and never click by coordinates. `click`, `type`, `select`, `upload`, `open`, and `press` all return the new snapshot.

**One script.** When the flow needs logic, a loop, several coordinated steps, or a comparison across the page, write it once with `chrome-use js`:

```bash
chrome-use js <<'JS'
const { elements } = await cu.snap()
const row = elements.find((element) => element.label.includes('Casa Flora'))
await cu.click(row.ref)
return await cu.eval('location.href')
JS
```

The script body may await and its return value is printed. It also gets `sleep` and `console`. Use `--file path` for something longer, or import the package in a normal `.mjs` when the script has to outlive one run, and wait for a page with `cu.waitForIdle()` rather than sleeping.

**The loop, only for fixed sequences.** When the next step depends on what the page shows and you do not want to look yourself, let `agent` pick from the offered operations:

```bash
chrome-use agent --goal "Search Lisbon design hotels with free cancellation, open Casa Flora"
```

Jev defaults to `https://api.typesafe.ai/v1` and model `typesafe/jev`.
Its API key comes from `TYPESAFE_API_KEY`, falling back to `CHROME_USE_JEV_API_KEY`.
Override these with `--jev-base-url`, `--jev-api-key`, and `--jev-model`, or
`CHROME_USE_JEV_BASE_URL` and `CHROME_USE_JEV_MODEL`.

The optional text model defaults to `https://api.openai.com/v1`. Its API key comes
from `OPENAI_API_KEY`, falling back to `CHROME_USE_TEXT_API_KEY`. Set its model
with `--text-model` or `CHROME_USE_TEXT_MODEL`. Override its URL and key with
`--text-base-url`, `--text-api-key`, or `CHROME_USE_TEXT_BASE_URL`.
Flags override environment variables; empty API key environment variables are skipped.
Any text flag or `CHROME_USE_TEXT_*` variable requires a complete text configuration.
`OPENAI_API_KEY` alone does not enable it. The two models use separate credentials.
Base URLs include any API version prefix; the tool appends `/systemone` for Jev
and `/chat/completions` for text.

Each step costs one decision request. Give it the values it must type so it does not have to guess:

```bash
chrome-use agent --goal "..." --fill 'Where to=Lisbon' --fill 'Guests=2'
```

It stops with `needs` when a field has no value; rerun with that `--fill` added, or configure a text model so it can derive the value from the goal.

A `blocked` result may carry a `hint:`. Read it before retrying: the loop is a closed set of operations and it says so when a step is outside it. A verification screen or a sign-in wall belongs to the user; anything else belongs to a script. Do not rerun the same goal hoping for a different answer.

It returns `verified: false` always, so verify the result yourself (URL, page text).

## Rules that save you time

- Act only on refs from the latest snapshot.
- Do not sleep to wait for a page. `waitForIdle()` then `snap()` again, or read the new snapshot an action already returned.
- A click scrolls the element into view and hit tests it. If it throws `NOT_INTERACTABLE`, something really covers it: close the overlay or scroll, then retry.
- `STALE` means the element is gone. Take a new snapshot and find the element again by label, not by remembering the ref.
- Refs carry a document token, so one from before a navigation is rejected with `STALE` instead of silently hitting a different element. Take a new `snap`.
- Login, captcha, 2FA, payment, anything destructive: stop and ask the user. Do not try to automate them.
- Uploading a file publishes it to the site. Only use a path the user named, and never attach something you found by guessing.
- Native `alert` dialogs are dismissed automatically and counted in `snap.dialogs`.
- Elements inside open shadow roots and same-origin iframes appear in the table and can be clicked. Cross-origin frames cannot; ask the user when a payment or captcha widget lives there.
- The element table only covers what the viewport shows. If the control you need is not listed, `SCROLL_DOWN` before concluding anything.
- `BACK` returns to the previous page. When a link opens a new tab, the current page does not change. The next request offers `SWITCH_1` and friends; switch, then continue there. `chrome-use status` lists tabs, `--tab` picks one by id, prefix, or index, and `chrome-use close` shuts the current one when you are done with it.
- The element table stops at 250 entries. Scroll or narrow the page instead of guessing.

## Inspect what the model sees

Before trusting `agent` on an unfamiliar site, look at the generated request:

```bash
chrome-use decide --goal "..." --dry-run
```

It prints the exact JSON sent to the decision endpoint: the page text, the element table, and every offered choice. No request is made with `--dry-run`.

## Errors

| code | meaning | what to do |
| --- | --- | --- |
| `NOT_RUNNING` | nothing on the port | `chrome-use start` |
| `NETWORK` | the page never loaded | restart Chrome with `-x <proxy>`, or ask the user for one |
| `STALE` | ref is gone | `snap`, find the element again |
| `NOT_INTERACTABLE` | covered, disabled, or wrong kind | close the overlay, pick another target |
| `NEEDS_TEXT` | a fill has no value | pass `--fill 'Field=value'` |
| `MODEL_ERROR` | the decision endpoint refused or timed out | check the failing model’s `--jev-*` or `--text-*` configuration |
| `INVALID_DECISION` | the answer was outside the offered choices | rerun; if it repeats, `--dry-run` and inspect |
| `CHROME_NOT_FOUND` | no Chrome binary | `--chrome <path>` or `CHROME_PATH` |
| `SCRIPT_ERROR` | `chrome-use js` could not parse the code | fix the script, or pass `--file` |

## Direct CDP

Anything the helpers do not cover is one call away:

```bash
chrome-use cdp Network.getAllCookies
chrome-use cdp Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
chrome-use eval 'document.title'
```

In scripts, `cu.send('Domain.method', params)` and `cu.cdp` reach the raw protocol. `chrome-use skill` prints this file's path.
