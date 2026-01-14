# Product Requirements Document: Standardize on pnpm

## 1. Overview

### 1.1 Executive Summary
This PRD outlines the migration from npm to pnpm as the standard package manager for the Antigravity Dashboard repository. The migration addresses performance issues, disk space concerns, and aims to improve overall developer experience through faster installs, better dependency management, and optimized CI/CD pipeline execution.

### 1.2 Background
The project currently uses npm for package management. Teams have identified several pain points including slow installation times, excessive disk space usage, and suboptimal CI/CD performance. Standardizing on pnpm will address these issues while maintaining full compatibility with the existing Node.js ecosystem.

### 1.3 Goals
- Reduce dependency installation time by 2-3x compared to npm
- Decrease disk space usage through content-addressable storage
- Improve CI/CD build times and reduce CI minutes consumption
- Enhance developer experience with faster workflows
- Implement stricter dependency management to prevent phantom dependencies

### 1.4 Non-Goals
- Supporting multiple package managers simultaneously
- Migrating projects outside this repository
- Changing the fundamental workspace structure
- Rewriting existing package scripts beyond package manager syntax

## 2. Success Metrics

### 2.1 Key Performance Indicators (KPIs)
- **Installation Speed**: 50%+ reduction in `install` command execution time (baseline: current npm install time)
- **Disk Space**: 30%+ reduction in node_modules size across workspace
- **CI/CD Performance**: 20%+ reduction in total CI pipeline execution time
- **Developer Satisfaction**: Post-migration developer survey shows 80%+ satisfaction
- **Build Consistency**: Zero increase in build failures after migration

### 2.2 Measurement Plan
- Baseline metrics captured before migration (npm install time, disk usage, CI duration)
- Post-migration metrics captured after US-010 completion
- Weekly tracking for 2 weeks post-merge to identify regressions
- Developer feedback collected via team survey 1 week after merge

## 3. User Stories & Requirements

### 3.1 Configuration Foundation (Priority 1)

#### US-001: Create pnpm workspace configuration
**As a** developer  
**I want** pnpm workspace configuration  
**So that** the repository properly manages workspaces with pnpm

**Acceptance Criteria:**
- pnpm-workspace.yaml exists with packages: ['apps/*']
- Workspace structure is compatible with existing apps/backend and apps/web layout
- Configuration validated with `pnpm -r list`

**Dependencies:** None

---

#### US-002: Create pnpm configuration file
**As a** developer  
**I want** proper pnpm configuration  
**So that** dependency resolution and installation work correctly

**Acceptance Criteria:**
- .npmrc file created with auto-install-peers=true
- .npmrc includes strict-peer-dependencies=false
- Configuration supports frozen lockfile for CI
- shamefully-hoist=false (maintain pnpm's strict linking)

**Dependencies:** None

---

### 3.2 Migration Execution (Priority 2)

#### US-003: Update root package.json scripts for pnpm
**As a** developer  
**I want** package.json scripts to use pnpm commands  
**So that** builds and dev workflows work with pnpm

**Acceptance Criteria:**
- build script uses `pnpm run build --filter=*`
- dev script uses `pnpm run dev --filter=*`
- start script uses `pnpm --filter=@antigravity/backend start`
- All scripts tested and functional locally
- Scripts documented in code comments if complex

**Dependencies:** US-001, US-002

---

#### US-004: Generate pnpm lockfile
**As a** developer  
**I want** a pnpm-lock.yaml file  
**So that** dependency versions are locked consistently

**Acceptance Criteria:**
- node_modules directories removed (root and all workspaces)
- package-lock.json removed from repository
- `pnpm install` executed successfully
- pnpm-lock.yaml generated and committed
- Dependency resolution verified against npm version (no missing/unexpected packages)
- Virtual store (.pnpm) created correctly

**Dependencies:** US-001, US-002, US-003

---

#### US-005: Update CI/CD pipeline for pnpm
**As a** developer  
**I want** CI/CD to use pnpm  
**So that** automated builds and tests run with the correct package manager

**Acceptance Criteria:**
- .github/workflows/ci.yml updated with pnpm/action-setup@v2
- pnpm version specified (e.g., version: 8)
- Cache strategy changed from 'npm' to 'pnpm'
- `npm ci` replaced with `pnpm install --frozen-lockfile`
- All `npm run` commands changed to `pnpm run`
- Workspace-specific commands use --filter flag
- CI pipeline tested successfully on feature branch

**Dependencies:** US-004

---

#### US-007: Validate pnpm build process
**As a** developer  
**I want** to verify that pnpm build works  
**So that** the migration doesn't break builds

**Acceptance Criteria:**
- `pnpm build` executes successfully
- `pnpm --filter=@antigravity/backend typecheck` passes
- `pnpm audit` runs successfully
- `pnpm dev` workflow tested and functional
- No node_modules hoisting issues detected
- All workspace dependencies resolve correctly

**Dependencies:** US-004, US-005

---

#### US-010: Verify CI builds on all Node versions
**As a** developer  
**I want** CI to pass on Node 18.x and 20.x  
**So that** compatibility is maintained

**Acceptance Criteria:**
- CI builds pass on Node 18.x
- CI builds pass on Node 20.x
- All CI jobs (build, security audit, type checking) succeed
- No regression in build times compared to baseline
- Matrix strategy properly configured in CI workflow

**Dependencies:** US-005, US-007

---

### 3.3 Documentation & Developer Experience (Priority 3)

#### US-006: Update .gitignore for pnpm
**As a** developer  
**I want** .gitignore to handle pnpm-specific files  
**So that** unnecessary files are not committed

**Acceptance Criteria:**
- .gitignore updated with pnpm-specific entries if needed
- pnpm-lock.yaml is tracked (not ignored)
- package-lock.json exclusion verified
- .pnpm-store/ ignored if present in repo root

**Dependencies:** US-004

---

#### US-008: Update README with pnpm installation instructions
**As a** developer  
**I want** clear pnpm setup documentation  
**So that** I can get started quickly

**Acceptance Criteria:**
- README.md includes pnpm installation instructions (`npm install -g pnpm` or `corepack enable`)
- Common pnpm commands documented (install, build, dev, test)
- Workspace command examples with --filter syntax included
- Migration from npm to pnpm explained for new contributors
- Prerequisites section updated

**Dependencies:** US-007

---

#### US-009: Create migration guide for contributors
**As a** contributor  
**I want** a migration guide  
**So that** I can transition from npm to pnpm smoothly

**Acceptance Criteria:**
- Migration guide created (MIGRATION.md or section in README)
- Step-by-step instructions for existing contributors
- npm to pnpm command mapping table documented (npm install → pnpm install, npm run → pnpm run, etc.)
- Common issues and solutions included (e.g., peer dependency warnings)
- IDE/tooling compatibility notes added (VSCode, WebStorm integration)
- Troubleshooting section for clean install procedures

**Dependencies:** US-008

---

## 4. Technical Specifications

### 4.1 Architecture Changes
- **Workspace Structure**: No changes to apps/backend and apps/web layout
- **Dependency Storage**: Migrating from flat node_modules to pnpm's content-addressable store
- **Linking Strategy**: Symlinks from virtual store to node_modules
- **Hoisting**: Disabled by default (strict mode) unless specific packages require shamefully-hoist

### 4.2 Configuration Files

#### pnpm-workspace.yaml
```yaml
packages:
  - 'apps/*'
```

#### .npmrc
```
auto-install-peers=true
strict-peer-dependencies=false
# shamefully-hoist=false (default, can be enabled if needed)
```

#### .github/workflows/ci.yml (key changes)
```yaml
- uses: pnpm/action-setup@v2
  with:
    version: 8
- uses: actions/setup-node@v4
  with:
    node-version: ${{ matrix.node-version }}
    cache: 'pnpm'
- run: pnpm install --frozen-lockfile
- run: pnpm run build
```

### 4.3 Dependencies
- **pnpm version**: 8.x (latest stable)
- **Node.js compatibility**: 18.x, 20.x
- **Existing dependencies**: No changes to package.json dependencies

### 4.4 Security Considerations
- pnpm audit integrated into CI pipeline
- Lockfile integrity validated in CI via --frozen-lockfile
- No phantom dependencies due to strict linking

## 5. Implementation Plan

### 5.1 Phased Rollout
**Phase 1: Foundation (US-001, US-002)**
- Create workspace and configuration files
- Duration: 1 day

**Phase 2: Migration (US-003, US-004)**
- Update scripts and generate lockfile
- Local testing
- Duration: 1-2 days

**Phase 3: CI/CD (US-005, US-007, US-010)**
- Update pipelines
- Validate builds
- Duration: 1-2 days

**Phase 4: Documentation (US-006, US-008, US-009)**
- Update docs and guides
- Duration: 1 day

**Total Estimated Duration**: 4-6 days

### 5.2 Rollout Strategy
**Big Bang Migration**: All developers switch to pnpm simultaneously when feature branch is merged to master.

**Execution Plan:**
1. Complete all user stories on feature/standardize-pnpm branch
2. Validate all acceptance criteria pass
3. Run full CI pipeline on feature branch
4. Create PR with comprehensive description and migration checklist
5. Team review and approval
6. Merge to master during low-activity period
7. Team notification via Slack/communication channel
8. All developers run clean install with pnpm

**Communication Plan:**
- Pre-merge: Team notification 24 hours before merge
- Merge notification: Immediate Slack announcement with migration steps
- Post-merge: Daily standup check-ins for 3 days to address issues

### 5.3 Testing Strategy
- **Local Testing**: Each user story validated on developer machine
- **CI Testing**: Feature branch CI must pass completely before merge
- **Smoke Testing**: Post-merge verification that all core workflows function
- **Regression Testing**: Compare build outputs between npm and pnpm builds

## 6. Risk Assessment & Mitigation

### 6.1 Risk Level: Low
The migration is considered low-risk based on:
- pnpm is a mature, widely-adopted package manager
- No changes to actual dependencies or code
- Feature branch allows complete validation before merge
- Rollback is straightforward (revert commit, reinstall with npm)

### 6.2 Identified Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Dependency resolution differences | Medium | Medium | Thorough testing in US-004, US-007; validate all apps build successfully |
| CI pipeline failures | Low | High | Complete CI validation in US-005, US-010 before merge |
| Developer onboarding friction | Medium | Low | Comprehensive documentation in US-008, US-009 |
| IDE/tooling incompatibility | Low | Low | Test with common IDEs; document workarounds in migration guide |
| Phantom dependency issues surface | Medium | Medium | Beneficial - forces proper dependency declarations; fix as discovered |

### 6.3 Rollback Plan
If critical issues arise post-merge:
1. Revert the merge commit
2. Delete pnpm-lock.yaml and pnpm-workspace.yaml
3. Restore package-lock.json from previous commit
4. Run `npm ci` to restore npm-based installation
5. Investigate issues on feature branch before retry

## 7. Open Questions
- [ ] Should we enforce pnpm version via package.json "packageManager" field?
- [ ] Do we need to update any Docker configurations that reference npm?
- [ ] Are there any internal tools/scripts that hardcode npm commands?
- [ ] Should we set up renovate/dependabot configurations for pnpm?

## 8. Appendix

### 8.1 Command Mapping Reference
| npm command | pnpm equivalent |
|-------------|-----------------|
| npm install | pnpm install |
| npm install <pkg> | pnpm add <pkg> |
| npm uninstall <pkg> | pnpm remove <pkg> |
| npm run <script> | pnpm run <script> or pnpm <script> |
| npm run build --workspace=backend | pnpm --filter=@antigravity/backend build |
| npm ci | pnpm install --frozen-lockfile |
| npm audit | pnpm audit |
| npm outdated | pnpm outdated |

### 8.2 References
- [pnpm Documentation](https://pnpm.io/)
- [pnpm Workspaces](https://pnpm.io/workspaces)
- [Migrating from npm](https://pnpm.io/migration)
- [pnpm CLI Reference](https://pnpm.io/cli/install)

### 8.3 Stakeholders
- **Engineering Team**: Primary users, responsible for adoption
- **DevOps/Platform**: CI/CD pipeline updates
- **Tech Lead**: Final approval and rollout coordination

---

**Document Version**: 1.0  
**Last Updated**: 2026-01-14  
**Status**: Draft → Ready for Review  
**Branch**: feature/standardize-pnpm