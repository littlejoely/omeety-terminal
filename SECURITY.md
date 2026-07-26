# Security

Omeety Terminal bridges a browser extension to a real local shell. Treat the
unpacked extension and its Native Messaging host as software with full access to
your user account.

- Review changes before loading or updating the extension.
- The MCP server binds to `127.0.0.1`; do not expose its port to other machines.
- Keep `tools/omeety-key.pem` private. It is local signing material and is not
  required to install the published source.
- Do not publish generated browser profiles, host logs, screenshots, agent
  configuration backups, or `host/host-manifest.json`; they may contain local
  paths, account data, or session information.
- Browser actions that submit, save, delete, or perform non-GET requests require
  explicit confirmation in the extension.

If you discover a vulnerability, avoid posting credentials or private data in a
public issue. Open an issue containing only non-sensitive reproduction details.
