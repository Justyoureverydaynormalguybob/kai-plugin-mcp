"use strict";
// Build the signed .kaiplugin with KAI Core's own packer and verifier, so the
// package format is never re-implemented here.
//
//   node scripts/pack.js --core <path to a kai-core checkout> --key <ed25519 private key .pem>
//
// The private key must live outside every repository. The output lands in
// dist/kai-plugin-mcp-<version>.kaiplugin; an existing file is never replaced
// (published versions are immutable).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const core = arg("core") || process.env.KAI_CORE_DIR;
const key = arg("key") || process.env.KAI_PLUGIN_KEY;
if (!core || !key) {
  console.error("Usage: node scripts/pack.js --core <kai-core checkout> --key <ed25519 private key .pem>");
  process.exit(2);
}
const root = path.resolve(__dirname, "..");
if (path.resolve(key).startsWith(root + path.sep)) throw Error("Refusing to use a signing key stored inside this repository");

const source = path.join(root, "plugin");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
const out = path.join(root, "dist", `kai-plugin-mcp-${manifest.version}.kaiplugin`);
fs.mkdirSync(path.dirname(out), { recursive: true });

execFileSync(process.execPath, [path.join(core, "scripts/core/pack-plugin.js"), source, path.resolve(key), out], { stdio: "inherit" });

const { verifyPackage } = require(path.join(path.resolve(core), "core/lib/plugins/package"));
const bytes = fs.readFileSync(out);
const verified = verifyPackage(bytes.toString("utf8"));
console.log(JSON.stringify({
  file: path.relative(root, out),
  id: verified.manifest.id,
  version: verified.manifest.version,
  fingerprint: verified.fingerprint,
  digest: verified.digest,
  fileSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
}, null, 2));
