#!/bin/sh
# Runs the scenario tests with node if present, otherwise macOS's built-in JavaScriptCore.
cd "$(dirname "$0")/.."
TMP="${TMPDIR:-/tmp}/omlet-multi-test.js"
{
  printf 'var PLUGIN_SOURCE = %s;\n' "$(python3 -c 'import json,sys;print(json.dumps(open("index.js").read()))')"
  cat test/harness.js test/scenarios.js
} > "$TMP"
if command -v node >/dev/null 2>&1; then
  node "$TMP"
else
  /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc "$TMP"
fi
