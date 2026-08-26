#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing required option ${name}`);
  }
  return process.argv[index + 1];
}

function one(files, matcher, label) {
  const matches = files.filter(matcher);
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label}, found ${matches.length}: ${matches.join(", ")}`);
  }
  return matches[0];
}

function macArch(filename) {
  if (filename.includes("aarch64")) return "aarch64";
  if (filename.includes("x86_64")) return "x86_64";
  throw new Error(`Cannot infer macOS architecture from ${filename}`);
}

const assetsDir = path.resolve(option("--assets"));
const baseUrl = option("--base-url").replace(/\/$/, "");
const output = path.resolve(option("--output"));
const configPath = new URL("../apps/desktop/src-tauri/tauri.conf.json", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));
const files = await readdir(assetsDir);

const macBundle = one(files, (name) => name.endsWith(".app.tar.gz"), "macOS updater bundle");
const windowsBundle = one(files, (name) => name.endsWith(".nsis.zip"), "Windows updater bundle");

async function platformEntry(bundle) {
  const signature = await readFile(path.join(assetsDir, `${bundle}.sig`), "utf8");
  if (!signature.trim()) throw new Error(`Empty signature for ${bundle}`);
  return {
    signature: signature.trim(),
    url: `${baseUrl}/${encodeURIComponent(bundle)}`,
  };
}

const manifest = {
  version: config.version,
  notes: `BiBoTracking ${config.version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    [`darwin-${macArch(macBundle)}`]: await platformEntry(macBundle),
    "windows-x86_64": await platformEntry(windowsBundle),
  },
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${output} for ${Object.keys(manifest.platforms).join(", ")}`);
