// Lazy loader for the @zseven-w/dsh-ios QA backend subpath.
//
// The sibling iOS driver is a dev/test-only linkage (`link:../dsh-ios` in
// devDependencies), never a runtime dependency, and it stays external in the
// MCP/plugin bundles. QA imports `@zseven-w/dsh-ios/driver` only when a qa_*
// ios tool actually runs. When the package/subpath is absent we translate the
// module-resolution failure into a clear actionable error instead of leaking
// the raw error.

import type { IosQaBackend } from '@zseven-w/dsh-ios/driver';
import { isModuleNotFoundError } from './loadBrowser.ts';

export const IOS_DRIVER_SPECIFIER = '@zseven-w/dsh-ios/driver';

export function missingIosDriverMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    'Cannot load the iOS driver @zseven-w/dsh-ios/driver: it is not installed or the package does not export /driver. ' +
    'dsh-qa loads it lazily and keeps it external in the bundle, so initialize and tools/list work without it, but qa_* ios tools need it at runtime. ' +
    'Provide @zseven-w/dsh-ios alongside this plugin (local development: keep the "link:../dsh-ios" devDependency; host installs: the DSH host supplies it). ' +
    'Underlying error: ' + detail
  );
}

export async function loadIosBackend(
  specifier: string = IOS_DRIVER_SPECIFIER,
): Promise<IosQaBackend> {
  try {
    const { createIosQaBackend } = await import(specifier);
    return createIosQaBackend();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingIosDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
