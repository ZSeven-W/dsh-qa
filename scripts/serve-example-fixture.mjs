// Serves the shipped web fixture (fixtures/web/) on an ephemeral 127.0.0.1
// port and prints the URL. This is the tiny published helper that makes the
// shipped example reproducible on a normal install: the scenario's launch URL
// is an example default, and this server lets a runner bind a live loopback
// origin instead of depending on a hardcoded port (7399) that may be taken or
// firewalled.
//
//   node scripts/serve-example-fixture.mjs
//
// It binds 127.0.0.1:0 (the OS chooses a free port), serves ONLY the files
// inside fixtures/web/, answers the fixture's synthetic /api/probe fetch, and
// exports startExampleServer() + listenOnEphemeralPort() so run-example.mjs
// reuses the exact same serving logic.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(ROOT, 'fixtures', 'web');
const INDEX_PATH = join(FIXTURE_DIR, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Reads the fixture entry, failing with an actionable message when the
 *  published package is missing fixtures/web/ (QA-BL-001 packaging regression). */
function loadIndexHtml() {
  if (!existsSync(INDEX_PATH)) {
    throw new Error(
      'the shipped web fixture is missing: ' + INDEX_PATH + ' was not found.\n' +
      'This package was published without its fixtures/web/ directory. ' +
      'Reinstall from a build whose package.json "files" includes fixtures/web.',
    );
  }
  return readFileSync(INDEX_PATH, 'utf8');
}

/** Creates an HTTP server bound to the shipped fixture directory. */
export function startExampleServer() {
  const indexHtml = loadIndexHtml();
  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/probe') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    // resolve('.') + a startsWith guard keeps reads inside FIXTURE_DIR only.
    const candidate = resolve(FIXTURE_DIR, '.' + pathname);
    if (candidate.startsWith(FIXTURE_DIR + '/') && existsSync(candidate) && statSync(candidate).isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
      res.end(readFileSync(candidate));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
  });
  return { server, fixtureDir: FIXTURE_DIR };
}

/** Binds the server to 127.0.0.1:0 and resolves the chosen port. */
export function listenOnEphemeralPort(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('ephemeral listener did not bind to a TCP port'));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

// Standalone mode: serve until interrupted and print the loopback origin.
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const { server, fixtureDir } = startExampleServer();
  const port = await listenOnEphemeralPort(server);
  console.log('http://127.0.0.1:' + port);
  console.error('serving ' + fixtureDir + ' on http://127.0.0.1:' + port + ' (Ctrl-C to stop)');
}
