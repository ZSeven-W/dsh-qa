/**
 * Android QA adapter over @zseven-w/dsh-android/driver's AndroidQaBackend.
 *
 * Safety notes:
 *  - Android uiautomator exposes a real `focused` flag. Typing is allowed only
 *    after the target is verifiably focused (nonsecure); if it is not focused
 *    the adapter taps it, re-reads the native tree, and verifies the SAME
 *    target is focused before calling backend.type.
 *  - Tap/scroll coordinates are display pixels. observe() and screenshot()
 *    report actual native dimensions; this adapter never guesses scale or
 *    rotation compensation.
 *  - backend methods resolve when the native command was accepted; they are
 *    never business success. This adapter returns status unknown and lets the
 *    session core decide by post-observe.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AndroidQaBackend, AndroidQaNode } from '@zseven-w/dsh-android/driver';
import type {
  QaStartOptions,
  QaObserveOptions,
} from '../session/adapter.ts';
import type { MobileForegroundResult, MobileNativeObservation, MobileOwnerSession, MobileRawNode } from './mobile.ts';
import { MobileAdapterBase, QaCodeError } from './mobile.ts';

function clean(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

function androidBackendKind(serial: string): 'emulator' | 'device' {
  return serial.startsWith('emulator-') ? 'emulator' : 'device';
}

function editableNode(node: AndroidQaNode): boolean {
  return node.role === 'EditText' || node.className.includes('EditText');
}

export class AndroidAdapter extends MobileAdapterBase {
  readonly kind = 'android' as const;
  readonly #backend: AndroidQaBackend;

  constructor(backend: AndroidQaBackend) {
    super();
    this.#backend = backend;
  }

  protected appIdFromOptions(options?: QaStartOptions): string {
    const packageName = options?.packageName?.trim() ?? options?.bundleId?.trim() ?? '';
    if (packageName === '') {
      throw new Error('Android sessions require an explicit packageName (or bundleId fallback); refusing to infer an app');
    }
    return packageName;
  }

  protected async launchApp(deviceId: string, appId: string): Promise<void> {
    await this.#backend.launchApp(deviceId, appId);
  }

  protected async readNativeObservation(
    deviceId: string,
    options: QaObserveOptions,
    session: MobileOwnerSession,
  ): Promise<MobileNativeObservation> {
    const raw = await this.#backend.observe(deviceId, {
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    });
    if (raw.serial !== deviceId) {
      throw new QaCodeError('DEVICE_CHANGED', `backend observed serial ${raw.serial} but session is bound to ${deviceId}`);
    }
    const actualAppId = raw.packageName ?? raw.foreground?.packageName;
    const verified = raw.readError === undefined
      && actualAppId !== undefined
      && actualAppId === session.appId
      && (raw.foreground !== undefined || raw.packageName !== undefined);
    const detail = raw.readError === undefined
      ? (verified ? `native foreground ${actualAppId}` : `native foreground is ${actualAppId ?? 'unknown'}, expected ${session.appId}`)
      : raw.readError;
    return {
      deviceId: raw.serial,
      backendKind: androidBackendKind(raw.serial),
      ...(actualAppId === undefined ? {} : { actualAppId }),
      verified,
      detail,
      screen: { width: raw.screen.width, height: raw.screen.height },
      coordinateSpace: raw.coordinateSpace,
      nodes: raw.nodes.map((node) => this.#normalizeNode(node)),
      truncated: raw.truncated,
    };
  }

  protected async readNativeForeground(deviceId: string, appId: string): Promise<MobileForegroundResult> {
    const foreground = await this.#backend.foregroundApp(deviceId);
    const verified = foreground.packageName !== undefined && foreground.packageName === appId;
    const detail = foreground.packageName === undefined
      ? `Android foreground read returned no package name (raw: ${foreground.raw || ''})`
      : `native foreground ${foreground.packageName}${foreground.activity === undefined ? '' : ` (${foreground.activity})`}`;
    return { backendKind: androidBackendKind(deviceId), verified, detail };
  }

  protected async nativeTap(deviceId: string, x: number, y: number): Promise<void> {
    await this.#backend.tap(deviceId, x, y);
  }

  protected async nativeType(deviceId: string, text: string): Promise<void> {
    await this.#backend.type(deviceId, text);
  }

  protected async nativeScroll(deviceId: string, direction: 'up' | 'down', amount?: number): Promise<void> {
    await this.#backend.scroll(deviceId, direction, amount);
  }

  protected async nativeKey(deviceId: string, key: string): Promise<void> {
    await this.#backend.key(deviceId, key);
  }

  protected canTypeSafely(_session: MobileOwnerSession): boolean {
    return true;
  }

  protected async capturePng(deviceId: string): Promise<{ png: Uint8Array; width: number; height: number; sha256: string; artifactPath: string }> {
    const shot = await this.#backend.screenshot(deviceId);
    const png = shot.png;
    const size = this.#pngSize(png, shot.width, shot.height);
    const artifactPath = join(tmpdir(), `dsh-qa-android-${deviceId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${Date.now()}.png`);
    writeFileSync(artifactPath, png);
    return {
      png: new Uint8Array(png),
      width: size.width,
      height: size.height,
      sha256: createHash('sha256').update(png).digest('hex'),
      artifactPath,
    };
  }

  protected async disposeBackend(): Promise<void> {
    await this.#backend.dispose();
  }

  #normalizeNode(node: AndroidQaNode): MobileRawNode {
    const role = node.role;
    const resourceId = clean(node.resourceId);
    const secure = node.password === true;
    const editable = editableNode(node);
    const name = secure ? '' : clean(node.name ?? node.text ?? node.contentDesc);
    const value = secure ? undefined : node.text === undefined ? undefined : node.text;
    const clickable = node.clickable === true;
    const raw: MobileRawNode = {
      ...(resourceId === '' ? {} : { identifier: resourceId }),
      role: role || 'android.widget.View',
      name,
      tag: resourceId,
      frame: { x: node.frame.x, y: node.frame.y, width: node.frame.width, height: node.frame.height },
      enabled: node.enabled,
      disabled: !node.enabled,
      editable,
      interactive: node.enabled && (clickable || editable || node.scrollable || role === 'Button'),
      focused: typeof node.focused === 'boolean' ? node.focused : null,
      secure: secure ? true : false,
      ...(value === undefined ? {} : { value }),
      clickable,
      scrollable: node.scrollable === true,
      ...(node.children.length > 0 ? { children: node.children.map((child) => this.#normalizeNode(child)) } : {}),
    };
    return raw;
  }

  #pngSize(png: Buffer, width: number | undefined, height: number | undefined): { width: number; height: number } {
    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
      return { width, height };
    }
    if (png.length >= 24 && png.toString('ascii', 1, 4) === 'PNG') {
      const parsedWidth = png.readUInt32BE(16);
      const parsedHeight = png.readUInt32BE(20);
      if (parsedWidth > 0 && parsedHeight > 0) return { width: parsedWidth, height: parsedHeight };
    }
    throw new Error('Android screenshot did not include dimensions and the bytes are not a parseable PNG');
  }
}
