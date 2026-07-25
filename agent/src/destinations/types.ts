// ─── Destination Types ───────────────────────────────────────────

export type DestinationType =
  | 'local'
  | 'claude-code'
  | 'cursor'
  | 'codex'
  | 'gemini'
  | 'clipboard'
  | 'custom-command';

export type PostAction = 'none' | 'open-folder' | 'copy-prompt' | 'run-command';

export interface DestinationConfig {
  id: string;
  name: string;
  type: DestinationType;
  workspace?: string;       // project root for workspace destinations
  output?: string;          // relative output dir inside workspace (e.g. ".ai/tasks")
  postAction: PostAction;
  command?: string;         // for custom-command type
}

export interface DestinationsFile {
  defaultDestination: string;
  destinations: DestinationConfig[];
  projectMappings: Record<string, string>; // project name → destination id
}

export interface ImplementationPackage {
  packageDir: string;
  files: string[];
  screenshotCount: number;
  project: string;
  flow: string;
}

export interface DestinationResult {
  success: boolean;
  destinationId: string;
  packagePath?: string;
  filesWritten: string[];
  commandRun?: string;
  commandCwd?: string;
  message: string;
}

export interface DestinationProvider {
  type: DestinationType;
  route(pkg: ImplementationPackage, dest: DestinationConfig): Promise<DestinationResult>;
}

/** Default destinations shipped with Loupe */
export const DEFAULT_DESTINATIONS: DestinationConfig[] = [
  {
    id: 'local',
    name: 'Local Folder',
    type: 'local',
    output: '~/Loupe/implementation-packages',
    postAction: 'open-folder',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    type: 'claude-code',
    output: '.ai/tasks',
    postAction: 'open-folder',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    type: 'cursor',
    output: '.cursor/tasks',
    postAction: 'open-folder',
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'codex',
    output: '.codex/tasks',
    postAction: 'open-folder',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    type: 'gemini',
    output: '.gemini/tasks',
    postAction: 'open-folder',
  },
  {
    id: 'clipboard',
    name: 'Clipboard',
    type: 'clipboard',
    postAction: 'copy-prompt',
  },
];
