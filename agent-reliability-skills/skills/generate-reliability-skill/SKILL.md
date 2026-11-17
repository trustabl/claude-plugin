---
name: generate-reliability-skill
description: >-
  Use before writing or changing AI agent code in a repository (Claude Agent SDK,
  OpenAI Agents SDK, Google ADK, MCP, LangChain/LangGraph, CrewAI, Pydantic AI,
  Vercel AI SDK, AutoGen), or when the user asks for Trustabl Forge or a
  pre-coding reliability skill. Generates a SKILL.md from Trustabl's detection
  rules for the agent SDKs the repository uses, so you apply them while you code.
---

# Generate a pre-coding reliability skill with Trustabl Forge

Forge reads the repository's dependency manifests (`package.json`,
`pyproject.toml`, `requirements.txt`, `go.mod` and others), finds the agent SDKs
it uses, and prints a `SKILL.md` built from Trustabl's detection rules for exactly
those SDKs. It makes no model call and needs no API key.

## Run it

Forge is part of the open-source Trustabl analyzer (`trustabl forge`, 0.1.14 or later).

The plugin ships no scripts. Run this block with the Bash tool: it downloads the pinned release from GitHub,
checks it against the release's `checksums.txt` (a mismatch installs nothing), keeps it in `~/.trustabl/cli/`, and
prints `TRUSTABL_BIN=<path>`. Later runs only check the version, so run it at the start of each session that uses
Forge. Tell the user what it downloads the first time. If the user already has `trustabl` 0.1.14 or later on `PATH` (`trustabl version`), use that instead.

```bash
V=0.1.16; D="$HOME/.trustabl/cli/v$V"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) OS=windows; EXT=zip; EXE=trustabl.exe ;; Darwin) OS=darwin; EXT=tar.gz; EXE=trustabl ;; *) OS=linux; EXT=tar.gz; EXE=trustabl ;; esac
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac; [ "$OS" = windows ] && ARCH=amd64
TRUSTABL_BIN="$D/$EXE"
if ! "$TRUSTABL_BIN" version 2>/dev/null | head -n1 | grep -q "$V\$"; then
  A="trustabl_${V}_${OS}_${ARCH}.$EXT"; U="https://github.com/trustabl/agent-reliability-analyzer/releases/download/v$V"; T="$(mktemp -d)"
  curl -fsSL "$U/$A" -o "$T/$A" && curl -fsSL "$U/checksums.txt" -o "$T/checksums.txt" &&
  SUM=sha256sum; command -v sha256sum >/dev/null || SUM="shasum -a 256"
  (cd "$T" && L="$(grep " $A\$" checksums.txt)" && [ -n "$L" ] && echo "$L" | $SUM -c -) &&
  mkdir -p "$D" && if [ "$EXT" = zip ]; then unzip -oq "$T/$A" -d "$D"; else tar -xzf "$T/$A" -C "$D"; fi &&
  chmod +x "$TRUSTABL_BIN"; rm -rf "$T"
fi
if "$TRUSTABL_BIN" version 2>/dev/null | head -n1 | grep -q "$V\$"; then echo "TRUSTABL_BIN=$TRUSTABL_BIN"; else echo "install failed: see the message above"; fi
```

Shell state does not carry between Bash calls: start each later command with `TRUSTABL_BIN="<the printed path>";`.
If the block prints `install failed`, show the user the message above it and stop.

```bash
"$TRUSTABL_BIN" forge <repo>                               # detected SDKs only
"$TRUSTABL_BIN" forge <repo> --policy mcp,openai_sdk       # add SDK categories not yet in a manifest
"$TRUSTABL_BIN" forge <repo> --lang python,typescript      # add languages: python, typescript, go
```

`<repo>` is `.` unless the user named another directory. The SKILL.md goes to
stdout; any note or warning goes to stderr. The first run also fetches
Trustabl's rules; after that it works from cache.

**No SDK detected:** exit code 1 with `no SDKs detected` on stderr means no
supported SDK is declared in the manifests. If the repository does use one (for
example declared only in a subfolder's manifest), run again with `--policy`
naming it, and say so.

## Save it

Save the output to `.claude/skills/trustabl-pre-coding/SKILL.md`:

- If no file is there, write it.
- If one is there, replace it **only if it starts with a Forge stamp**
  (`<!-- generated: `); a file without the stamp is a hand-written skill: never
  overwrite it, tell the user instead and offer another path.

The stamp line reads `<!-- generated: <date> | rules: <version> | schema: <n> |
sdks: <list> | template: <n> -->`. Report the SDKs it covers and the rules
version, then follow the skill's rules while you write code.
