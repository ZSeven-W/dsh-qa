// Lazy loader for the @zseven-w/dsh-browser driver.
//
// The sibling browser driver is a dev/test-only linkage (`link:../dsh-browser`
// in devDependencies), never a runtime dependency, and it stays external in the
// MCP bundle. The qa_* browser tools import it only when they actually run, so
// a node_modules-free plugin copy still serves initialize and tools/list
// without the driver installed. When the driver is genuinely absent, the
// dynamic import throws ERR_MODULE_NOT_FOUND; we translate that into a clear,
// actionable error naming the missing package and how to provide it instead of
// leaking the bare module-resolution failure.

import type { ZSevenBrowserDriver } from '@zseven-w/dsh-browser';

export const BROWSER_DRIVER_SPECIFIER = '@zseven-w/dsh-browser';

export interface LoadBrowserManagerOptions {
  rootDir?: string;
  allowedOrigins?: readonly string[];
}

export function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
  );
}

export function missingBrowserDriverMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    'Cannot load the browser driver @zseven-w/dsh-browser: it is not installed. ' +
    'dsh-qa loads it lazily and keeps it external in the bundle, so initialize and ' +
    'tools/list work without it, but the qa_* browser tools need it at runtime. ' +
    'Provide it by installing @zseven-w/dsh-browser alongside this plugin ' +
    '(for local development keep the "link:../dsh-browser" devDependency; for a host ' +
    'install the DSH host supplies it), then retry. Underlying error: ' + detail
  );
}

export async function loadBrowserManager(
  specifier: string = BROWSER_DRIVER_SPECIFIER,
  options?: LoadBrowserManagerOptions,
): Promise<ZSevenBrowserDriver> {
  try {
    const { BrowserManager } = await import(specifier);
    return new BrowserManager(options);
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingBrowserDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
