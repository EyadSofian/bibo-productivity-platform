# Railway deployment

The production image is a single public service:

- `/` — static marketing site
- `/admin` — owner dashboard
- `/v1` — Go API
- `/healthz` — application and PostgreSQL health check

PostgreSQL is a separate private Railway service. Screenshots and application
logs are kept on a volume mounted at `/app/storage`.

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
