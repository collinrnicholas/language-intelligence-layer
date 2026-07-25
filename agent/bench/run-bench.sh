#!/usr/bin/env bash
# Model-routing benchmark for the NNA session.
#
# For each routing config in bench/configs/, it swaps ~/.loupe/config/routing.json,
# re-runs analyze + build-this, saves the build-prompt, and scores the hard gates.
#
# PREREQUISITE (see bench/README.md): the gateway must be able to serve the models
# named in the configs. The default local gateway is an OpenAI-only proxy that
# IGNORES the model field, so B–E collapse to the same backend as A. Point
# LOUPE_API_URL at a gateway with LOUPE_MODEL_ALLOWED covering gpt-5.5 /
# claude-sonnet-4-6 / gpt-4.1 (and an Anthropic key) before trusting B–E results.
set -euo pipefail

SESS="${LOUPE_NNA_SESSION:?set LOUPE_NNA_SESSION to the NNA session.loupe path}"
export LOUPE_API_URL="${LOUPE_API_URL:-http://localhost:8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CFG_DIR="$HERE/configs"; OUT_DIR="$HERE/out"
ROUTING="$HOME/.loupe/config/routing.json"
mkdir -p "$OUT_DIR" "$(dirname "$ROUTING")"
[ -f "$ROUTING" ] && cp "$ROUTING" "$ROUTING.bench-backup" || true

for cfg in "$CFG_DIR"/*.json; do
  name="$(basename "$cfg" .json)"
  echo "═══ config $name ═══"
  cp "$cfg" "$ROUTING"
  # Fresh generations: model change → different cache key, but clear to be safe.
  rm -rf "$HOME/.loupe/cache/llm" 2>/dev/null || true
  out="$OUT_DIR/$name"; mkdir -p "$out"
  node dist/cli.js analyze "$SESS" --output "$out/analysis" > "$out/analyze.log" 2>&1
  art="$(ls -t "$HOME"/.loupe/projects/NNA/runs/*/analysis/opportunities.json | head -1)"
  node dist/cli.js build-this "$art" --goal "Best-in-class UX" --target "Claude Code" \
    --output "$out/pkg" > "$out/build.log" 2>&1
  cp "$(ls -t "$HOME"/Loupe/implementation-packages/*/build-prompt.md | head -1)" "$out/build-prompt.md"
  echo "  gates:"; node "$HERE/check-gates.mjs" "$out/build-prompt.md" | sed 's/^/    /' || true
  grep -h "LLM:timing" "$out"/*.log | tail -1 | sed 's/^/  cost: /' || true
done

[ -f "$ROUTING.bench-backup" ] && mv "$ROUTING.bench-backup" "$ROUTING" || rm -f "$ROUTING"
echo "Done. Compare bench/out/*/build-prompt.md and the gate reports above."
