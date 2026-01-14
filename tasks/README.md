# PRD Task Tracking

This directory contains the Product Requirements Document (PRD) and task tracking for the **Standardize on pnpm** project.

## Files

### 1. **prd.json** - Ralph TUI Format
This is the primary PRD in the ralph-tui JSON format with the following structure:
- `name`: Feature name
- `branchName`: Git branch for this feature
- `userStories`: Array of user stories with:
  - `id`: Story identifier (e.g., US-001)
  - `title`: Story title
  - `description`: Full user story description
  - `acceptanceCriteria`: Array of acceptance criteria
  - `priority`: 1 (high), 2 (medium), 3 (low)
  - `passes`: Boolean indicating completion status
  - `dependsOn`: Array of dependent story IDs

**Total User Stories:** 10

### 2. **Beads Issues** - Git-backed Issue Tracker
All user stories have been imported into beads (`.beads/beads.db`):
- **Issue Prefix:** `antigravity-dashboard-XXX`
- **Total Issues:** 10 (plus 1 existing)
- **Label:** `pnpm-migration`
- **Status:** All open, ready to work

#### Beads Commands
```bash
# List all pnpm migration issues
bd list --label pnpm-migration

# Show detailed view of an issue
bd show antigravity-dashboard-001

# Show project statistics
bd stats

# Mark issue as in-progress
bd update antigravity-dashboard-001 --status in-progress

# Close completed issue
bd close antigravity-dashboard-001
```

### 3. **prd-beads.jsonl** - Beads Import Format
JSONL file used to import user stories into beads. Each line is a complete JSON object representing one issue.

### 4. **prd-product-requirements-document-standardize-on-pnpm.md**
The full Product Requirements Document in markdown format with:
- Executive Summary
- Success Metrics
- Detailed User Stories
- Technical Specifications
- Implementation Plan
- Risk Assessment

## Conversion Script

The `convert-prd-to-beads.js` script converts the prd.json format to beads JSONL format:
```bash
node tasks/convert-prd-to-beads.js
bd import -i tasks/prd-beads.jsonl --rename-on-import
```

## Next Steps

1. Review the PRD: `tasks/prd-product-requirements-document-standardize-on-pnpm.md`
2. Start working on issues: `bd ready` to see ready tasks
3. Track progress with: `bd list --label pnpm-migration`
4. Update prd.json as stories are completed

## Priority Mapping

| PRD Priority | Beads Priority | Description |
|--------------|---------------|-------------|
| 1 | P0 | High priority (foundation) |
| 2 | P2 | Medium priority (core migration) |
| 3 | P3 | Low priority (documentation) |
