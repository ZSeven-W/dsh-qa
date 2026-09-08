// Shared driver-execution seam for Replay (WP4/WP6). Both the Cordis tool
// layer (src/tools.ts) and the MCP server (src/server.mjs) use this module to
// map a scenario's driver kind to the concrete adapter and the launch/start
// options, so the four dispatch paths cannot drift.
//
// The sibling drivers stay external and are imported lazily at runtime with
// the same clear missing-package errors the Explore loaders already produce.
// The mobile ADAPTER classes live in src/adapters/** (adapter worker); they
// are loaded from the adapter barrel only when a mobile scenario/Explore
// session is actually used. That keeps this module type-correct and runtime-
// eager-import free before and after the adapter worker lands.

import type { ZSevenBrowserDriver } from '@zseven-w/dsh-browser';
import type { ComputerDriver } from '@zseven-w/dsh-computer';
import type { AndroidQaBackend } from '@zseven-w/dsh-android/driver';
import type { IosQaBackend } from '@zseven-w/dsh-ios/driver';
import type { QaScenario } from '../contracts.ts';
import type { QaDriverAdapter, QaStartOptions } from '../session/adapter.ts';
import { BrowserAdapter } from '../adapters/browser.ts';
import { ComputerAdapter } from '../adapters/computer.ts';
import { BROWSER_DRIVER_SPECIFIER, loadBrowserManager, type LoadBrowserManagerOptions } from '../adapters/loadBrowser.ts';
import { COMPUTER_DRIVER_SPECIFIER, loadComputerDriver } from '../adapters/loadComputer.ts';
import {
  ANDROID_DRIVER_SPECIFIER,
  loadAndroidBackend,
  missingAndroidDriverMessage,
} from '../adapters/loadAndroid.ts';
import {
  IOS_DRIVER_SPECIFIER,
  loadIosBackend,
  missingIosDriverMessage,
} from '../adapters/loadIos.ts';

export type BrowserDriverLoader = (
  specifier?: string,
  options?: LoadBrowserManagerOptions,
) => Promise<ZSevenBrowserDriver>;

export type ComputerDriverLoader = (specifier?: string) => Promise<ComputerDriver>;

export type IosDriverLoader = (specifier?: string) => Promise<IosQaBackend>;

export type AndroidDriverLoader = (specifier?: string) => Promise<AndroidQaBackend>;

/** Injectable loaders (test/di seam) for the four sibling drivers. */
export interface ReplayDriverLoaders {
  browser?: BrowserDriverLoader;
  computer?: ComputerDriverLoader;
  ios?: IosDriverLoader;
  android?: AndroidDriverLoader;
}

/** A loaded driver adapter plus the teardown the dispatch path owns. */
export interface LoadedReplayDriver {
  adapter: QaDriverAdapter;
  dispose(): Promise<void>;
}

/** The adapter worker's constructor shape, loaded lazily from the barrel. */
interface QaMobileAdapterConstructor {
  new (backend: IosQaBackend | AndroidQaBackend): QaDriverAdapter;
}

async function loadMobileAdapter(kind: 'ios' | 'android'): Promise<QaMobileAdapterConstructor> {
  const barrel = await import('../adapters/index.ts');
  const exportName = kind === 'ios' ? 'IosAdapter' : 'AndroidAdapter';
  const ctor = (barrel as unknown as Record<string, unknown>)[exportName];
  if (typeof ctor !== 'function') {
    const missing = kind === 'ios' ? missingIosDriverMessage : missingAndroidDriverMessage;
    throw new Error(missing(new Error(exportName + ' is not exported by src/adapters/index.ts yet; the adapter worker must add it before mobile replay can run.')));
  }
  return ctor as QaMobileAdapterConstructor;
}

/**
 * Map a scenario's launch target to the adapter start options its driver kind
 * expects. Browser -> url (+ headless + login state); computer -> bundle id
 * (+ the recorded durable window title); ios -> bundle id + explicit device;
 * android -> package name + explicit device. Ephemeral selectors (PID, window
 * number, coordinates, emulator serial as a globally durable identity) are
 * never produced here: an explicit device_id is only ever an exact routing
 * selector for the recorded app/session, and replay always rebinds the actual
 * app/device at launch.
 */
export function scenarioStartOptions(
  scenario: QaScenario,
  launch: string,
  headless?: boolean,
  deviceOverride?: string,
): QaStartOptions {
  if (scenario.meta.driver === 'computer') {
    return {
      bundleId: launch,
      ...(scenario.target.windowTitle === undefined ? {} : { windowTitle: scenario.target.windowTitle }),
    };
  }
  if (scenario.meta.driver === 'ios') {
    return {
      bundleId: launch,
      ...(deviceOverride === undefined && scenario.target.deviceId === undefined
        ? {}
        : { deviceId: deviceOverride ?? scenario.target.deviceId as string }),
    };
  }
  if (scenario.meta.driver === 'android') {
    return {
      packageName: launch,
      ...(deviceOverride === undefined && scenario.target.deviceId === undefined
        ? {}
        : { deviceId: deviceOverride ?? scenario.target.deviceId as string }),
    };
  }
  return {
    url: launch,
    ...(headless === undefined ? {} : { headless }),
    ...(scenario.target.loginState === undefined ? {} : { loginState: scenario.target.loginState }),
  };
}

/**
 * Load the concrete driver for a scenario and wrap it in the QA adapter.
 * Browser keeps origin allow-listing; computer wraps ComputerController;
 * ios/android load the lazy mobile backend and wrap it with the adapter-worker
 * adapter. Any loader can be replaced via `options.loaders` for deterministic
 * tests.
 */
export async function loadReplayDriver(
  scenario: QaScenario,
  options: { loaders?: ReplayDriverLoaders } = {},
): Promise<LoadedReplayDriver> {
  const loaders = options.loaders ?? {};
  if (scenario.meta.driver === 'computer') {
    const load = loaders.computer ?? loadComputerDriver;
    const driver = await load(COMPUTER_DRIVER_SPECIFIER);
    const adapter = new ComputerAdapter(driver);
    return { adapter, dispose: () => driver.dispose() };
  }
  if (scenario.meta.driver === 'ios') {
    const load = loaders.ios ?? loadIosBackend;
    const backend = await load(IOS_DRIVER_SPECIFIER);
    const IosAdapter = await loadMobileAdapter('ios');
    const adapter = new IosAdapter(backend);
    return { adapter, dispose: () => backend.dispose() };
  }
  if (scenario.meta.driver === 'android') {
    const load = loaders.android ?? loadAndroidBackend;
    const backend = await load(ANDROID_DRIVER_SPECIFIER);
    const AndroidAdapter = await loadMobileAdapter('android');
    const adapter = new AndroidAdapter(backend);
    return { adapter, dispose: () => backend.dispose() };
  }
  const load = loaders.browser ?? loadBrowserManager;
  let origin: string | undefined;
  try {
    origin = new URL(scenario.target.launch).origin;
  } catch {
    origin = undefined;
  }
  const manager = await load(BROWSER_DRIVER_SPECIFIER, origin === undefined ? undefined : { allowedOrigins: [origin] });
  const adapter = new BrowserAdapter(manager);
  return { adapter, dispose: () => manager.dispose() };
}
