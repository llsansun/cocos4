#!/usr/bin/env bash
set -euo pipefail

export WORKSPACE_ROOT=${WORKSPACE_ROOT:-/workspace}
export COCOS_SRC=${COCOS_SRC:-$WORKSPACE_ROOT/cocos}
export COCOS_OUTPUT=${COCOS_OUTPUT:-$WORKSPACE_ROOT/output}
export COCOS_CACHE=${COCOS_CACHE:-$WORKSPACE_ROOT/cache}

mkdir -p "$COCOS_OUTPUT" "$COCOS_CACHE" \
  "$COCOS_CACHE/npm" "$COCOS_CACHE/gradle" "$COCOS_CACHE/ccache"

export npm_config_cache="$COCOS_CACHE/npm"
export GRADLE_USER_HOME="$COCOS_CACHE/gradle"
export CCACHE_DIR="$COCOS_CACHE/ccache"

if [[ -d "$COCOS_SRC" ]]; then
  cd "$COCOS_SRC"
fi

exec "$@"
