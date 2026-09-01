# Railway deployment

The production image is a single public service:

- `/` — static marketing site
- `/admin` — owner dashboard
- `/v1` — Go API
- `/healthz` — application and PostgreSQL health check

PostgreSQL is a separate private Railway service. Screenshots, installer
artifacts and application logs are kept on a volume mounted at `/app/storage`.
The container exposes `/app/storage/download` as the public `/download/*`
directory, so installer binaries survive application redeploys without being
committed to Git.

## Railway service variables

Set these on the web service:

```dotenv
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=<at-least-32-random-bytes>
STATIC_DIR=/app/web
STORAGE_DIR=/app/storage
LOG_DIR=/app/logs
APP_ENV=production
SITE_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
WEB_ADMIN_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
```

`SITE_BASE_URL` is declared as a Docker build argument and is used only to render
canonical URLs and the sitemap. Railway injects service variables during builds.

## Required Railway resources

1. A service sourced from `EyadSofian/bibo-productivity-platform`, branch `main`.
2. A managed PostgreSQL service named `Postgres`.
3. A volume attached to the web service at `/app/storage`.
4. A generated Railway domain, or a custom domain, targeting the service port.
5. Health check path `/healthz`.

Migrations run automatically at application startup. Enable scheduled Postgres
and volume backups before storing production employee data.

## Installer artifacts

The updater signing key is deliberately kept outside the repository. On the
release Mac it lives at `~/.config/bibo-signing/bibo-updater.key`; its password
is stored in macOS Keychain under the service `bibo-tauri-updater`. GitHub
Actions receives the same values through the encrypted secrets
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Run the **Build desktop installers** workflow. Its `signed-release` artifact
contains the public installers, the signed macOS/Windows updater archives and
the generated `latest.json`. Upload the stable public filenames and every file
referenced by `latest.json` to the web volume:

```bash
railway volume files --volume web-volume upload <macOS.dmg> /download/EmployeeTracker-macOS.dmg --overwrite
railway volume files --volume web-volume upload <Windows-setup.exe> /download/BiBoTracking-Windows-x64-Setup.exe --overwrite
railway volume files --volume web-volume upload <Windows.msi> /download/BiBoTracking-Windows-x64.msi --overwrite
railway volume files --volume web-volume upload <macOS.app.tar.gz> /download/<macOS.app.tar.gz> --overwrite
railway volume files --volume web-volume upload <Windows-setup.exe> /download/<Windows-setup.exe> --overwrite
railway volume files --volume web-volume upload latest.json /download/latest.json --overwrite
```

The backend serves and counts these downloads at `/download/:file`. Keep the
private updater key backed up securely: losing it prevents publishing updates
to already-installed copies.
