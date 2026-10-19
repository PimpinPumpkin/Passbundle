# PassBundle's server and branded web vault in one image, from the optimized
# builds the Release workflow makes (.github/workflows/release.yml). Runs as
# an unprivileged user on port 8080, with SQLite in /data unless DATABASE_URL
# points at PostgreSQL. See deploy/README.md.
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libpq5 tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --no-create-home passbundle \
 && mkdir /data \
 && chown passbundle:passbundle /data

COPY --chmod=0755 passbundle-server /usr/local/bin/passbundle-server
COPY web-vault /web-vault

ENV ROCKET_ADDRESS=0.0.0.0 \
    ROCKET_PORT=8080 \
    DATA_FOLDER=/data \
    WEB_VAULT_FOLDER=/web-vault \
    WEB_VAULT_ENABLED=true

USER passbundle
WORKDIR /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD curl -fsS http://127.0.0.1:8080/alive || exit 1
CMD ["/usr/local/bin/passbundle-server"]
