#!/usr/bin/env bash
# Trustabl plugin — SessionStart bootstrap.
#
# Ensures the pinned trustabl CLI is installed into the plugin's private data
# dir and exposes it to the session as $TRUSTABL_BIN. The skills, commands and
# subagent run scans through that binary with the Bash tool; the plugin has no
# MCP server (the Claude Directory accepts local MCP servers only from verified
# organizations).
#
# Install details (download from GitHub Releases into CLAUDE_PLUGIN_DATA,
# checksum-verified, idempotent) live in lib-trustabl.sh. This script ALWAYS
# exits 0 and never fails the session.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-trustabl.sh
. "${DIR}/lib-trustabl.sh"

if bin="$(tdl_managed_bin)" && [ -n "$bin" ] && tdl_ensure; then
  # Expose the managed binary to later Bash tool calls (only once per env file).
  if [ -n "${CLAUDE_ENV_FILE:-}" ] && ! grep -q 'TRUSTABL_BIN=' "$CLAUDE_ENV_FILE" 2>/dev/null; then
    echo "export TRUSTABL_BIN=\"$bin\"" >> "$CLAUDE_ENV_FILE"
  fi
  echo "[trustabl] Plugin-managed trustabl ${TDL_VERSION} ready at ${bin}. Scan with \"\$TRUSTABL_BIN\" scan <path> --format json."
  exit 0
fi

# Auto-install could not run — report on whatever is on PATH so the session
# still knows the state.
if command -v trustabl >/dev/null 2>&1; then
  have="$(trustabl version 2>/dev/null | awk 'NR==1 {print $NF}')"
  lowest="$(printf '%s\n%s\n' "$TDL_VERSION" "$have" | sort -V | head -n1)"
  if [ -n "$have" ] && [ "$lowest" != "$TDL_VERSION" ]; then
    echo "[trustabl] CLI ${have} on PATH is older than ${TDL_VERSION}; upgrade: ${TDL_HINT}."
  else
    echo "[trustabl] using trustabl ${have} from PATH. Scan with: trustabl scan <path> --format json."
  fi
else
  echo "[trustabl] could not provide the trustabl CLI automatically — ${TDL_HINT}, then confirm with 'trustabl version'."
fi
exit 0
