// Driver contract versions must be checked at RUNTIME, not just at compile
// time against whatever sibling happened to be linked.
//
// dsh-qa loads its drivers lazily by package name. Whatever is installed at
// that moment is what runs, and a driver may be upgraded independently — they
// are separate npm packages on separate release cadences. Both drivers already
// publish a version (BROWSER_DRIVER_CONTRACT_VERSION = 9,
// COMPUTER_DRIVER_CONTRACT_VERSION = 5) and expose `contractVersion` on the
// instance; the loaders simply never read it, so a driver reporting any version
// at all was instantiated and used.
//
// That is worse than a missing feature. A contract bump can change what an
// observation MEANS — which nodes are emitted, what `truncated` covers, whether
// absence can be proven — so the evidence silently changes meaning while the
// verdicts keep looking the same. TypeScript cannot catch it: types describe
// the sibling in node_modules at build time, not the package resolved at run
// time.
//
// Refusing an UNKNOWN version (older or newer) is the only fail-closed
// direction: an unsupported driver must stop the session, not quietly produce
// verdicts nobody can interpret.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadBrowserManager,
  SUPPORTED_BROWSER_CONTRACT_VERSION,
} from '../src/adapters/loadBrowser.ts'
import {
  loadComputerDriver,
  SUPPORTED_COMPUTER_CONTRACT_VERSION,
} from '../src/adapters/loadComputer.ts'

/**
 * A stub module whose shape matches what the loaders import. `contractVersion`
 * is what the loader must consult.
 */
function stubBrowserModule(contractVersion) {
  return {
    BrowserManager: class {
      constructor() {
        if (contractVersion !== undefined) this.contractVersion = contractVersion
      }
    },
  }
}

function stubComputerModule(contractVersion) {
  return {
    ComputerController: class {
      constructor() {
        if (contractVersion !== undefined) this.contractVersion = contractVersion
      }
    },
  }
}

test('the supported driver contract versions are declared as constants', () => {
  assert.equal(typeof SUPPORTED_BROWSER_CONTRACT_VERSION, 'number')
  assert.equal(typeof SUPPORTED_COMPUTER_CONTRACT_VERSION, 'number')
})

test('a browser driver reporting the supported contract version loads', async () => {
  const driver = await loadBrowserManager(undefined, undefined, {
    importModule: async () => stubBrowserModule(SUPPORTED_BROWSER_CONTRACT_VERSION),
  })
  assert.equal(driver.contractVersion, SUPPORTED_BROWSER_CONTRACT_VERSION)
})

test('a browser driver reporting a NEWER contract version is refused', async () => {
  // Codex supplied a module reporting contractVersion = 999 and it loaded
  // happily. It must not.
  await assert.rejects(
    () => loadBrowserManager(undefined, undefined, {
      importModule: async () => stubBrowserModule(999),
    }),
    (error) => {
      assert.match(String(error.message), /contract/i)
      assert.match(String(error.message), /999/, 'the refusal names the version found')
      assert.match(
        String(error.message),
        new RegExp(String(SUPPORTED_BROWSER_CONTRACT_VERSION)),
        'and the version supported',
      )
      return true
    },
  )
})

test('a browser driver reporting an OLDER contract version is refused', async () => {
  // Older is not "safely degraded": contract v9 is what added the
  // closed-shadow-root coverage probe that `node-absent` depends on. An v8
  // driver would make absence assertions mean something different.
  await assert.rejects(
    () => loadBrowserManager(undefined, undefined, {
      importModule: async () => stubBrowserModule(SUPPORTED_BROWSER_CONTRACT_VERSION - 1),
    }),
    (error) => {
      assert.match(String(error.message), /contract/i)
      return true
    },
  )
})

test('a browser driver reporting NO contract version is refused', async () => {
  await assert.rejects(
    () => loadBrowserManager(undefined, undefined, {
      importModule: async () => stubBrowserModule(undefined),
    }),
    (error) => {
      assert.match(String(error.message), /contract/i)
      return true
    },
  )
})

test('the computer driver is pinned the same way', async () => {
  const driver = await loadComputerDriver(undefined, {
    importModule: async () => stubComputerModule(SUPPORTED_COMPUTER_CONTRACT_VERSION),
  })
  assert.equal(driver.contractVersion, SUPPORTED_COMPUTER_CONTRACT_VERSION)

  await assert.rejects(
    () => loadComputerDriver(undefined, {
      importModule: async () => stubComputerModule(999),
    }),
    (error) => {
      assert.match(String(error.message), /contract/i)
      return true
    },
  )
})
