---
name: chrome-use
description: Drive the user's own logged-in Chrome, headed, on a persistent profile. Use when a task needs to open a site, click through a flow, fill a form, or get past a login the user can do by hand. Not for plain fetching.
---

# chrome-use

One dedicated Chrome profile, started once, driven over CDP. The profile persists, so a login the user does by hand keeps working in later runs.

## Finish the job, then report

What the user wants is a finished flow, not a conversation. Fill what the task needs with the most defensible value you can find, keep going while the next step is still knowable, and put the caveats in the closing message.

Stop and hand back only when:

- The next step is destructive or public: submit, publish, pay, delete, send a message, place an order. Do this only when the user asked for it in so many words.
- A human wall is in the way: sign-in, captcha, 2FA, a payment or identity check, a permission the profile does not have.
- The value you would have to invent decides the outcome and no default is defensible.

Everything else is a place to make a call and say so afterwards. A color picked from three near-synonyms, a placeholder price, a size chart filled with plausible numbers, an optional upload slot left empty: choose, continue, mention it at the end. A draft in a form is reversible; the closing report is where the ambiguity belongs.

Two failures on the same control with the same error mean the approach is wrong, not the timing. Three wrong approaches mean stop, report the blocker, and say what you tried. Do not burn ten rounds guessing at one widget.

The closing message is part of the task: what you filled, which values you invented, what you left blank and why, and the one action still waiting for the user.

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

**One command.** `snap`, then `click`, `hover`, `type`, `select`, `upload`, `open`. No model is involved, so this is the cheapest and the most predictable. It is enough whenever you already know what to press:

```bash
chrome-use snap                        # text plus an element table
chrome-use click e12-9fk
chrome-use hover e9-b2m
chrome-use type e15-9fk "lisbon"
chrome-use press Enter
chrome-use upload e12-9fk ./receipt.png
```

`snap` prints `ref role "label" operations`. A ref looks like `e12-9fk`: the element number plus a token for the current document. Treat it as opaque, copy it exactly, and act only on refs from the latest snapshot. Never invent a selector, and treat a coordinate as a last resort. `click`, `hover`, `point`, `type`, `select`, `upload`, `open`, and `press` all return the new snapshot.

A click leaves the page where it is when the element is already fully visible, and centers it otherwise. An element under a fixed banner or footer is centered once before the press; if it is still covered, the click fails with `NOT_INTERACTABLE` instead of pressing whatever is on top.

`hover` moves the pointer and leaves it there, which is what opens a menu or a tooltip. Hover the trigger, take the returned snapshot, then click the ref that appeared.

A `clickable` entry is a region the page only marked with a pointer cursor: a card, a list row, an icon, a custom dropdown trigger. It is worth a click, but nothing promises a handler, so read the snapshot that comes back before assuming the step worked.

When the table leaves the node out, pass a CSS selector instead of a ref. That covers what the table cannot see: the file input behind a styled upload box, a `div` that only carries a click handler, a control on a form too long to snapshot in one view.

```bash
chrome-use upload 'input[type=file]' ./receipt.png
chrome-use click 'button.add'
chrome-use press Control+a             # also Meta+z, Shift+Tab, Escape
```

**Coordinates, when nothing else reaches it.** A canvas, a drawing, or an unnamed SVG has no ref and no selector. Screenshot the viewport, read `scale`, convert image pixels back to CSS pixels with `css = image / scale`, and press a point. Dry run first: it says what the point is over and presses nothing.

```bash
chrome-use screenshot ./page.png --json   # file, width, height, viewport, scale
chrome-use point 240 180 --dry-run        # "nothing pressed; the point is over canvas"
chrome-use point 240 180
```

A coordinate is CSS pixels of the current viewport, so it means nothing after a scroll, a resize, or a navigation: take a new screenshot and read it again. It is for what the page draws rather than builds, never a way around an obscured or missing ref.

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

For a page that changes on its own, poll with `cu.waitForText('32 results')`, `cu.waitForURL(/\/done$/)`, or `cu.waitFor('document.querySelector("#row")')`. Each takes `{ maxTime }` in seconds and throws `TIMEOUT` instead of returning quietly.

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
- `type` and `select` read the value back. `INPUT_MISMATCH` means the page kept something else: a controlled field reverted it, a formatter rewrote it, or the field is not what the table said. Read the message, look at the page, and decide — do not retype the same text. Whitespace differences are tolerated.
- `type` refuses a field that cannot take text before it presses anything: read only, disabled, a segmented date/time input, or a value longer than the field allows. Set a date field through `chrome-use eval` instead.
- `type` with an empty text clears the field. That is the way to say "no value".
- `upload` reads the file input back. `INPUT_MISMATCH` means the page dropped or rewrote the selection: the wrong input, a component that keeps only one file, an `onchange` that resets it. Look at the input before retrying.
- Do not sleep to wait for a page. `waitForIdle()` then `snap()` again, or read the new snapshot an action already returned.
- A click scrolls the element into view only when it is not already fully on screen, then hit tests it. If it throws `NOT_INTERACTABLE`, something really covers it: close the overlay or scroll, then retry.
- `STALE` means the element is gone. Take a new snapshot and find the element again by label, not by remembering the ref.
- Refs carry a document token, so one from before a navigation is rejected with `STALE` instead of silently hitting a different element. Take a new `snap`.
- Human walls belong to the user: login, captcha, 2FA, payment, an identity check. Stop there. Anything short of a wall — an awkward widget, a missing label, an overlay in the way — belongs to you; a selector or a script can usually reach it.
- Uploading a file publishes it to the site. Only use a path the user named, or one unpacked from a path the user named, and never attach something you found by guessing.
- Native dialogs are accepted automatically, because you pressed the button that asked. `snap.dialogs` counts them and `snap.dialog` carries the last one as `type "message"`. A `confirm` is a question you have already answered yes to: read it before continuing, and say so in the closing report when it mattered.
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
| `NOT_INTERACTABLE` | covered, disabled, read only, wrong kind, over maxlength, or outside the viewport | close the overlay, pick another target, shorten the text, take a new screenshot |
| `INPUT_MISMATCH` | the value did not stay | read the message, take a snapshot, adjust; do not retype |
| `NEEDS_TEXT` | a fill has no value | pass `--fill 'Field=value'` |
| `MODEL_ERROR` | the decision endpoint refused or timed out | check the failing model’s `--jev-*` or `--text-*` configuration |
| `INVALID_DECISION` | the answer was outside the offered choices | rerun; if it repeats, `--dry-run` and inspect |
| `CHROME_NOT_FOUND` | no Chrome binary | `--chrome <path>` or `CHROME_PATH` |
| `TIMEOUT` | a `waitFor*` helper ran out of time | take a snapshot and see what the page is actually showing |
| `SCRIPT_ERROR` | `chrome-use js` could not parse the code | fix the script, or pass `--file` |

## Direct CDP

Anything the helpers do not cover is one call away:

```bash
chrome-use cdp Network.getAllCookies
chrome-use cdp Runtime.evaluate '{"expression":"document.title","returnByValue":true}'
chrome-use eval 'document.title'
```

In scripts, `cu.send('Domain.method', params)` and `cu.cdp` reach the raw protocol. `chrome-use skill` prints this file's path.
