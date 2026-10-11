# The engine, and the client it serves.
#
# There is no build step and no dependency install, because there are no dependencies:
# the client is ES modules the browser loads as they are, and the server is Node's own
# http, net and crypto. So the image is a Node base plus this repository, it builds in
# seconds offline, and there is no third party in the path between a capture on the box
# and the person looking at it.

FROM node:22-alpine

RUN addgroup -S sdrflex && adduser -S -G sdrflex sdrflex
WORKDIR /app

COPY web ./web
COPY server ./server
COPY recipes ./recipes
COPY grc ./grc

# Captures are mounted, not baked in. Read-only is the intent: this tool analyzes
# captures and never writes to them.
VOLUME /captures
ENV SDRFLEX_CAPTURES=/captures \
    SDRFLEX_PORT=8722 \
    SDRFLEX_BIND=0.0.0.0 \
    SDRFLEX_RINGS=/rings

# Inside a container 0.0.0.0 means "this container's network namespace", not "every
# interface on the host". What the host exposes is decided by the port publish, and
# compose scopes that to one address — see docker-compose.yml.
# Ring recordings are scratch, and large: sixty seconds of 2.4 MS/s cu8 is 288 MB. Its
# own directory so it can be mounted onto a real disk when the container's writable
# layer is somewhere you would rather not put that.
RUN mkdir -p /rings && chown sdrflex /rings
VOLUME /rings

EXPOSE 8722
USER sdrflex

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s \
  CMD wget -q -O /dev/null http://127.0.0.1:8722/index.html || exit 1

CMD ["node", "server/main.js"]
