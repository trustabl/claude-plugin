#!/usr/bin/env node
// Trustabl plugin — MCP server launcher.
//
// `.mcp.json` points at this file and Claude Code runs it as `node <this>`.
// It is JavaScript rather than a shell script for one reason: a bare `.sh`
// command cannot be executed on Windows, where shebangs mean nothing, so the
// server simply failed to start there. Node is present wherever Claude Code
// runs, which makes this the one launcher that works on every platform.
//
// It ensures the pinned CLI is installed into the plugin's own data directory,
// then execs `trustabl mcp`. stdout is the JSON-RPC stream, so nothing here may
// write to it: every diagnostic goes to stderr.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, spawnSync, execFileSync } = require("child_process");

// Keep in step with scripts/lib-trustabl.sh and the README.
const VERSION = "0.1.13";
const REPO = "trustabl/agent-reliability-analyzer";
const HINT =
  "install with 'brew install trustabl/tap/trustabl' (macOS/Linux), " +
  "'scoop install trustabl' (Windows), or download from " +
  `https://github.com/${REPO}/releases`;

const log = (m) => process.stderr.write(`[trustabl] ${m}\n`);

// Release assets are named by Go's GOOS/GOARCH, and Windows ships a .zip while
// the rest ship .tar.gz.
function target() {
  const goos = { darwin: "darwin", linux: "linux", win32: "windows" }[os.platform()];
  let goarch = { x64: "amd64", arm64: "arm64" }[os.arch()];
  if (!goos || !goarch) return null;
  // There is no windows/arm64 asset — .goreleaser.yaml ignores that pair on
  // purpose. Asking for one gets a 404, so auto-install gave up and fell back
  // to PATH, which on a fresh ARM machine is nothing at all. Windows on ARM
  // runs x64 under emulation, so the amd64 build is the right answer rather
  // than a missing one.
  if (goos === "windows" && goarch === "arm64") goarch = "amd64";
  return { goos, goarch, ext: goos === "windows" ? "zip" : "tar.gz" };
}

function managedBin() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dir) return null;
  return path.join(dir, "bin", os.platform() === "win32" ? "trustabl.exe" : "trustabl");
}

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ["version"], { encoding: "utf8", timeout: 10000 });
    return (out.split("\n")[0].trim().split(/\s+/)[1] || "").trim();
  } catch {
    return "";
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "trustabl-plugin" } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return resolve(get(res.headers.location));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

// Download the pinned release, verify it against the release's own
// checksums.txt, and place the binary. Returns the path, or null on any
// failure: a failed install must never be fatal, because falling back to a
// binary already on PATH is better than refusing to start.
async function ensure() {
  const bin = managedBin();
  if (!bin) return null;
  if (fs.existsSync(bin) && versionOf(bin) === VERSION) return bin;

  const t = target();
  if (!t) {
    log(`auto-install is unsupported on ${os.platform()}/${os.arch()}.`);
    return null;
  }

  const asset = `trustabl_${VERSION}_${t.goos}_${t.goarch}.${t.ext}`;
  const base = `https://github.com/${REPO}/releases/download/v${VERSION}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trustabl-"));

  try {
    const [blob, sums] = await Promise.all([
      get(`${base}/${asset}`),
      get(`${base}/checksums.txt`),
    ]);

    const want = sums
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[1] === asset || p[1] === `*${asset}`);
    const got = crypto.createHash("sha256").update(blob).digest("hex");
    if (!want || want[0] !== got) {
      log(`checksum verification FAILED for ${asset}.`);
      return null;
    }

    const archive = path.join(tmp, asset);
    fs.writeFileSync(archive, blob);

    const name = os.platform() === "win32" ? "trustabl.exe" : "trustabl";
    let src;

    if (t.ext === "zip") {
      // Read the zip here rather than shelling out. Windows ships bsdtar, which
      // handles zips, but `tar` on PATH may well be GNU tar from Git Bash,
      // which does not — and which one wins is not ours to decide.
      src = unzipMember(blob, name, tmp);
      if (!src) {
        log(`could not find ${name} inside ${asset}.`);
        return null;
      }
    } else {
      const r = spawnSync("tar", ["-xf", archive, "-C", tmp], { stdio: "ignore" });
      if (r.status !== 0) {
        log("could not extract the release archive (is `tar` available?).");
        return null;
      }
      src = walk(tmp).find((f) => path.basename(f) === name);
      if (!src) {
        log(`could not find ${name} inside ${asset}.`);
        return null;
      }
    }

    fs.mkdirSync(path.dirname(bin), { recursive: true });
    // Stage beside the target so the final rename is atomic on the same volume,
    // which keeps a concurrent launcher from seeing a half-written file.
    const stage = `${bin}.staging.${process.pid}`;
    fs.copyFileSync(src, stage);
    if (os.platform() !== "win32") fs.chmodSync(stage, 0o755);
    fs.renameSync(stage, bin);
    return bin;
  } catch (e) {
    log(`auto-install failed: ${e.message}`);
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Extract one member from a zip buffer, using only zlib. Reads the end-of-
// central-directory record, walks the central directory for the wanted name,
// then inflates that member's data. Deflate and stored are the only methods
// Go's archive/zip writes, which is what produces our release assets.
function unzipMember(buf, wantName, destDir) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (path.basename(name) === wantName) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) return null;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw);
      const out = path.join(destDir, wantName);
      fs.writeFileSync(out, data);
      return out;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function onPath() {
  const probe = os.platform() === "win32" ? "where" : "which";
  const r = spawnSync(probe, ["trustabl"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.split("\n")[0].trim() || null;
}

(async () => {
  let bin = await ensure();
  if (!bin) {
    // A PATH binary may predate the `mcp` subcommand or the current rule
    // schema, in which case the server exits and Claude Code reports it as
    // failed. That is still better than refusing to launch.
    bin = onPath();
  }
  if (!bin) {
    log(`no trustabl binary available to start the MCP server; ${HINT}.`);
    process.exit(1);
  }

  const child = spawn(bin, ["mcp", ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("error", (e) => {
    log(`could not start ${bin}: ${e.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
})();
