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

/** Browser driver contract this build is written against (BROWSER_DRIVER_CONTRACT_VERSION). */
export const SUPPORTED_BROWSER_CONTRACT_VERSION = 9;

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

/**
 * Refuse a driver whose contract version is not the one this build was written
 * against. A contract bump can change what an observation MEANS — which nodes
 * are emitted, what `truncated` covers, whether absence can be proven — so an
 * unknown driver does not degrade gracefully: it produces verdicts nobody can
 * interpret. Types cannot catch this, because they describe the sibling present
 * at build time while the loader imports whatever is installed at run time.
 *
 * Older is refused as firmly as newer. Browser contract v9 is what introduced
 * the closed-shadow-root coverage probe `node-absent` depends on; a v8 driver
 * would silently change what a passing absence assertion means.
 */
export function assertDriverContract(
  driver: { contractVersion?: unknown },
  supported: number,
  packageName: string,
  hint: string,
): void {
  const found = driver.contractVersion;
  if (found === supported) return;
  const describe = typeof found === 'number' ? String(found) : 'none (the driver reports no contractVersion)';
  throw new Error(
    'Refusing to use ' + packageName + ': it reports driver contract version ' + describe
    + ', and this build of @zseven-w/dsh-qa supports exactly version ' + String(supported) + '. '
    + 'A different contract can change what an observation means, so the evidence behind every '
    + 'verdict would be uninterpretable rather than merely degraded. ' + hint,
  );
}

export async function loadBrowserManager(
  specifier: string = BROWSER_DRIVER_SPECIFIER,
  options?: LoadBrowserManagerOptions,
  /** Seam for tests: substitute the dynamic import. */
  deps?: { importModule?: (specifier: string) => Promise<{ BrowserManager: new (options?: LoadBrowserManagerOptions) => ZSevenBrowserDriver }> },
): Promise<ZSevenBrowserDriver> {
  try {
    const importModule = deps?.importModule ?? ((id: string) => import(id));
    const { BrowserManager } = await importModule(specifier);
    const driver = new BrowserManager(options);
    assertDriverContract(
      driver as unknown as { contractVersion?: unknown },
      SUPPORTED_BROWSER_CONTRACT_VERSION,
      BROWSER_DRIVER_SPECIFIER,
      'Install a @zseven-w/dsh-browser release whose contract matches, or upgrade @zseven-w/dsh-qa.',
    );
    return driver;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingBrowserDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
