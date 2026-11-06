# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-/run/secrets/proxy_ca} npm install -g pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Workspace source is copied before install so both frozen lockfile and workspace manifests agree.
COPY . .
RUN --mount=type=secret,id=proxy_ca NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-/run/secrets/proxy_ca} pnpm install --frozen-lockfile && pnpm build
FROM build AS runtime
USER node
EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm","exec","tsx","apps/api/src/index.ts"]
FROM caddy:2.10.2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY infra/docker/Caddyfile.static /etc/caddy/Caddyfile
USER 1000:1000
EXPOSE 8080
FROM caddy:2.10.2-alpine AS admin
COPY --from=build /app/apps/admin/dist /srv
COPY infra/docker/Caddyfile.static /etc/caddy/Caddyfile
USER 1000:1000
EXPOSE 8080
