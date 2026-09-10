# Optional Nightsky signalling relay

This is the matching server for the Nightsky template. Local playback needs no
server. These public files travel with the app as `nightsky-agent-file` rows.
Read `nightsky-remix-guide` in its synced local Tonk replica and use its verified
extractor to materialize the current bundle into a new local directory. No ZIP
or external repository is required.

The server exchanges membership and WebRTC SDP/ICE. It does not receive audio,
comments, playback events or cursor positions. Those live events use direct
WebRTC data channels. Google STUN is configured by the client; no TURN service
is included. Difficult networks can still prevent direct peer connections.

## Install deliberately on your own host

1. Inspect the operating system, existing proxy, public DNS, available ports and
   service manager. Do not replace existing sites or firewall rules blindly.
   Use a supported Node 24 LTS release, one unprivileged service account and one
   process. In-memory rooms cannot be spread across independent workers.
2. Copy this folder into a directory readable by that account, for example
   `/opt/nightsky-relay/current`. Run `npm ci --omit=dev`, then `npm test` there.
   The lockfile pins `ws` 8.21.3. Tests use temporary loopback listeners and synthetic
   capabilities; they cover authentication, origin checks, room isolation,
   hostile payloads, heartbeat, cleanup, capacity and backpressure.
3. In your Tonk, read the scoped Nightsky player's `room()` result and copy that public room
   ID for your track. It includes the destination space/branch and track through
   a 32-bit hash. Use a separate random capability for independently trusted
   rooms; this hash is not cryptographic isolation. If you change scope or track,
   update the allowed room list. Multiple intended IDs are comma-separated.
4. Create a private environment file on the server. This example writes a fresh
   256-bit capability without printing it or putting it in command arguments:

   ```sh
   node --input-type=module <<'NODE'
   import { randomBytes } from 'node:crypto';
   import { writeFileSync } from 'node:fs';
   const env = ['NODE_ENV=production', 'HOST=127.0.0.1', 'PORT=8787',
     'RELAY_TOKEN=' + randomBytes(32).toString('hex'),
     'RELAY_ALLOWED_ROOMS=REPLACE_WITH_YOUR_ROOM_ID',
     'RELAY_ALLOWED_ORIGINS=null', 'RELAY_ALLOW_MISSING_ORIGIN=false', ''].join('\n');
   writeFileSync('relay.env', env, { flag: 'wx', mode: 0o600 });
   NODE
   ```

   Replace the room placeholder in that private file. Keep it outside the source
   checkout and backups that are shared publicly. The file must be readable by
   the service account only (or root plus a narrowly scoped service group).
   Production startup requires a token of at least 32 characters and explicit
   allowed rooms. `null` allows Tonk's sandbox iframe origin. Origin checks are
   an additional restriction, **not authentication**. Missing Origin is rejected
   when an allowlist is configured unless deliberately allowed with
   `RELAY_ALLOW_MISSING_ORIGIN=true`.
5. Start with your private file: `node --env-file=/PRIVATE/PATH/relay.env server.mjs`.
   Confirm a loopback-only listener and `curl --fail http://127.0.0.1:8787/health`
   returns only `{"ok":true}`. For a persistent systemd service use the example
   below, adapting paths and account; verify it on the target host before enabling.
6. Put your own TLS reverse proxy at `wss://relay.example.com`. Review the supplied
   Caddy site and **global runtime logging** fragments before merging them into
   an existing configuration. Access logs alone are not enough: error logs can
   also expose URI query strings. Validate configuration before reloading, and
   inspect a deliberately failed upgrade/502 path to ensure tokens are absent.
   Preserve query parameters and WebSocket upgrades. Expose TLS/443; keep the Node
   port loopback-only. Do not load balance this process across independent nodes.
7. Privately construct your WSS URL with a query parameter named `token` containing
   the generated value. Add exactly one `nightsky-relay` record with its `url` set
   to that URL, using your Tonk's editor or a private local notation file. Do not
   paste the capability into public source, issue reports, shell command arguments
   or logs. Every reader of that Tonk fact can obtain it: it is shared room access,
   not individual user authentication.
8. Verify two fresh browser clients: join and discover one another, play, pause,
   seek and move named cursors both ways; close and rejoin one client; restart the
   service and check reconnect. Reject a wrong token, room and origin. Verify
   external HTTPS health and log redaction. Test the networks/devices you need;
   same-machine tests cannot certify NAT traversal or acoustic speaker alignment.

Example systemd service (adjust the Node path/account/config; do not overwrite an
existing service unreviewed):

```ini
[Unit]
Description=Nightsky signalling relay
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5
[Service]
Type=simple
User=nightsky-relay
Group=nightsky-relay
WorkingDirectory=/opt/nightsky-relay/current
EnvironmentFile=/etc/nightsky-relay/relay.env
ExecStart=/usr/bin/node --max-old-space-size=96 /opt/nightsky-relay/current/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
CPUQuota=50%
MemoryHigh=128M
MemoryMax=192M
TasksMax=64
LimitNOFILE=2048
LogRateLimitIntervalSec=30s
LogRateLimitBurst=60
[Install]
WantedBy=multi-user.target
```

Keep journal retention bounded using the host's existing policy or a dedicated
systemd journal namespace. V8 JIT requires executable memory; do not blindly add
MemoryDenyWriteExecute. Avoid debug/access logging of WebSocket requests. The
default limits are 256 total sockets, 32 per remote IP, 64 rooms and 32 peers per
room; behind one reverse proxy all clients share its remote IP and therefore the
32-socket limit. The server intentionally does not trust X-Forwarded-For.

For an upgrade, preserve the old release and private configuration, test the new
release in an isolated local port, then restart one service and verify real
clients. Roll back its path/config if checks fail. To return to local listening,
remove only your own `nightsky-relay` record; audio, features and comments remain
in Tonk. Client peer sessions currently disconnect when signalling closes.

Server source and test copied unchanged from the tested Nightsky implementation.
The package retains its ISC declaration; template UI/packaging code is MIT and
the ws dependency is MIT. See the dependency's own license for its terms.
