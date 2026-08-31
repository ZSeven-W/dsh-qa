# Owner-authorized login-state injection (WP11)

dsh-qa can start a browser QA session with pre-loaded login state (cookies +
localStorage) for EXPLICITLY authorized origins only, from an explicit state
file the owner exports themselves. It never scans for profiles, never reads a
default profile location, and never accepts a directory.

## Session config

`qa_session_start` (and the scenario `target.loginState`) accept:

```json
{
  "source": "/absolute/path/to/state.json",
  "origins": ["https://app.example.com"]
}
```

- `source` is a Playwright **storageState** JSON file (`cookies` +
  `origins[]/localStorage`).
- `origins` are exact origins (scheme + host + optional port). Only entries
  whose cookie `domain` exactly matches an authorized host (or its dot-prefixed
  spelling) and origins whose `origin` exactly matches the list are injected.
- The file is read, filtered in memory, injected, then dropped — never copied
  into the session profile. A file that fails to parse, has no authorized
  entries, or holds entries the filter cannot classify fails the start.

## Producing a storageState file with Playwright

The owner exports the state file themselves; dsh-qa never writes one. Two
common ways:

1. **Codegen + save state**: run Playwright Codegen against the real site,
   sign in, then save the authenticated context:

   ```bash
   npx playwright codegen --save-storage=state.json https://app.example.com/login
   ```

   (Sign in in the opened browser window; close it; `state.json` now holds the
   cookies + localStorage for the sites you visited.)

2. **A small script** that launches a persistent context, signs in, and writes
   `storageState()`:

   ```js
   import { chromium } from 'playwright'
   const browser = await chromium.launchPersistentContext('', { headless: false })
   const page = browser.pages()[0] ?? await browser.newPage()
   await page.goto('https://app.example.com/login')
   // ... sign in manually ...
   await page.context().storageState({ path: 'state.json' })
   await browser.close()
   ```

Secrets in `state.json` are handled by dsh-qa's fail-closed redaction: the
file's contents never reach reports or error messages (only counts and
origins are named), and a redaction corpus test asserts a cookie value never
appears in report.json / report.md / report.jsonl.

