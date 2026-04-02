#!/usr/bin/env node
/**
 * x402s scheme unification migration
 * 
 * Transforms:
 *   "statechannel-hub-v1"    → "statechannel" + route: "hub"
 *   "statechannel-direct-v1" → "statechannel" + route: "direct"
 *
 * Run: node migrate-scheme.js [--dry-run]
 */

const fs = require("fs");
const path = require("path");

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = path.resolve(__dirname);

// ─── File discovery ──────────────────────────────────────────────
const EXTENSIONS = [".js", ".json", ".md", ".yaml", ".yml"];
const SKIP_DIRS = ["node_modules", ".git", "package-lock.json"];

function walk(dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walk(full));
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

// ─── Replacement rules ──────────────────────────────────────────
// Order matters — more specific patterns first

const RULES = [
  // ─── JSON object patterns (extensions key) ───
  // "statechannel-hub-v1": { ... }  →  "statechannel": { "route": "hub", ... }
  // "statechannel-direct-v1": { ... }  →  "statechannel": { "route": "direct", ... }

  // ─── .scheme comparisons in JS ───
  // o.scheme === "statechannel-hub-v1"  →  o.scheme === "statechannel" && ((o.extensions || {}).statechannel || {}).route === "hub"
  // Simplified: we use a helper function approach instead

  // ─── Simple string replacements ───
  // These handle the bulk of cases

  // Extensions object key: ["statechannel-hub-v1"]  →  ["statechannel"]
  { from: /\["statechannel-hub-v1"\]/g, to: '["statechannel"]' },
  { from: /\["statechannel-direct-v1"\]/g, to: '["statechannel"]' },

  // Extensions object key in JSON: "statechannel-hub-v1":  →  "statechannel":
  // Only when followed by { (extension object)
  { from: /"statechannel-hub-v1"\s*:/g, to: '"statechannel":' },
  { from: /"statechannel-direct-v1"\s*:/g, to: '"statechannel":' },

  // Scheme field in JSON objects: "scheme": "statechannel-hub-v1"  →  "scheme": "statechannel"
  { from: /"scheme"\s*:\s*"statechannel-hub-v1"/g, to: '"scheme": "statechannel"' },
  { from: /"scheme"\s*:\s*"statechannel-direct-v1"/g, to: '"scheme": "statechannel"' },

  // Scheme field without quotes (JS object literals): scheme: "statechannel-hub-v1"
  { from: /scheme:\s*"statechannel-hub-v1"/g, to: 'scheme: "statechannel"' },
  { from: /scheme:\s*"statechannel-direct-v1"/g, to: 'scheme: "statechannel"' },

  // Equality comparisons: === "statechannel-hub-v1"  →  === "statechannel"
  // NOTE: After this, hub/direct filtering must use route field — flagged for manual review
  { from: /=== "statechannel-hub-v1"/g, to: '=== "statechannel" /* TODO: check route === "hub" */' },
  { from: /=== "statechannel-direct-v1"/g, to: '=== "statechannel" /* TODO: check route === "direct" */' },
  { from: /!== "statechannel-hub-v1"/g, to: '!== "statechannel" /* TODO: check route */' },
  { from: /!== "statechannel-direct-v1"/g, to: '!== "statechannel" /* TODO: check route */' },

  // .eq("statechannel-hub-v1") — test assertions
  { from: /\.eq\("statechannel-hub-v1"\)/g, to: '.eq("statechannel") /* TODO: also assert route === "hub" */' },
  { from: /\.eq\("statechannel-direct-v1"\)/g, to: '.eq("statechannel") /* TODO: also assert route === "direct" */' },

  // schemes array: ["statechannel-hub-v1"]  →  ["statechannel"]
  { from: /\["statechannel-hub-v1"\]/g, to: '["statechannel"]' },

  // Markdown/doc references (backtick-wrapped)
  { from: /`statechannel-hub-v1`/g, to: '`statechannel` (hub route)' },
  { from: /`statechannel-direct-v1`/g, to: '`statechannel` (direct route)' },

  // Bare string references in docs
  { from: /statechannel-hub-v1/g, to: 'statechannel (hub route)' },
  { from: /statechannel-direct-v1/g, to: 'statechannel (direct route)' },
];

// ─── Apply ──────────────────────────────────────────────────────

const files = walk(ROOT);
let totalChanges = 0;
const changedFiles = [];
const todoFiles = [];

for (const file of files) {
  const original = fs.readFileSync(file, "utf-8");
  let content = original;

  for (const rule of RULES) {
    content = content.replace(rule.from, rule.to);
  }

  if (content !== original) {
    const rel = path.relative(ROOT, file);
    const changeCount = (content.match(/TODO:/g) || []).length;
    changedFiles.push(rel);
    if (changeCount > 0) todoFiles.push({ file: rel, todos: changeCount });
    totalChanges++;

    if (!DRY_RUN) {
      fs.writeFileSync(file, content, "utf-8");
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────

console.log(`\n${"=".repeat(60)}`);
console.log(`  x402s scheme unification migration`);
console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no files written)" : "APPLIED"}`);
console.log(`${"=".repeat(60)}\n`);
console.log(`Files changed: ${changedFiles.length}`);
changedFiles.forEach((f) => console.log(`  ✓ ${f}`));

if (todoFiles.length > 0) {
  console.log(`\n⚠  Files with TODO markers (need manual review):`);
  todoFiles.forEach((t) => console.log(`  → ${t.file} (${t.todos} TODOs)`));
  console.log(`\nTODO markers flag places where hub/direct filtering`);
  console.log(`previously used scheme === "statechannel-hub-v1" and now`);
  console.log(`needs to check the route field in extensions or payload.`);
  console.log(`\nTypical fix pattern:`);
  console.log(`  BEFORE: offers.filter(o => o.scheme === "statechannel-hub-v1")`);
  console.log(`  AFTER:  offers.filter(o => o.scheme === "statechannel" && getRoute(o) === "hub")`);
  console.log(`\nHelper function to add:`);
  console.log(`  function getRoute(offer) {`);
  console.log(`    return ((offer.extensions || {}).statechannel || {}).route`);
  console.log(`      || ((offer.extensions || {}).statechannel || {}).info?.route;`);
  console.log(`  }`);
}

console.log(`\nDone.`);
