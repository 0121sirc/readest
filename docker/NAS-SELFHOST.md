# Self-Hosting Readest on a NAS (Tailscale, single user, Web/PWA)

This guide deploys the stack from [`compose.yaml`](./compose.yaml) on a NAS and
exposes it to your Tailscale network only. It targets a personal, single-user
deployment accessed from the web/PWA on devices that join the same tailnet.

It complements [`README.md`](./README.md): read that one for the general stack
and the database/schema details. This one covers the NAS-specific overlay,
Tailscale TLS, and the single-user account flow.

## Why HTTPS is required even on a LAN

The web client is served cross-origin isolated (COOP/COEP, see
`apps/readest-app/src/middleware.ts`) so the browser can expose
`SharedArrayBuffer`, which the Turso WASM thread pool needs. A secure context
requires `https://` (or `localhost`); `http://<lan-ip>` is not one, so
`SharedArrayBuffer` is unavailable and Turso-backed features hang or fail.
Tailscale provides a trusted certificate for the node's MagicDNS name, which
satisfies this without a public domain.

`tailscale serve` preserves the original `Host` header when proxying to a local
TCP target (Tailscale source: `ipn/ipnlocal/serve.go`, `r.Out.Host = r.In.Host`).
That is what makes MinIO path-style presigned URLs verify through the proxy.

## Scope and limitations

- Only the **web/PWA** client can be pointed at a self-hosted backend. Tauri
  desktop/mobile builds resolve their backend from build-time env and have no
  runtime setting for it, so the App Store / Play builds cannot use this stack.
  They require a custom rebuild.
- Single origin: the browser only ever talks to the Tailscale HTTPS host, so
  there is no CORS or mixed-content configuration to change.
- Prefer a plain NAS folder for the database and MinIO data, not a folder
  managed by a dedup/sync service.

## 1. Prerequisites

- Tailscale installed on the NAS **host** (or a container with
  `network_mode: host`) and on every client device, all in the same tailnet.
- MagicDNS and HTTPS Certificates enabled in the tailnet admin console.
- The NAS MagicDNS name, e.g. `readest-nas.tailXXXX.ts.net`. This guide calls
  it `$HOST`.
- Docker Engine + Docker Compose v2.24 or newer (for the `!override` tag).
- Ports 3000/8000/9000/9001 free on the NAS host.

## 2. Get the files

Copy the repository's `docker/` directory to the NAS, for example
`/volume1/docker/readest/docker/`. The default `compose.yaml` pulls the
prebuilt image `ghcr.io/readest/readest:latest`; you do not need the rest of
the source tree unless you build the image locally.

## 3. Persist data and lock the ports

Edit [`compose.override.yaml`](./compose.override.yaml) and set the bind-mount
paths to your NAS shared folder. It maps Postgres and MinIO to host folders and
binds every published port to `127.0.0.1` so only a host-side proxy can reach
the stack.

```bash
docker compose -f compose.yaml -f compose.override.yaml up -d
```

## 4. Configure `docker/.env`

```bash
cd /volume1/docker/readest/docker
cp .env.example .env
```

Generate strong secrets:

- `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`, `JWT_SECRET`: at least 32 random
  characters each.
- `ANON_KEY` and `SERVICE_ROLE_KEY`: HS256 JWTs signed with the same
  `JWT_SECRET`, with payloads `{"role":"anon"}` and `{"role":"service_role"}`.

Generate the two JWTs with Node:

```bash
JWT_SECRET='paste-your-jwt-secret' node -e '
const c = require("crypto");
const s = process.env.JWT_SECRET, now = Math.floor(Date.now() / 1000);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (p) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const q = b64(p);
  return h + "." + q + "." + c.createHmac("sha256", s).update(h + "." + q).digest("base64url");
};
const base = { iss: "supabase", iat: now, exp: now + 315360000 };
console.log("ANON_KEY=" + sign({ ...base, role: "anon" }));
console.log("SERVICE_ROLE_KEY=" + sign({ ...base, role: "service_role" }));
'
```

Point every browser-facing URL at the single Tailscale origin (replace `$HOST`):

```env
HOST_IP=readest-nas.tailXXXX.ts.net
SITE_URL=https://readest-nas.tailXXXX.ts.net
API_EXTERNAL_URL=https://readest-nas.tailXXXX.ts.net
ADDITIONAL_REDIRECT_URLS=https://readest-nas.tailXXXX.ts.net/**
SUPABASE_PUBLIC_URL=https://readest-nas.tailXXXX.ts.net
S3_PUBLIC_ENDPOINT=https://readest-nas.tailXXXX.ts.net
S3_BUCKET_NAME=readest-files
OBJECT_STORAGE_TYPE=s3
SELF_HOSTED=true
ENABLE_EMAIL_AUTOCONFIRM=true
DISABLE_SIGNUP=false
STORAGE_FIXED_QUOTA=107374182400
TRANSLATION_FIXED_QUOTA=50000
```

`compose.yaml` already fixes the server-side endpoints
(`SUPABASE_URL=http://kong:8000`, `S3_ENDPOINT=http://minio:9000`), so only the
public URLs above need to change.

## 5. Start the stack

```bash
docker compose -f compose.yaml -f compose.override.yaml up -d
docker compose logs -f db
```

On an empty database volume the `supabase/postgres` image runs the Supabase core
schema, `volumes/db/init/schema.sql`, then `apply-migrations.sh`. Wait for that
to finish before using the app.

## 6. Expose it over Tailscale HTTPS

Run these on the NAS host. `--bg` makes the mappings persist across reboots, and
the certificate is provisioned and renewed by Tailscale automatically.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=443 --set-path=/auth/v1 http://127.0.0.1:8000
tailscale serve --bg --https=443 --set-path=/rest/v1 http://127.0.0.1:8000
tailscale serve --bg --https=443 --set-path=/readest-files/ http://127.0.0.1:9000
tailscale serve status
```

| Path               | Backend            | Purpose                          |
| ------------------ | ------------------ | -------------------------------- |
| `/`                | `127.0.0.1:3000`   | client UI and `/api/*`           |
| `/auth/v1/`        | `127.0.0.1:8000`   | Supabase GoTrue (login/signup)   |
| `/rest/v1/`        | `127.0.0.1:8000`   | PostgREST (replica sync)         |
| `/readest-files/`  | `127.0.0.1:9000`   | MinIO bucket (book files)        |

The `/readest-files/` prefix must match `S3_BUCKET_NAME`.

## 7. Create your account (single user)

Open `https://readest-nas.tailXXXX.ts.net` and register your account. Email
autoconfirm is on, so no SMTP is needed. Then close signups:

1. Set `DISABLE_SIGNUP=true` in `docker/.env`.
2. `docker compose -f compose.yaml -f compose.override.yaml up -d auth`.

## 8. Verify

- In the browser console, `self.crossOriginIsolated` is `true`.
- `https://readest-nas.tailXXXX.ts.net/runtime-config.js` returns the Tailscale
  `supabaseUrl` and `apiBaseUrl`.
- Import a book, then confirm the object exists in the `readest-files` bucket
  (MinIO console at `http://127.0.0.1:9001` on the NAS) and that Postgres has
  rows in `files` / `replicas`.
- Sign in from a second device on the tailnet and check that progress and
  annotations sync.

## 9. Backup and upgrade

Back up:

- `pg_dump` of the database (or a snapshot of `/volume1/docker/readest/db`)
- `/volume1/docker/readest/minio`
- `docker/.env`

Upgrade:

```bash
docker compose -f compose.yaml -f compose.override.yaml pull
docker compose -f compose.yaml -f compose.override.yaml up -d
docker compose -f compose.yaml -f compose.override.yaml exec db \
  /docker-entrypoint-initdb.d/zz-readest-migrations.sh
```

The migration script records what it applied in `readest_meta.migrations` and
skips applied files, so it is safe to repeat.

## 10. Troubleshooting

- **Blank page / features hang**: check `self.crossOriginIsolated` is `true`.
  If it is false the origin is not being served over Tailscale HTTPS, or
  `tailscale serve` is not preserving the document headers.
- **Uploads fail with a signature error**: the MinIO presigned URL host must
  match `S3_PUBLIC_ENDPOINT`. Confirm `/readest-files/` maps to MinIO and that
  `S3_BUCKET_NAME` matches the path prefix.
- **`!override` parse error**: your Compose is older than 2.24; bind the ports
  to loopback by editing `compose.yaml` directly instead.
- **Nodes cannot reach the NAS**: confirm both are in the same tailnet and
  MagicDNS resolves the `$HOST` name.

## CJK fonts (optional)

The reader loads some CJK webfont bundles from Readest's CDN, whose CORS only
allows readest.com origins. Mirror
`https://storage.readest.com/public/font/dist/<Family>/` to a path your NAS
serves and set `FONT_BASE_URL` accordingly. System and Google fonts are
unaffected.
