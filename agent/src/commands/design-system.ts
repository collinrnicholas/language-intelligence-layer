import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { projectDesignSystemPath } from '../paths.js';

// A template the user fills in BY HAND. We intentionally do not derive tokens
// from any recording or page CSS — the expected token set must come from the
// design source of truth, never from the artifact being evaluated (that would
// compare the page against itself and produce meaningless drift).
const TEMPLATE = {
  version: '1.0',
  _comment:
    'Fill these in with YOUR product\'s real design tokens (from your design system / Figma / theme file). ' +
    'Do NOT copy values out of the recorded page — drift compares the page against THIS list.',
  color: {
    // name: "#RRGGBB"
    'text-primary': '#101317',
    'surface': '#FFFFFF',
    'brand': '#3B82F6',
  },
  font: {
    ui: "'Inter', sans-serif",
    mono: "'JetBrains Mono', monospace",
  },
  radius: {
    // name: pixels
    sm: 4,
    md: 8,
    lg: 16,
  },
  space: [4, 8, 12, 16, 24, 32, 48],
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.05)',
    md: '0 4px 12px rgba(0,0,0,0.08)',
  },
};

export async function designSystemCommand(action: string, project: string): Promise<void> {
  if (action !== 'init') {
    console.error(`Unknown action '${action}'. Supported: init`);
    process.exitCode = 1;
    return;
  }

  const path = projectDesignSystemPath(project);
  if (existsSync(path)) {
    console.error(`Design system already exists: ${path}`);
    console.error('Edit it directly, or delete it first to regenerate the template.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(TEMPLATE, null, 2) + '\n', 'utf-8');

  console.log(`✓ Wrote design system template for '${project}':`);
  console.log(`    ${path}`);
  console.log('');
  console.log('Next: open that file and replace the example tokens with your real ones,');
  console.log('then re-run `loupe analyze` to enable design-drift checks.');
}
