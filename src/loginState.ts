// Owner-authorized, scoped, read-only login-state injection (WP11).
//
// The QA session starts a FRESH ephemeral profile pre-loaded with login state
// (cookies + localStorage) for EXPLICITLY authorized origins only, from a
// source the owner explicitly designated. There is deliberately NO ambient
// discovery: no profile scanning, no default-profile reads, and no directory
// source — only an explicit state-file path in Playwright storageState JSON
// format (cookies + origins/localStorage), which the owner exports themselves
// or generates with the documented helper.
//
// Fail-closed rules implemented here:
//   - the file is read, parsed, and filtered IN MEMORY, then dropped — it is
//     never copied into the session profile or any temp directory;
//   - inject ONLY entries whose origin/domain exactly matches the authorized
//     origins list. Cookie domain matching is exact host or the dot-prefixed
//     spelling of that exact host (.example.com for the listed example.com) —
//     never a wildcard, never a parent, never a sibling;
//   - a file that fails to parse, contains no authorized entries, or contains
//     entries the filter cannot classify makes session start FAIL. Partial or
//     ambiguous state is never injected silently;
//   - error messages name counts and origins only. They never name cookie
//     names or values, and never echo the source path.

import { readFile } from 'node:fs/promises'

/** Explicit authorization config passed at session start. */
export interface QaLoginStateConfig {
  /** Path to a Playwright storageState JSON file the owner exported themselves. */
  source: string
  /** Exact origins (scheme + host + optional port) whose entries may be injected. */
  origins: readonly string[]
}

export interface QaStorageCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface QaOriginStorage {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

/** Filtered storageState handed to the driver (Playwright storageState shape). */
export interface QaStorageState {
  cookies: QaStorageCookie[]
  origins: QaOriginStorage[]
}

export class LoginStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginStateError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new LoginStateError(message)
}

/**
 * Validates one authorized-origin entry WITHOUT echoing its value bytes: the
 * error names the structural position and the required shape only. Mirrors the
 * fail-closed loader discipline in src/replay/loader.ts.
 */
function normalizeAuthorizedOrigin(value: unknown, position: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(position + ' must be a non-empty exact origin')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    fail(position + ' must be an exact http(s) origin (scheme + host + optional port)')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(position + ' must use http or https')
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail(position + ' must be an exact origin (scheme + host + optional port, no path/query/userinfo)')
  }
  return parsed.origin
}

/**
 * Validates and normalizes a loginState config object. Used both by the
 * scenario loader (fail-closed on malformed entries) and by loadLoginState.
 * Never echoes the source path or any origin value.
 */
export function validateLoginStateConfig(value: unknown, position = 'loginState'): QaLoginStateConfig {
  if (!isPlainObject(value)) fail(position + ' must be an object with { source, origins }')
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (key !== 'source' && key !== 'origins') fail(position + ' has an unexpected field')
  }
  const source = obj.source
  if (typeof source !== 'string' || source.trim() === '') {
    fail(position + '.source must be a non-empty path string')
  }
  const originsRaw = obj.origins
  if (!Array.isArray(originsRaw) || originsRaw.length === 0) {
    fail(position + '.origins must be a non-empty array of exact origins')
  }
  const origins: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < originsRaw.length; i += 1) {
    const normalized = normalizeAuthorizedOrigin(originsRaw[i], position + '.origins[' + i + ']')
    if (seen.has(normalized)) continue
    seen.add(normalized)
    origins.push(normalized)
  }
  return { source, origins }
}

function hostnameOf(origin: string): string {
  return new URL(origin).hostname.toLowerCase()
}

/** Exact host match: domain (with optional leading dot) equals a listed host. */
function cookieDomainMatches(domain: string, hosts: ReadonlySet<string>): boolean {
  const bare = domain.startsWith('.') ? domain.slice(1) : domain
  return hosts.has(bare)
}

function expectStringField(obj: Record<string, unknown>, key: string, position: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.trim() === '') {
    fail(position + '.' + key + ' must be a non-empty string')
  }
  return value
}

function expectBooleanField(obj: Record<string, unknown>, key: string, position: string): boolean {
  const value = obj[key]
  if (typeof value !== 'boolean') fail(position + '.' + key + ' must be a boolean')
  return value
}

function expectFiniteNumberField(obj: Record<string, unknown>, key: string, position: string): number {
  const value = obj[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(position + '.' + key + ' must be a finite number')
  }
  return value
}

function validateCookie(value: unknown, position: string): QaStorageCookie {
  if (!isPlainObject(value)) fail(position + ' must be an object')
  const obj = value as Record<string, unknown>
  const name = expectStringField(obj, 'name', position)
  const rawValue = obj.value
  if (typeof rawValue !== 'string') fail(position + '.value must be a string')
  const domain = expectStringField(obj, 'domain', position).toLowerCase()
  if (/[\/\s:;,]/.test(domain)) fail(position + '.domain is not classifiable as a host')
  const path = expectStringField(obj, 'path', position)
  const expires = expectFiniteNumberField(obj, 'expires', position)
  const httpOnly = expectBooleanField(obj, 'httpOnly', position)
  const secure = expectBooleanField(obj, 'secure', position)
  const sameSite = obj.sameSite
  if (sameSite !== 'Strict' && sameSite !== 'Lax' && sameSite !== 'None') {
    fail(position + '.sameSite must be "Strict", "Lax", or "None"')
  }
  return { name, value: rawValue, domain, path, expires, httpOnly, secure, sameSite }
}

function validateLocalStorageItem(value: unknown, position: string): { name: string; value: string } {
  if (!isPlainObject(value)) fail(position + ' must be an object')
  const obj = value as Record<string, unknown>
  const name = expectStringField(obj, 'name', position)
  const rawValue = obj.value
  if (typeof rawValue !== 'string') fail(position + '.value must be a string')
  return { name, value: rawValue }
}

function validateOriginStorage(value: unknown, position: string): QaOriginStorage {
  if (!isPlainObject(value)) fail(position + ' must be an object')
  const obj = value as Record<string, unknown>
  const origin = normalizeAuthorizedOrigin(obj.origin, position + '.origin')
  const localStorageRaw = obj.localStorage
  if (!Array.isArray(localStorageRaw)) fail(position + '.localStorage must be an array')
  const localStorage = localStorageRaw.map((item, i) =>
    validateLocalStorageItem(item, position + '.localStorage[' + i + ']'),
  )
  return { origin, localStorage }
}

function validateStateShape(value: unknown): { cookies: QaStorageCookie[]; origins: QaOriginStorage[] } {
  if (!isPlainObject(value)) fail('login-state file must be a JSON object')
  const obj = value as Record<string, unknown>
  const cookiesRaw = obj.cookies
  const originsRaw = obj.origins
  if (!Array.isArray(cookiesRaw)) fail('login-state file must contain a cookies array')
  if (!Array.isArray(originsRaw)) fail('login-state file must contain an origins array')
  const cookies = cookiesRaw.map((item, i) => validateCookie(item, 'cookies[' + i + ']'))
  const origins = originsRaw.map((item, i) => validateOriginStorage(item, 'origins[' + i + ']'))
  return { cookies, origins }
}

/**
 * Reads, validates, and filters an owner-exported Playwright storageState file
 * for the authorized origins. Returns only the entries whose domain/origin
 * exactly matches the authorized list; throws LoginStateError otherwise. The
 * file contents are read into memory and dropped — never copied to disk.
 */
export async function loadLoginState(config: QaLoginStateConfig): Promise<QaStorageState> {
  const { source, origins } = validateLoginStateConfig(config)
  const hosts = new Set(origins.map(hostnameOf))
  const originSet = new Set(origins)

  let text: string
  try {
    text = await readFile(source, 'utf8')
  } catch {
    fail('login-state source file is not readable')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('login-state source file is not valid JSON')
  }

  const { cookies, origins: stateOrigins } = validateStateShape(parsed)

  const authorizedCookies = cookies.filter((cookie) => cookieDomainMatches(cookie.domain, hosts))
  const authorizedOrigins = stateOrigins.filter((entry) => originSet.has(entry.origin))

  const totalEntries = cookies.length + stateOrigins.length
  const injectedEntries = authorizedCookies.length + authorizedOrigins.length
  if (injectedEntries === 0) {
    fail(
      'login-state file contains no entries for the authorized origins (' +
      totalEntries + ' entr' + (totalEntries === 1 ? 'y' : 'ies') +
      ' examined; ' + origins.length + ' origin' + (origins.length === 1 ? '' : 's') + ' authorized)',
    )
  }

  return { cookies: authorizedCookies, origins: authorizedOrigins }
}
