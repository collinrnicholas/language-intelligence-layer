# Product Spec: Loupe Studio

**Status:** Future (v3)
**Owner:** Collin
**Depends on:** All v2 features, Supabase for optional cloud storage

## Purpose

Loupe Studio is the optional web dashboard for browsing sessions, reports, and benchmarks. It is NOT required — the CLI is the primary interface. Studio is for teams who want to share results and track progress over time.

## Features (v1)

### Session Browser
- List all recorded sessions with project/flow/timestamps
- Filter by project, date range, score
- Sort by score, date, opportunity count

### Report Viewer
- Open any `report.html` in the dashboard
- Compare before/after reports side by side
- Share report via link (requires cloud storage)

### Benchmark Dashboard
- Track scores over time per project
- Category score breakdown (radar chart)
- Score delta per release
- False positive rate tracking

### Team Features (v2)
- Shared projects
- Review assignments
- Comment threads on opportunities
- Integration with Linear/GitHub/Notion

## Architecture

```typescript
// Optional cloud storage
interface CloudSession {
  id: string;
  project: string;
  flow: string;
  userId: string;
  teamId: string;
  score: number;
  opportunities: Opportunity[];
  reportUrl: string;
  createdAt: string;
}
```

- Primary storage: local filesystem (`~/.loupe/projects/`)
- Cloud storage: Supabase (opt-in)
- Auth: API key or OAuth
- Deployment: Vercel + Supabase

## Non-Goals

- Studio is not required for any core workflow
- Studio does not replace the CLI
- Studio does not analyze — it displays analysis results
