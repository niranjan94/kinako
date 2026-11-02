# Sandboxed Kinako server for App Review. It runs the free Replay agent, which plays recorded
# turns, so no provider credentials or paid models are involved.
FROM node:24-bookworm-slim

ARG KINAKO_VERSION=0.1.7-nightly.20261102.43
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
  name="kinako-${KINAKO_VERSION}-linux-${arch}"; \
  base="https://github.com/niranjan94/kinako/releases/download/v${KINAKO_VERSION}"; \
  cd /tmp; \
  curl -fsSLO "$base/$name.tar.gz"; \
  curl -fsSLO "$base/SHA256SUMS"; \
  grep "  $name.tar.gz\$" SHA256SUMS | sha256sum -c -; \
  mkdir -p /opt/kinako; \
  tar xzf "$name.tar.gz" -C /opt/kinako --strip-components=1; \
  rm -f "$name.tar.gz" SHA256SUMS; \
  ln -s /opt/kinako/kinako /usr/local/bin/kinako

# The agent resolves transcripts relative to its own path, so mirror the repo layout.
RUN set -eux; \
  raw="https://raw.githubusercontent.com/niranjan94/kinako/v${KINAKO_VERSION}/apps/server"; \
  fixtures="src/orchestration-v2/testkit/fixtures"; \
  for f in \
    scripts/dev-replay-agent.ts \
    scripts/dev-replay/showcase_transcript.ndjson \
    "$fixtures/todo_list/registry_transcript.ndjson" \
    "$fixtures/tool_call_read_only_on_request/registry_transcript.ndjson" \
    "$fixtures/acp_elicitation/registry_transcript.ndjson" \
    "$fixtures/multi_turn/registry_transcript.ndjson"; \
  do curl -fsSL --create-dirs -o "/opt/replay/$f" "$raw/$f"; done; \
  chmod -R a+rX /opt/replay

COPY --chmod=644 settings.json /opt/replay/settings.json
COPY --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh

RUN useradd --create-home --uid 10001 kinako \
  && mkdir -p /data /workspace \
  && chown kinako:kinako /data /workspace

USER kinako
ENV T3CODE_HOME=/data \
  T3CODE_TELEMETRY_ENABLED=false

EXPOSE 3873
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
