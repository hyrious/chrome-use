<h1>
  <img align="right" alt="100% AI-generated" src="https://img.shields.io/badge/100%25%20AI--generated-000000?style=flat-square">
  @hyrious/chrome-use
</h1>

Simple browser use tool for agents. Optional JEV support. Headed Chrome only.

```bash
# npm i -g @hyrious/chrome-use  # not published! see below
chrome-use start  # starts your own chrome with debugging port open
chrome-use open https://www.wikipedia.org/

TYPESAFE_API_KEY=sk-... \
  chrome-use agent --goal "Search Wikipedia for browser use"

chrome-use stop  # or just close the browser, nothing runs in the background
```

> [!IMPORTANT]
> This package has not been published. If you want to try it locally, clone
> this repo then run the script to install it:
> ```bash
> ./scripts/local.sh
> ```

## Command-line

Start Chrome and open a page:

```bash
chrome-use start
chrome-use status
chrome-use open https://www.wikipedia.org/
chrome-use snap
chrome-use type e15-9fk "Lisbon"
chrome-use press Enter
chrome-use click e12-9fk
```

Fill forms, inspect tabs, and save screenshots:

```bash
chrome-use select e8-b2m "PT"
chrome-use upload e21-b2m ./receipts/hotel.pdf
chrome-use upload e21-b2m ./receipts/hotel.pdf ./receipts/train.pdf
chrome-use snap --tab 0  # count from 0, can also use an ID returned by status
chrome-use snap --limit 500 --json
chrome-use open https://news.ycombinator.com/ --tab 1
chrome-use screenshot ./search-results.png
chrome-use screenshot ./article.png --full
chrome-use close --tab 1
```

Run JavaScript in the page, or call a Chrome DevTools Protocol method:

```bash
chrome-use eval 'document.title'
chrome-use eval 'Array.from(document.querySelectorAll("h2"), h => h.textContent)'
chrome-use cdp Page.getLayoutMetrics
chrome-use cdp Runtime.evaluate '{"expression":"location.href","returnByValue":true}'
```

Use `js` for Node.js scripts with `cu` bound to the browser session. Scripts can
await browser actions and return a value to print. There is no sandbox.

```bash
chrome-use js 'return await cu.tabs()'
chrome-use js --file ./scripts/check-booking.js
chrome-use js <<'JS'
const { elements } = await cu.snap()
await cu.click(elements.find((e) => e.label.includes('Casa Flora')).ref)
return await cu.eval('location.href')
JS
```

Use `agent` to let JEV work on the current page.
This command needs [Model configuration](#model-configuration).

```bash
chrome-use open https://www.wikipedia.org/
chrome-use decide --goal "Search Wikipedia for Lisbon"  # suggest an action without executing it
chrome-use agent --goal "Search Wikipedia for Lisbon" --fill 'Search=Lisbon' --max-steps 10
chrome-use agent --goal "Attach the hotel receipt without submitting the form" --upload 'Receipt=./receipts/hotel.pdf' --json
```

Restart chrome with different settings, the default port is `9333`:

```bash
chrome-use stop
chrome-use stop --force  # send SIGKILL if Chrome does not close
chrome-use start https://www.wikipedia.org/ --window-size 1440,900
chrome-use stop
chrome-use start --port 9444 --profile "$HOME/.chrome-use-work"
chrome-use stop
chrome-use start --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

### SKILL.md

```bash
chrome-use skill
```

### Model configuration

`decide` and `agent` requires LLMs to work, here's the configuration:

| CLI flag          | Environment variable (in priority order)     | Default                      |
| ----------------- | -------------------------------------------- | ---------------------------- |
| `--jev-base-url`  | `CHROME_USE_JEV_BASE_URL`                    | `https://api.typesafe.ai/v1` |
| `--jev-api-key`   | `TYPESAFE_API_KEY`, `CHROME_USE_JEV_API_KEY` |                              |
| `--jev-model`     | `CHROME_USE_JEV_MODEL`                       | `typesafe/jev`               |
| `--text-base-url` | `CHROME_USE_TEXT_BASE_URL`                   | `https://api.openai.com/v1`  |
| `--text-api-key`  | `OPENAI_API_KEY`, `CHROME_USE_TEXT_API_KEY`  |                              |
| `--text-model`    | `CHROME_USE_TEXT_MODEL`                      |                              |

In JavaScript:

```js
await run(session, {
  goal: 'Search for browser use',
  jev: {
    baseUrl: 'https://api.typesafe.ai/v1',
    apiKey: process.env.TYPESAFE_API_KEY,
    model: 'typesafe/jev',
  },
  text: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4.1-mini',
  },
})
```

### Proxy

```bash
chrome-use stop; chrome-use start -x http://localhost:7890
```

## License

MIT @ [hyrious](https://github.com/hyrious)
