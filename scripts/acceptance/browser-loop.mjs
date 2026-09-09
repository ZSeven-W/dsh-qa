// Compatibility entrypoint. Browser acceptance uses the real direct ToolRuntime.
process.argv.push('--browser-loop', '--driver', 'dsh-browser')
await import('./host-direct.mjs')
