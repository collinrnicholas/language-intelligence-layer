import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DestinationsFile, DestinationConfig } from './types.js';
import { DEFAULT_DESTINATIONS } from './types.js';
import { parseDestinationConfig } from '../schema.js';

const LOUPE_HOME = join(homedir(), '.loupe');
const CONFIG_PATH = join(LOUPE_HOME, 'config', 'destinations.json');

/** Load destinations config, creating defaults if missing */
export function loadConfig(): DestinationsFile {
  if (!existsSync(CONFIG_PATH)) {
    const defaults: DestinationsFile = {
      defaultDestination: 'local',
      destinations: DEFAULT_DESTINATIONS,
      projectMappings: {},
    };
    mkdirSync(join(LOUPE_HOME, 'config'), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw) as DestinationsFile;
    const errors = validateConfig(config);
    if (errors.length) throw new Error(errors.join('; '));
    return config;
  } catch {
    console.error('Failed to parse destinations.json — using defaults');
    return {
      defaultDestination: 'local',
      destinations: DEFAULT_DESTINATIONS,
      projectMappings: {},
    };
  }
}

/** Save destinations config */
export function saveConfig(config: DestinationsFile): void {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid destinations config: ${errors.join('; ')}`);
  mkdirSync(join(LOUPE_HOME, 'config'), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Get a destination by ID */
export function getDestination(id: string): DestinationConfig | undefined {
  const config = loadConfig();
  return config.destinations.find(d => d.id === id);
}

/** Resolve which destination to use for a project */
export function resolveDestination(projectName?: string, explicitDestination?: string): DestinationConfig {
  const config = loadConfig();

  // 1. Explicit destination passed
  if (explicitDestination) {
    const dest = config.destinations.find(d => d.id === explicitDestination);
    if (dest) return dest;
    console.warn(`Destination "${explicitDestination}" not found, falling back...`);
  }

  // 2. Project mapping
  if (projectName && config.projectMappings[projectName]) {
    const mappedId = config.projectMappings[projectName];
    const dest = config.destinations.find(d => d.id === mappedId);
    if (dest) return dest;
  }

  // 3. Global default
  const def = config.destinations.find(d => d.id === config.defaultDestination);
  if (def) return def;

  // 4. Ultimate fallback
  return DEFAULT_DESTINATIONS[0];
}

/** Add or update a destination */
export function setDestination(dest: DestinationConfig): void {
  const parsed = parseDestinationConfig(dest);
  if (!parsed.ok) throw new Error(`Invalid destination: ${parsed.errors.join('; ')}`);
  const config = loadConfig();
  const idx = config.destinations.findIndex(d => d.id === dest.id);
  if (idx >= 0) {
    config.destinations[idx] = dest;
  } else {
    config.destinations.push(dest);
  }
  saveConfig(config);
}

/** Set a project mapping */
export function setProjectMapping(project: string, destinationId: string): void {
  const config = loadConfig();
  config.projectMappings[project] = destinationId;
  saveConfig(config);
}

/** Set the default destination */
export function setDefaultDestination(destinationId: string): void {
  const config = loadConfig();
  config.defaultDestination = destinationId;
  saveConfig(config);
}

/** List all destinations */
export function listDestinations(): DestinationConfig[] {
  return loadConfig().destinations;
}

function validateConfig(config: DestinationsFile): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== 'object') return ['config must be an object'];
  if (typeof config.defaultDestination !== 'string') errors.push('defaultDestination must be a string');
  if (!Array.isArray(config.destinations)) {
    errors.push('destinations must be an array');
  } else {
    config.destinations.forEach((dest, i) => {
      const parsed = parseDestinationConfig(dest);
      if (!parsed.ok) errors.push(...parsed.errors.map(e => `destinations[${i}].${e}`));
    });
  }
  if (!config.projectMappings || typeof config.projectMappings !== 'object' || Array.isArray(config.projectMappings)) {
    errors.push('projectMappings must be an object');
  }
  return errors;
}
