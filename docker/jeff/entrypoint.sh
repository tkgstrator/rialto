#!/bin/sh
# Download the Jeff checkpoint on first start, then serve it.
#
# The checkpoint is a Hugging Face model directory (Jeff's README:
# `hf download <repo> --local-dir <dir>`). It is not baked into the image:
# it lands on the /models volume once and is reused by every later start.
#
# A marker file is written only after the download completes, so a container
# stopped halfway through never serves a partial checkpoint; the next start
# downloads again (hf resumes already-fetched files).
set -e

CHECKPOINT="${JEFF_CHECKPOINT:?JEFF_CHECKPOINT is not set}"
REPO="${JEFF_MODEL_REPO:?JEFF_MODEL_REPO is not set}"
MARKER="${CHECKPOINT}/.rialto-download-complete"

if [ ! -f "$MARKER" ]; then
  echo "[jeff] downloading ${REPO} to ${CHECKPOINT} (first start only)..."
  uv run --no-default-groups hf download "$REPO" --local-dir "$CHECKPOINT"
  touch "$MARKER"
  echo "[jeff] download complete"
fi

echo "[jeff] serving ${CHECKPOINT} on ${JEFF_HOST}:${PORT} (device: ${JEFF_DEVICE})"
exec uv run --no-default-groups jeff-serve
