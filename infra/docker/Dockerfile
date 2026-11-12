# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
# Optional build-time switch: ADMIN_API_SAME_ORIGIN=1 builds the admin UI
# against its own origin (Caddy proxy) instead of the production API
# origin. Only for isolated builds; unset by default, so production
# builds are unchanged.
ARG ADMIN_API_SAME_ORIGIN
# One source layer and one install/build layer also work with VFS in small cloud workspaces.
COPY . .
RUN --mount=type=secret,id=proxy_ca --mount=type=cache,id=fafa-pnpm,target=/root/.local/share/pnpm/store \
    if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -s /run/secrets/proxy_ca ] && grep -q 'BEGIN CERTIFICATE' /run/secrets/proxy_ca; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile --network-concurrency=4 && pnpm build && CI=true pnpm prune --prod --ignore-scripts && rm -r /root/.npm
FROM build AS runtime
USER node
EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","--import","tsx","apps/api/src/index.ts"]
FROM caddy:2.10.2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY --from=build /app/LICENSE /app/docs/THIRD_PARTY_NOTICES.txt /app/docs/WLOC_THIRD_PARTY_NOTICES.txt /srv/
COPY infra/docker/Caddyfile.static /etc/caddy/Caddyfile
USER 1000:1000
EXPOSE 8080
FROM caddy:2.10.2-alpine AS admin
COPY --from=build /app/apps/admin/dist /srv
COPY --from=build /app/LICENSE /app/docs/THIRD_PARTY_NOTICES.txt /app/docs/WLOC_THIRD_PARTY_NOTICES.txt /srv/
COPY infra/docker/Caddyfile.static /etc/caddy/Caddyfile
USER 1000:1000
EXPOSE 8080
