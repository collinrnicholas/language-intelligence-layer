# Product Spec: Destination Router

**Status:** v2.0-alpha (shipped)
**Owner:** Collin
**Depends on:** Build This, Implementation Package format

## Purpose

The Destination Router sends `loupe build-this` packages directly to the user's AI coding agent workspace. Instead of generating files in a local folder, packages arrive in `.ai/tasks/` (Claude Code), `.cursor/tasks/` (Cursor), or any configured workspace.

## User Flow

1. Configure once: `loupe destination set --id myproject --project "PM Toolkit" --type claude-code --workspace ~/Projects/PMToolkit --output .ai/tasks`
2. Run: `loupe build-this session.loupe --destination myproject`
3. Package is generated and written to `~/Projects/PMToolkit/.ai/tasks/2026-06-27-1430-pm-toolkit/`
4. CLAUDE.md wrapper file is included for immediate execution
5. Post-action opens the folder (or launches the agent, depending on config)

## Resolution Order

1. Explicit `--destination` flag
2. Project mapping in `~/.loupe/config/destinations.json`
3. Global default destination
4. Local folder fallback

## Providers

| Type | Writes to | Wrapper file |
|---|---|---|
| `local` | ~/Loupe/implementation-packages/ | — |
| `claude-code` | <workspace>/.ai/tasks/ | CLAUDE.md |
| `cursor` | <workspace>/.cursor/tasks/ | cursor-prompt.md |
| `codex` | <workspace>/.codex/tasks/ | codex-task.md |
| `gemini` | <workspace>/.gemini/tasks/ | gemini-task.md |
| `clipboard` | Copies build-prompt.md to clipboard | — |
| `custom-command` | User-defined command | — |

## Provider Interface

```typescript
interface DestinationProvider {
  type: DestinationType;
  route(packageResult: ImplementationPackage, destination: DestinationConfig): Promise<DestinationResult>;
}

interface DestinationResult {
  success: boolean;
  destinationId: string;
  packagePath?: string;
  filesWritten: string[];
  postAction?: string;
  commandRun?: string;
  message: string;
}
```

## Safety

- Never overwrite an existing package folder (timestamped slugs, retry with suffix)
- Expand `~` safely
- Validate workspace exists before writing
- Validate output directory is inside workspace for workspace destinations
- Custom commands require explicit `--run` flag
- Print clear dry-run preview in `destination test`
- If destination fails, fall back to local package and show error

## Config Structure

`~/.loupe/config/destinations.json`:
```json
{
  "defaultDestination": "local",
  "destinations": [
    { "id": "claude-code", "name": "Claude Code", "type": "claude-code", "output": ".ai/tasks", "postAction": "open-folder" }
  ],
  "projectMappings": {
    "PM Toolkit": "claude-code"
  }
}
```
