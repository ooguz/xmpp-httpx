# syntax=docker/dockerfile:1
#
# The xmpp-httpx gateway: puts an HTTP origin on XMPP (XEP-0332).
#
#   docker build -t xmpp-httpx-gateway .
#   docker run --rm -e XMPP_HTTPX_SECRET=… xmpp-httpx-gateway \
#     --origin http://origin:8080 --service xmpp://prosody:5347 \
#     --domain web.example.org --allow alice@example.org
#
# A runnable compose example (Prosody + an origin + this gateway) lives in
# examples/docker/.
#
# The build stage produces a tarball with `npm pack` and the runtime stage
# installs *that*, so the image runs the exact artifact `npm publish` would
# upload — packaging mistakes fail the build instead of shipping.

FROM node:24-alpine AS build
WORKDIR /src

COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY src ./src
COPY types ./types
COPY bin ./bin
RUN npm run build && mkdir -p /out && npm pack --pack-destination /out

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The CLI's bin, installed as a dependency, lands here.
ENV PATH="/app/node_modules/.bin:${PATH}"

COPY --from=build /out/xmpp-httpx-*.tgz /tmp/
# @xmpp/client and @xmpp/component are *optional* peers of the library, so the
# browser build never pulls them in; the image needs both so either the
# component or the client mode works out of the box.
RUN printf '{"name":"xmpp-httpx-gateway-image","private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund --loglevel=error \
      /tmp/xmpp-httpx-*.tgz "@xmpp/client@^0.14.0" "@xmpp/component@^0.14.0" \
 && rm /tmp/xmpp-httpx-*.tgz \
 && npm cache clean --force

USER node

# No HEALTHCHECK: the gateway exposes no port of its own — it is an XMPP client,
# not a server. Liveness needs the metrics endpoint that is still a roadmap item.
#
# The CLI installs SIGTERM/SIGINT handlers, so `docker stop` closes the XMPP
# stream cleanly even with node as PID 1 (no init shim needed).
ENTRYPOINT ["xmpp-httpx-gateway"]
CMD ["--help"]
