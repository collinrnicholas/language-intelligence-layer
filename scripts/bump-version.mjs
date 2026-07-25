#!/usr/bin/env node
// Bump the manifest version. Usage: node scripts/bump-version.mjs [major|minor|patch]
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, '..', 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

const [major, minor, patch] = manifest.version.split('.').map(Number);
const bump = process.argv[2] || 'patch';

const next = {
  major: [major + 1, 0, 0],
  minor: [major, minor + 1, 0],
  patch: [major, minor, patch + 1],
}[bump];

if (!next) { console.error('Usage: bump-version.mjs [major|minor|patch]'); process.exit(1); }

manifest.version = next.join('.');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${manifest.version} (was ${major}.${minor}.${patch})`);
