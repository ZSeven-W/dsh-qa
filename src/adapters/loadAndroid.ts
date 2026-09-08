// Lazy loader for the @zseven-w/dsh-android QA backend subpath.
//
// The sibling Android driver is a dev/test-only linkage (`link:../dsh-android`
// in devDependencies), never a runtime dependency, and it stays external in the
// MCP/plugin bundles. QA imports `@zseven-w/dsh-android/driver` only when a
// qa_* android tool actually runs. A missing package/subpath is translated into
// a clear actionable error, exactly like the browser/computer/mobile loaders.

import type { AndroidQaBackend } from '@zseven-w/dsh-android/driver';
import { isModuleNotFoundError } from './loadBrowser.ts';

export const ANDROID_DRIVER_SPECIFIER = '@zseven-w/dsh-android/driver';

export function missingAndroidDriverMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    'Cannot load the Android driver @zseven-w/dsh-android/driver: it is not installed or the package does not export /driver. ' +
    'dsh-qa loads it lazily and keeps it external in the bundle, so initialize and tools/list work without it, but qa_* android tools need it at runtime. ' +
    'Provide @zseven-w/dsh-android alongside this plugin (local development: keep the "link:../dsh-android" devDependency; host installs: the DSH host supplies it). ' +
    'Underlying error: ' + detail
  );
}

export async function loadAndroidBackend(
  specifier: string = ANDROID_DRIVER_SPECIFIER,
): Promise<AndroidQaBackend> {
  try {
    const { createAndroidQaBackend } = await import(specifier);
    return createAndroidQaBackend();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(missingAndroidDriverMessage(error), { cause: error });
    }
    throw error;
  }
}
