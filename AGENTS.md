# ANTIGRAVITY DASHBOARD

**Generated:** 2026-01-07 | **Commit:** 0011eb2 | **Branch:** master

## GOAL TRACKING

1. First todo must be `[GOAL] <objective>`, always `pending`
2. Before every `todowrite`, run `todoread` first (read → merge → write)
3. Only mark GOAL as `completed` when task is fully delivered
4. If requirements change, update the GOAL text (don't delete it)

## OVERVIEW

Multi-account Google Cloud quota monitor with Claude/OpenAI API proxy. npm workspaces monorepo: Express backend + React frontend.

## STRUCTURE

```
./
├── apps/backend/       # @antigravity/backend - Express server, API proxy, services
├── apps/web/           # @antigravity/web - React dashboard UI
├── .env.example        # OAuth credentials (DO NOT change - tokens are bound to these)
└── usage.db            # SQLite (runtime)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add API endpoint | `apps/backend/src/server.ts` | 2000+ lines, all routes here |
| Add UI component | `apps/web/src/components/` | Functional components + Tailwind |
| Modify quota fetching | `apps/backend/src/services/quotaService.ts` | Google Cloud Code API |
| Account management | `apps/backend/src/services/accountsFile.ts` | File watcher + CRUD |
| API proxy logic | `apps/backend/src/services/apiProxy/` | Claude/OpenAI conversion |
| LS integration | `apps/backend/src/services/languageServer/` | VS Code extension bridge |
| State management | `apps/web/src/stores/useDashboardStore.ts` | Zustand |
| Hooks | `apps/web/src/hooks/` | Data fetching hooks |

## CONVENTIONS

- **Types duplicated**: `apps/backend/src/types/` and `apps/web/src/types/` - manually sync
- **Root .env only**: Backend loads from `../../../.env` relative to dist
- **Linting**: oxlint (Rust-based, fast) - config in `.oxlintrc.json`, runs in CI
- **Tailwind theming**: CSS variables in `apps/web/src/index.css`, config in `tailwind.config.js`

## ANTI-PATTERNS (THIS PROJECT)

| Pattern | Why Forbidden |
|---------|---------------|
| Change OAuth credentials | Tokens cryptographically bound to plugin's client ID |
| Export refresh tokens | Security - `/api/accounts/export` strips them |
| `as any` / `@ts-ignore` | Strict mode enforced |
| CSS modules | Tailwind only |

## UNIQUE PATTERNS

- **Effective quota**: Rate-limited accounts count as 0% in averages
- **Tier detection**: Inferred from reset times (hourly=PRO, daily=FREE)
- **Protocol signatures**: Base64 "thought" signatures injected for Antigravity API
- **LS port discovery**: Scans `/proc` for VS Code extension process args

## COMMANDS

```bash
pnpm install             # Install all workspaces
pnpm run build           # Build backend + frontend
pnpm start               # Start server (port 3456)
pnpm run dev             # Dev mode with hot reload
pnpm run lint            # Run oxlint (fast Rust-based linter)
pnpm run lint:fix        # Auto-fix lint issues
```



## NOTES

- Server serves React SPA from `apps/web/dist/` via Express
- WebSocket at `/ws` for live updates
- SQLite tables: `api_calls`, `session_events`, `quota_snapshots`
- Accounts file: `~/.config/opencode/antigravity-accounts.json`

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
