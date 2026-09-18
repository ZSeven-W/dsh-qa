// Lazy loader for the @zseven-w/dsh-computer driver.
//
// The sibling computer driver is a dev/test-only linkage (`link:../dsh-computer`
// in devDependencies), never a runtime dependency, and it stays external in the
// MCP bundle. The qa_* computer tools import it only when they actually run, so
// a node_modules-free plugin copy still serves initialize and tools/list
// without the driver installed. When the driver is genuinely absent, the
// dynamic import throws ERR_MODULE_NOT_FOUND; we translate that into a clear,
// actionable error naming the missing package and how to provide it instead of
// leaking the bare module-resolution failure.

import type { ComputerDriver } from '@zseven-w/dsh-computer';
import { isModuleNotFoundError } from './loadBrowser.ts';

export const COMPUTER_DRIVER_SPECIFIER = '@zseven-w/dsh-computer';

/** Computer driver contract this build is written against (COMPUTER_DRIVER_CONTRACT_VERSION). */
export const SUPPORTED_COMPUTER_CONTRACT_VERSION = 5;

export function missingComputerDriverMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    'Cannot load the computer driver @zseven-w/dsh-computer: it is not installed. ' +
    'dsh-qa loads it lazily and keeps it external in the bundle, so initialize and ' +
    'tools/list work without it, but the qa_* computer tools need it at runtime. ' +
    'Provide it by installing @zseven-w/dsh-computer alongside this plugin ' +
    '(for local development keep the "link:../dsh-computer" devDependency; for a host ' +
    'install the DSH host supplies it), then retry. Underlying error: ' + detail
  );
}

import { assertDriverContract } from './loadBrowser.ts';

export async function loadComputerDriver(
  specifier: string = COMPUTER_DRIVER_SPECIFIER,
  /** Seam for tests: substitute the dynamic import. */
  deps?: { importModule?: (specifier: string) => Promise<{ ComputerController: new () => ComputerDriver }> },
): Promise<ComputerDriver> {
  try {
    const importModule = deps?.importModule ?? ((id: string) => import(id));
    const { ComputerController } = await importModule(specifier);
    const driver = new ComputerController();
    assertDriverContract(
      driver as unknown as { contractVersion?: unknown },
      SUPPORTED_COMPUTER_CONTRACT_VERSION,
      COMPUTER_DRIVER_SPECIFIER,
      'Install a @zseven-w/dsh-computer release whose contract matches, or upgrade @zseven-w/dsh-qa.',
    );
    return driver;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingComputerDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
