import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_DRIVER_SPECIFIER,
  isModuleNotFoundError,
  loadBrowserManager,
  missingBrowserDriverMessage,
} from '../src/adapters/loadBrowser.ts';

test('the default specifier is the sibling browser driver', () => {
  assert.equal(BROWSER_DRIVER_SPECIFIER, '@zseven-w/dsh-browser');
});

test('a genuinely absent driver import is translated into a clear, actionable error', async () => {
  // A specifier that does not resolve triggers a real ERR_MODULE_NOT_FOUND,
  // exercising the exact catch-and-rethrow path the bundled server hits.
  await assert.rejects(
    loadBrowserManager('@zseven-w/dsh-browser-not-installed-fixture'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /@zseven-w\/dsh-browser/);
      assert.match(error.message, /install|provide|devDependency/i);
      assert.equal(error.cause?.code, 'ERR_MODULE_NOT_FOUND');
      return true;
    },
  );
});

test('missingBrowserDriverMessage names the package and how to provide it', () => {
  const message = missingBrowserDriverMessage(new Error('Cannot find package example'));
  assert.match(message, /@zseven-w\/dsh-browser/);
  assert.match(message, /install|provide/i);
  assert.match(message, /link:\.\.\/dsh-browser/);
});

test('isModuleNotFoundError recognizes ERR_MODULE_NOT_FOUND only', () => {
  assert.equal(
    isModuleNotFoundError(Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' })),
    true,
  );
  assert.equal(isModuleNotFoundError(new Error('x')), false);
  assert.equal(isModuleNotFoundError('not an error'), false);
});
