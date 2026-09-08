/**
 * iOS QA adapter over @zseven-w/dsh-ios/driver's IosQaBackend.
 *
 * Safety notes:
 *  - iOS fill/type are routed ONLY through the driver's native element-bound
 *    text methods (`typeTarget` append, `fillTarget` replace) when they are
 *    present. The adapter never sets `focused` and never calls raw global
 *    `type()`. If the live driver lacks the target-bound method, the primitive
 *    is explicitly unavailable even if a fake backend marks a node focused.
 *  - Target-bound mutations require the same fresh app/owner/ref/stable
 *    identifier/frame/secure validation as coordinate actions, and secure
 *    fields are rejected before any backend mutation is attempted.
 *  - Tap coordinates are device points; the driver exposes the same point
 *    space in IosQaObservation.screen and node frames.
 *  - A native targeted-text result with `dispatched:true` is possibly-sent and
 *    maps to a QA unknown receipt; it never becomes a confirmed success or a
 *    no-dispatch rejection.
 *  - Backend ActionResult.ok means native dispatch was accepted, never that
 *    the business outcome is known; this adapter returns unknown and the
 *    session core re-observes.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IosQaBackend,
  IosQaKey,
  IosQaNode,
  IosQaTargetedTextTarget,
} from '@zseven-w/dsh-ios/driver';
import type {
  QaStartOptions,
  QaObserveOptions,
} from '../session/adapter.ts';
import type {
  MobileForegroundResult,
  MobileNativeObservation,
  MobileOwnerSession,
  MobileRawNode,
  MobileTargetedTextMode,
  MobileTargetedTextResult,
  MobileTargetedTextTarget,
} from './mobile.ts';
import { MobileAdapterBase, QaCodeError } from './mobile.ts';
import type { IosSemanticTextType } from './mobile-types.ts';

const IOS_KEYS = new Set<string>(['home', 'lock', 'unlock', 'siri', 'volumeUp', 'volumeDown']);

// WDA's wda-uitree emits element types WITHOUT the AXe prefix
// (TextField/TextView/SearchField/SecureTextField) while the raw AXe path
// emits AX-prefixed roles (AXTextField/AXTextArea/AXSearchField/
// AXSecureTextField). Both spellings describe the same native elements, and
// the driver itself supports exactly TextField/TextView/SearchField as its
// nonsecure editable WDA types, so the prefix is normalized before deciding
// editability or security. This never fabricates identifiers and never
// changes dispatch-time identifier requirements.
function normalizedRole(role: string): string {
  return role.startsWith('AX') ? role.slice(2) : role;
}

function editableRole(role: string): boolean {
  const normalized = normalizedRole(role);
  return normalized === 'TextField' || normalized === 'TextArea' || normalized === 'TextView'
    || normalized === 'SearchField' || normalized === 'SecureTextField';
}

function secureRole(role: string): boolean {
  return normalizedRole(role) === 'SecureTextField';
}

/**
 * The native semantic editable type the dsh-ios WDA element-bound text
 * primitive accepts for one observed role. AXTextArea (raw AXe) and TextView
 * (WDA) are the SAME native element, so both map to TextView. Anything else —
 * including SecureTextField — is not a semantic text type.
 */
function semanticTextType(role: string): IosSemanticTextType | undefined {
  const normalized = normalizedRole(role);
  if (normalized === 'TextField') return 'TextField';
  if (normalized === 'TextArea' || normalized === 'TextView') return 'TextView';
  if (normalized === 'SearchField') return 'SearchField';
  return undefined;
}

function clean(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

export class IosAdapter extends MobileAdapterBase {
  readonly kind = 'ios' as const;
  readonly #backend: IosQaBackend;

  constructor(backend: IosQaBackend) {
    super();
    this.#backend = backend;
  }

  protected appIdFromOptions(options?: QaStartOptions): string {
    const bundleId = options?.bundleId?.trim() ?? '';
    if (bundleId === '') {
      throw new Error('iOS sessions require an explicit bundleId; refusing to infer an app from the connected device');
    }
    return bundleId;
  }

  protected async launchApp(deviceId: string, appId: string): Promise<void> {
    const result = await this.#backend.launchApp(deviceId, appId);
    if (!result.ok) {
      throw new QaCodeError(
        result.unsupported?.capability ?? 'IOS_LAUNCH_UNSUPPORTED',
        result.unsupported?.reason ?? `iOS launch refused for ${appId}`,
      );
    }
  }

  protected async readNativeObservation(
    deviceId: string,
    options: QaObserveOptions,
    _session: MobileOwnerSession,
  ): Promise<MobileNativeObservation> {
    const raw = await this.#backend.observe(deviceId, {
      ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    });
    if (raw.udid !== deviceId) {
      throw new QaCodeError('DEVICE_CHANGED', `backend observed udid ${raw.udid} but session is bound to ${deviceId}`);
    }
    const actualAppId = raw.app.bundleId === undefined ? undefined : raw.app.bundleId;
    const appPid = raw.app.pid;
    const verified = raw.app.verified === true && actualAppId === _session.appId;
    const detail = raw.app.verified === true
      ? (verified ? `native foreground ${actualAppId}` : `native foreground is ${actualAppId ?? 'unknown'}, expected ${_session.appId}`)
      : raw.app.name === undefined
        ? 'iOS backend did not provide a verified foreground app identity'
        : `iOS foreground unverified (name ${raw.app.name})`;
    return {
      deviceId: raw.udid,
      backendKind: raw.backend,
      ...(actualAppId === undefined ? {} : { actualAppId }),
      ...(appPid === undefined ? {} : { appPid }),
      verified,
      detail,
      screen: { width: raw.screen.width, height: raw.screen.height },
      coordinateSpace: 'point',
      nodes: raw.nodes.map((node) => this.#normalizeNode(node)),
      truncated: raw.truncated,
      maxNodes: raw.maxNodes,
      ...(raw.maxDepth === undefined ? {} : { maxDepth: raw.maxDepth }),
    };
  }

  protected async readNativeForeground(deviceId: string, appId: string): Promise<MobileForegroundResult> {
    const foreground = await this.#backend.foregroundApp(deviceId);
    const verified = foreground.app.verified === true && foreground.app.bundleId === appId;
    const detail = foreground.app.verified === true
      ? `native foreground ${foreground.app.bundleId ?? foreground.app.name ?? ''}`
      : foreground.unsupported?.reason ?? 'iOS backend could not verify the foreground app';
    return { backendKind: foreground.backend, verified, detail };
  }

  protected async nativeTap(deviceId: string, x: number, y: number): Promise<void> {
    const result = await this.#backend.tap(deviceId, x, y);
    this.#assertOk('tap', result);
  }

  protected async nativeType(deviceId: string, text: string): Promise<void> {
    const result = await this.#backend.type(deviceId, text);
    this.#assertOk('type', result);
  }

  protected async nativeScroll(deviceId: string, direction: 'up' | 'down', amount?: number): Promise<void> {
    const result = await this.#backend.scroll(deviceId, direction, amount);
    this.#assertOk('scroll', result);
  }

  protected async nativeKey(deviceId: string, key: string): Promise<void> {
    if (!IOS_KEYS.has(key)) {
      throw new QaCodeError('UNSUPPORTED_KEY', `iOS driver key must be one of ${[...IOS_KEYS].join(', ')}`);
    }
    const result = await this.#backend.key(deviceId, key as IosQaKey);
    this.#assertOk('key', result);
  }

  protected canTypeSafely(_session: MobileOwnerSession): boolean {
    // Raw AXe does not expose a reliably provable focused state. iOS type is
    // intentionally not routed through this raw focused/global-type path.
    return false;
  }

  protected supportsTargetedText(mode: MobileTargetedTextMode): boolean {
    return mode === 'type'
      ? typeof this.#backend.typeTarget === 'function'
      : typeof this.#backend.fillTarget === 'function';
  }

  /**
   * iOS identifier-less selector: the exact nonempty observed accessibility
   * name plus a native semantic editable type. The fresh node already
   * survived #findFreshTarget (unique role+name in the session's verified
   * app-owned fresh tree, enabled, nonsecure, frame-close); this additionally
   * requires a native semantic text role, editability, a non-hidden visibility
   * claim, and the exact observed name. No other platform, role, or label
   * ever yields a semantic selector — an identifier is never fabricated and
   * SecureTextField is never a candidate.
   */
  protected semanticTextSelector(
    fresh: MobileRawNode,
    original: { name: string },
  ): { label: string; type: string } | undefined {
    const type = semanticTextType(fresh.role);
    // Only NONEMPTINESS is validated from a trimmed copy; the label forwarded
    // to the driver is the exact observed accessibility name, whitespace and
    // all — the semantic match is exact, never normalized.
    if (type === undefined || fresh.name.trim() === '') return undefined;
    if (!fresh.editable) return undefined;
    if (fresh.visible === false) return undefined;
    if (fresh.disabled || fresh.secure === true) return undefined;
    if (original.name !== fresh.name) return undefined;
    return { label: fresh.name, type };
  }

  protected async runTargetedText(
    mode: MobileTargetedTextMode,
    target: MobileTargetedTextTarget,
  ): Promise<MobileTargetedTextResult> {
    // Use the sibling's actual contract so interface drift is a compile error.
    const nativeTarget: IosQaTargetedTextTarget = {
      udid: target.udid,
      bundleId: target.bundleId,
      ...(target.identifier === undefined ? {} : { identifier: target.identifier }),
      ...(target.semantic === undefined ? {} : { semantic: { label: target.semantic.label, type: target.semantic.type } }),
      frame: { x: target.frame.x, y: target.frame.y, width: target.frame.width, height: target.frame.height },
      text: target.text,
      ...(target.expectedPID === undefined ? {} : { expectedPID: target.expectedPID }),
      ...(target.secure === undefined ? {} : { secure: target.secure }),
    };
    const result = mode === 'type'
      ? await this.#backend.typeTarget(nativeTarget)
      : await this.#backend.fillTarget(nativeTarget);
    return {
      status: result.status,
      dispatched: result.dispatched,
      nativeAccepted: result.nativeAccepted,
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }

  protected async cleanupDeviceForStop(session: MobileOwnerSession): Promise<void> {
    if (typeof this.#backend.releaseDevice !== 'function') return;
    await this.#backend.releaseDevice(session.deviceId);
  }

  protected async capturePng(deviceId: string): Promise<{ png: Uint8Array; width: number; height: number; sha256: string; artifactPath: string }> {
    const shot = await this.#backend.screenshot(deviceId);
    const png = Buffer.from(shot.pngBase64, 'base64');
    const size = this.#pngSize(png, shot.width, shot.height);
    const artifactPath = join(tmpdir(), `dsh-qa-ios-${deviceId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${Date.now()}.png`);
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

  #normalizeNode(node: IosQaNode): MobileRawNode {
    const role = clean(node.type);
    const editable = editableRole(role);
    // A SecureTextField role forces secure classification even when the
    // backend's secure flag is absent or contradicts it; role-based
    // classification can only ADD security, never downgrade it.
    const secure = node.secure === true || secureRole(role) ? true : node.secure === false ? false : null;
    const enabled = node.enabled !== false;
    const clickable = enabled && (role.startsWith('AXButton') || role.includes('Button') || role.includes('Cell')
      || role.includes('Link') || role.includes('MenuItem') || role.includes('Tab'));
    const identifier = clean(node.identifier);
    const raw: MobileRawNode = {
      ...(identifier === '' ? {} : { identifier }),
      role: role || 'AXUnknown',
      name: clean(node.name),
      tag: identifier,
      frame: { x: node.frame.x, y: node.frame.y, width: node.frame.width, height: node.frame.height },
      enabled,
      disabled: node.enabled === false,
      editable,
      interactive: enabled && (editable || clickable || role !== ''),
      ...(node.visible === undefined ? {} : { visible: node.visible }),
      focused: node.focused === true ? true : node.focused === false ? false : null,
      secure,
      ...(node.value !== undefined && secure !== true ? { value: node.value } : {}),
      clickable,
      scrollable: false,
    };
    return raw;
  }

  #assertOk(action: string, result: { ok: boolean; unsupported?: { capability: string; reason: string } }): void {
    if (!result.ok) {
      throw new QaCodeError(
        result.unsupported?.capability ?? `IOS_${action.toUpperCase()}_UNSUPPORTED`,
        result.unsupported?.reason ?? `iOS ${action} was refused by the backend`,
      );
    }
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
    throw new Error('iOS screenshot did not include dimensions and the bytes are not a parseable PNG');
  }
}
