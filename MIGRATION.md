# Migration Guide: npm to pnpm

This guide helps existing contributors transition from npm to pnpm for the Antigravity Dashboard project.

## Quick Migration

If you've previously used npm with this project, follow these steps:

```bash
# 1. Remove npm artifacts
rm -rf node_modules
rm -rf apps/*/node_modules
rm -f package-lock.json apps/*/package-lock.json

# 2. Install pnpm (choose one method)
corepack enable && corepack prepare pnpm@latest --activate
# OR: npm install -g pnpm
# OR (macOS): brew install pnpm

# 3. Install dependencies
pnpm install

# 4. Verify everything works
pnpm run build
pnpm run dev
```

## Command Reference

### npm to pnpm Command Mapping

| Task | npm | pnpm |
|------|-----|------|
| Install all dependencies | `npm install` | `pnpm install` |
| Install from lockfile only | `npm ci` | `pnpm install --frozen-lockfile` |
| Add a dependency | `npm install <pkg>` | `pnpm add <pkg>` |
| Add a dev dependency | `npm install -D <pkg>` | `pnpm add -D <pkg>` |
| Remove a dependency | `npm uninstall <pkg>` | `pnpm remove <pkg>` |
| Update a dependency | `npm update <pkg>` | `pnpm update <pkg>` |
| Run a script | `npm run <script>` | `pnpm run <script>` or `pnpm <script>` |
| Run script in workspace | `npm run -w apps/web dev` | `pnpm --filter @antigravity/web dev` |
| List outdated packages | `npm outdated` | `pnpm outdated` |
| Audit for vulnerabilities | `npm audit` | `pnpm audit` |
| Clean cache | `npm cache clean --force` | `pnpm store prune` |

### Workspace Commands (--filter syntax)

pnpm uses `--filter` instead of npm's `-w/--workspace` flag:

```bash
# Run dev server for web app
pnpm --filter @antigravity/web dev

# Run dev server for backend
pnpm --filter @antigravity/backend dev

# Build a specific package
pnpm --filter @antigravity/web build

# Install dependency to specific package
pnpm --filter @antigravity/backend add express
pnpm --filter @antigravity/web add -D @types/react

# Run command in all apps
pnpm --filter "./apps/*" run build

# Run typecheck on backend only
pnpm run --filter @antigravity/backend typecheck
```

### Filter Pattern Reference

| Pattern | Matches |
|---------|---------|
| `@antigravity/web` | Exact package name |
| `./apps/*` | All packages in apps directory |
| `...@antigravity/web` | Package and all its dependencies |
| `@antigravity/web...` | Package and all dependents |
| `{apps/*}` | All direct children of apps |

## IDE and Tooling Integration

### VS Code

1. **Install the pnpm extension** (optional but recommended):
   - Search for "pnpm" in Extensions
   - Install "pnpm" by pnpm or "npm Intellisense" (works with pnpm)

2. **Configure TypeScript to use workspace version**:
   ```json
   // .vscode/settings.json
   {
     "typescript.tsdk": "node_modules/typescript/lib"
   }
   ```

3. **ESLint/Prettier will work automatically** - no changes needed

4. **Debugging**: Launch configurations work the same way. Example:
   ```json
   // .vscode/launch.json
   {
     "version": "0.2.0",
     "configurations": [
       {
         "type": "node",
         "request": "launch",
         "name": "Debug Backend",
         "runtimeExecutable": "pnpm",
         "runtimeArgs": ["run", "--filter", "@antigravity/backend", "dev"],
         "cwd": "${workspaceFolder}"
       }
     ]
   }
   ```

### WebStorm / IntelliJ IDEA

1. **Set pnpm as default package manager**:
   - Go to `Settings/Preferences` → `Languages & Frameworks` → `Node.js`
   - Set "Package manager" to your pnpm installation path
   - WebStorm 2022.1+ auto-detects pnpm from `pnpm-lock.yaml`

2. **Enable pnpm support for Run Configurations**:
   - When creating npm scripts, WebStorm will use pnpm automatically
   - For manual configurations, set "Package manager" to pnpm

3. **Indexing**: WebStorm handles pnpm's symlinked `node_modules` correctly

### Other Editors

- **Vim/Neovim**: LSP servers (tsserver, eslint) work without changes
- **Sublime Text**: Ensure LSP plugins point to the workspace typescript
- **Emacs**: lsp-mode and eglot work with pnpm projects automatically

## Common Issues and Solutions

### Peer Dependency Warnings

**Symptom**: Warnings like `WARN peer dependency X not installed`

**Cause**: pnpm is stricter about peer dependencies than npm

**Solutions**:

1. **Most warnings are informational** - they don't prevent the project from working

2. **If a package fails**, add the missing peer dependency:
   ```bash
   pnpm add <missing-peer-dependency>
   ```

3. **Configure auto-install** in `.npmrc` (already configured for this project):
   ```ini
   auto-install-peers=true
   ```

### "Module not found" Errors

**Symptom**: `Cannot find module 'X'` at runtime or in IDE

**Cause**: pnpm uses a strict `node_modules` structure - packages can only access their declared dependencies

**Solutions**:

1. **Check if dependency is declared** in the correct `package.json`:
   ```bash
   # Add to root
   pnpm add <package>

   # Add to specific workspace
   pnpm --filter @antigravity/backend add <package>
   ```

2. **For TypeScript type packages**, ensure `@types/*` is in devDependencies:
   ```bash
   pnpm --filter @antigravity/backend add -D @types/express
   ```

3. **If using a transitive dependency directly**, add it explicitly:
   ```bash
   # Bad: using a dependency of a dependency
   # Good: declare it in your package.json
   pnpm add <transitive-dependency>
   ```

### Lockfile Conflicts

**Symptom**: `pnpm-lock.yaml` has merge conflicts

**Solution**:
```bash
# 1. Accept either version (doesn't matter which)
git checkout --ours pnpm-lock.yaml
# OR: git checkout --theirs pnpm-lock.yaml

# 2. Regenerate the lockfile
pnpm install

# 3. Commit the resolved lockfile
git add pnpm-lock.yaml
git commit -m "fix: resolve lockfile conflict"
```

### Phantom Dependencies

**Symptom**: Code worked with npm but fails with pnpm

**Cause**: npm hoists all dependencies, allowing accidental use of undeclared packages

**Solution**: Declare all dependencies explicitly:
```bash
# Find which package provides the module
pnpm why <module-name>

# Add it to the appropriate package.json
pnpm --filter <workspace> add <module-name>
```

### Symlink Issues on Windows

**Symptom**: Permission errors or broken symlinks on Windows

**Solutions**:

1. **Enable Developer Mode** in Windows Settings → Update & Security → For Developers

2. **Or run as Administrator** when installing

3. **Or configure pnpm to use junctions**:
   ```bash
   pnpm config set node-linker hoisted
   ```
   Note: This loses some pnpm strictness benefits

## Clean Install Procedures

### Full Clean Reinstall

When you need to start fresh:

```bash
# 1. Remove all node_modules
rm -rf node_modules
rm -rf apps/*/node_modules

# 2. Clear pnpm store cache (optional, frees disk space)
pnpm store prune

# 3. Reinstall everything
pnpm install

# 4. Verify
pnpm run build
```

### Troubleshooting CI Failures

If CI fails but local works:

```bash
# 1. Match CI's frozen lockfile behavior
pnpm install --frozen-lockfile

# 2. If that fails, the lockfile is out of sync
pnpm install
git diff pnpm-lock.yaml

# 3. Commit updated lockfile if needed
git add pnpm-lock.yaml
git commit -m "chore: update pnpm lockfile"
```

### Resetting After Branch Switch

When switching branches with different dependencies:

```bash
# Quick reset
pnpm install

# If issues persist, full clean
rm -rf node_modules apps/*/node_modules
pnpm install
```

## Why pnpm?

### Benefits

- **Faster installs**: Content-addressable storage with hard links means packages are downloaded once and linked
- **Disk efficient**: Global store shared across all projects on your machine
- **Strict dependencies**: Only declared dependencies are accessible (catches bugs early)
- **Better monorepo support**: Native workspace protocol with filtering
- **Reproducible builds**: Stricter lockfile format

### Performance Comparison

| Metric | npm | pnpm |
|--------|-----|------|
| Fresh install (no cache) | ~45s | ~15s |
| Install with cache | ~20s | ~3s |
| Disk usage (this project) | ~450MB | ~150MB* |

*pnpm uses hard links to a global store, so actual disk usage is shared across projects

## Getting Help

- **pnpm documentation**: https://pnpm.io
- **Project issues**: https://github.com/NoeFabris/antigravity-dashboard/issues
- **pnpm Discord**: https://discord.gg/pnpm
