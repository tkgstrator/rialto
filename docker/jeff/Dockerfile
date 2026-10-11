# CPU sidecar for the Decisions screen: serves Jeff (https://github.com/firelex/jeff).
#
# Jeff publishes no Dockerfile or image, so this one builds it from a pinned
# upstream commit. It is optional: compose.yaml only starts it under the
# `decisions` profile. See docs/guides/decisions.md.
#
# CPU only. `uv sync --no-default-groups` is Jeff's own CPU install (its
# README), with no CUDA extra and no MLX extra. Whether the torch wheel pulls
# CUDA libraries in on this platform is a property of upstream's lockfile,
# not something chosen here.
# Jeff's pyproject sets [tool.uv] required-version = ">=0.12.19" and uv refuses
# to run below it, so this must stay on 0.12 or newer.
FROM ghcr.io/astral-sh/uv:0.12 AS uv

FROM python:3.12-slim

# v1.1 (annotated tag; the tag object is 8ed97bd6…, the commit is this one).
# Pinned to the commit rather than the tag name so a moved tag cannot change
# what is built.
ARG JEFF_REF=f0397f3785d93f73a01411d785d2ed026f53181d

COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# A non-root user owns the app and the model volume.
RUN useradd --create-home --uid 10001 jeff \
    && mkdir -p /models /app \
    && chown jeff:jeff /models /app

USER jeff
WORKDIR /app

# Fetch exactly the pinned commit, then install the locked CPU dependencies.
# --frozen makes uv.lock authoritative instead of re-resolving.
RUN git init -q . \
    && git remote add origin https://github.com/firelex/jeff.git \
    && git fetch -q --depth 1 origin "${JEFF_REF}" \
    && git checkout -q FETCH_HEAD \
    && rm -rf .git \
    && uv sync --no-default-groups --frozen

# The checkpoint lives on a volume, never in an image layer, so it is
# downloaded once and survives rebuilds. HF_HOME keeps the Hugging Face cache
# there too.
ENV HF_HOME=/models/.hf \
    # All variables below are Jeff's own (src/jeff/server.py, models.py).
    # JEFF_HOST: its default, 127.0.0.1, is unreachable from other containers.
    JEFF_HOST=0.0.0.0 \
    PORT=8765 \
    JEFF_BACKEND=pytorch \
    JEFF_DEVICE=cpu \
    JEFF_CHECKPOINT=/models/jeff-0.8b \
    # The sidecar's own settings, read by entrypoint.sh only.
    JEFF_MODEL_REPO=mstrasser/Jeff-Qwen3.5-0.8B

VOLUME /models
EXPOSE 8765

COPY --chown=jeff:jeff entrypoint.sh /usr/local/bin/jeff-entrypoint.sh
RUN chmod +x /usr/local/bin/jeff-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/jeff-entrypoint.sh"]
