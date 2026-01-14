# Antigravity Dashboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)

<img width="1265" height="1285" alt="1" src="https://github.com/user-attachments/assets/c45da008-01a4-4e5f-b53a-c517ded2ee32" />

<img width="1280" height="906" alt="2" src="https://github.com/user-attachments/assets/668bfa68-e1c1-4eee-b78c-c294021de0de" />


*Real-time quota monitoring with multi-account support*

Real-time monitoring dashboard for Google Cloud accounts using the [Antigravity OAuth flow](https://github.com/NoeFabris/opencode-antigravity-auth). Track API quotas, usage limits, and reset times across multiple accounts with a Claude/OpenAI compatible API proxy.

## Features

- **Multi-Account Monitoring** - Track multiple Google Cloud accounts simultaneously
- **Real-Time Quotas** - View Claude and Gemini model quota percentages with live updates
- **Reset Timers** - Countdown to quota reset for each account and model
- **Subscription Tier Detection** - Automatic FREE/PRO/ULTRA tier detection
- **Usage Analytics** - Token usage, request stats, burn rate calculations
- **Timeline Visualization** - Hourly usage graphs and quota history
- **Language Server Integration** - Connect to Antigravity VS Code extension
- **API Proxy** - Claude/OpenAI compatible API with automatic account rotation
- **Dark/Light Theme** - Full theme support with Tailwind CSS

## Prerequisites

- **Node.js 18+** (check with `node --version`)
- **pnpm 9+** - Fast, disk-efficient package manager (see [Installing pnpm](#installing-pnpm))
- **Google Cloud Account** with OAuth credentials configured
- **Antigravity accounts** - OAuth tokens from [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth)

### Installing pnpm

Choose one of these methods:

```bash
# Option 1: Using Corepack (recommended - built into Node.js 16.10+)
corepack enable
corepack prepare pnpm@latest --activate

# Option 2: Using npm
npm install -g pnpm

# Option 3: Using Homebrew (macOS)
brew install pnpm

# Verify installation
pnpm --version
```

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/NoeFabris/antigravity-dashboard.git
cd antigravity-dashboard
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Configure Google OAuth

> **IMPORTANT:** You must use the **same OAuth credentials** that the [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) plugin uses. Refresh tokens are cryptographically bound to the OAuth client that issued them. Using different credentials will result in `unauthorized_client` errors.

#### Configure Environment Variables

```bash
# Copy the example environment file - credentials are pre-configured!
cp .env.example .env
```

That's it! The `.env.example` file already contains the correct OAuth credentials from the plugin's source code:
- **Source:** [opencode-antigravity-auth/src/constants.ts](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts)

You do **NOT** need to create your own Google OAuth credentials.

### 4. Build and Start

```bash
# Build backend and frontend
pnpm run build

# Start the server
pnpm start
```

Dashboard available at: **http://localhost:3456**

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment file (credentials are pre-configured!)
cp .env.example .env

# 3. Build and launch
pnpm run build && pnpm start
```

Dashboard available at: **http://localhost:3456**

## Configuration

### Accounts File

Antigravity accounts are stored in `~/.config/opencode/antigravity-accounts.json`. This file is created by the [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) plugin.

```json
{
  "accounts": [
    {
      "email": "user@gmail.com",
      "refreshToken": "1//...",
      "projectId": "project-id",
      "addedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_PORT` | 3456 | Server port |
| `GOOGLE_CLIENT_ID` | (required) | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | (required) | Google OAuth client secret |
| `DASHBOARD_SECRET` | (optional) | Enable network access with auth |
| `DB_PATH` | (auto) | Custom SQLite database path |
| `DATA_RETENTION_DAYS` | 30 | Days to keep usage data |
| `LOG_LEVEL` | info | Logging verbosity |

See `.env.example` for all available options.

### Security: Network Access

By default, the dashboard binds to `localhost` only and is safe to run without authentication.

To enable network access (e.g., access from other machines):

1. Set `DASHBOARD_SECRET` in your `.env` file:
   ```env
   DASHBOARD_SECRET=your-secret-key-here
   ```

2. The server will bind to all interfaces (`0.0.0.0`)

3. All API requests require the secret as a Bearer token:
   ```bash
   curl -H "Authorization: Bearer your-secret-key-here" \
     http://your-server:3456/api/accounts
   ```

## API Proxy (Claude Code CLI)

The dashboard includes a built-in API proxy that allows you to use Claude Code CLI or any OpenAI-compatible client with your Antigravity accounts.

### Setup

```bash
# Get the API key (localhost only, or use Bearer auth)
curl -s http://localhost:3456/api/proxy/api-key | jq -r '.apiKey'

# Configure Claude Code CLI
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=<api-key-from-above>

# Use Claude Code CLI
claude "your prompt"
```

### Features

- **Automatic Account Rotation** - Selects accounts with highest quota
- **Model-Specific Selection** - Routes Claude requests to accounts with Claude quota, Gemini to Gemini quota
- **Rate Limit Handling** - Automatic retry with exponential backoff on 429 errors
- **Request Logging** - All requests logged to SQLite for analytics
- **WebSocket Notifications** - Real-time rate limit alerts

### Supported Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/messages` | Claude Messages API |
| `POST /v1/chat/completions` | OpenAI Chat Completions API |
| `GET /v1/models` | List available models |

## API Reference

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health check |
| `/api/accounts/local` | GET | List all accounts with burn rate |
| `/api/accounts/active` | GET | Get active account per model family |
| `/api/accounts/quota` | GET | Get cached quota data |
| `/api/accounts/quota/refresh` | POST | Force refresh quotas |
| `/api/accounts/enriched` | GET | Accounts with tier + model quotas |
| `/api/accounts/limits` | GET | Quota limits per model |
| `/api/accounts/timeline` | GET | Hourly usage timeline |

### Analytics Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/analytics/overview` | GET | Combined statistics |
| `/api/analytics/performance` | GET | Performance metrics |
| `/api/analytics/trends` | GET | Daily usage trends |
| `/api/hourly-stats` | GET | Hourly breakdown |
| `/api/recent-calls` | GET | Recent API calls log |

### Language Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/language-server/status` | GET | LS connection status |
| `/api/language-server/credits` | GET | Prompt + Flow credits |
| `/api/language-server/user` | GET | User info (email, tier) |

### WebSocket

Connect to `/ws` for live updates:

- `initial` - Full account state on connect
- `accounts_update` - Account status changes
- `config_update` - Quota updates
- `stats_update` - Statistics changes
- `rate_limit_change` - Rate limit events
- `ls_status_change` - Language Server status
- `heartbeat` - Connection keepalive

## Development

### Common pnpm Commands

```bash
# Install all dependencies
pnpm install

# Build all workspace packages
pnpm run build

# Start development mode (all packages)
pnpm run dev

# Start production server
pnpm start

# Run linting (oxlint - Rust-based, fast)
pnpm run lint

# Run linting with auto-fix
pnpm run lint:fix

# Run type checking
pnpm run typecheck
```

### Workspace Commands (--filter syntax)

pnpm uses the `--filter` flag to run commands in specific workspace packages:

```bash
# Run command in a specific package
pnpm --filter @antigravity/web dev        # Start web dev server
pnpm --filter @antigravity/backend dev    # Start backend dev server

# Build a specific package
pnpm --filter @antigravity/web build

# Install a dependency to a specific package
pnpm --filter @antigravity/backend add express
pnpm --filter @antigravity/web add -D @types/react

# Run commands in all app packages
pnpm --filter "./apps/*" run build

# Run type checking on backend only
pnpm run --filter @antigravity/backend typecheck
```

### Frontend Dev Server

Start with hot reload (proxies to backend):

```bash
pnpm --filter @antigravity/web dev
```

Dev server runs on port 5173 and proxies `/api` and `/ws` to port 3456.

### Backend Dev

Watch mode for TypeScript compilation:

```bash
pnpm --filter @antigravity/backend dev
```

## Project Structure

```
antigravity-dashboard/
├── apps/
│   ├── backend/              # Express API server
│   │   ├── src/
│   │   │   ├── server.ts     # Main server, API endpoints
│   │   │   ├── monitor.ts    # SQLite usage logging
│   │   │   └── services/
│   │   │       ├── quotaService.ts   # Google Cloud API
│   │   │       ├── accountsFile.ts   # Accounts file watcher
│   │   │       ├── tierDetection.ts  # Subscription detection
│   │   │       └── apiProxy/         # Claude/OpenAI proxy
│   │   └── dist/
│   │
│   └── web/                  # React frontend
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   ├── hooks/
│       │   └── stores/
│       └── dist/
│
├── .env.example
├── package.json
└── usage.db                  # SQLite (created at runtime)
```

## Tech Stack

**Backend:**
- Node.js + Express + TypeScript
- SQLite (better-sqlite3)
- WebSocket (ws)
- Helmet + rate limiting for security

**Frontend:**
- React 18 + TypeScript
- Vite
- Tailwind CSS
- Zustand (state management)
- Recharts (data visualization)

## How It Works

1. **OAuth Tokens** - Uses stored refresh tokens to get access tokens
2. **Cloud Code API** - Fetches quota from Google's Cloud Code API
3. **Polling** - Refreshes all accounts every 2 minutes
4. **WebSocket** - Broadcasts updates to connected clients
5. **SQLite** - Logs all API calls for analytics
6. **Tier Detection** - Analyzes quota patterns to detect subscription tier

## Troubleshooting

### OAuth Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `unauthorized_client` | Wrong OAuth credentials | Use the plugin's credentials (see Quick Start) |
| `invalid_client` | Missing or malformed credentials | Check `.env` file has correct `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` |
| `invalid_grant` | Refresh token expired or revoked | Re-authenticate via opencode-antigravity-auth plugin |

> **Why must I use the plugin's OAuth credentials?**
> 
> OAuth refresh tokens are cryptographically bound to the client ID that issued them. Your accounts file contains tokens created by the opencode-antigravity-auth plugin, so you must use the same OAuth client credentials to refresh them.

### Common Issues

- **Dashboard shows "Waiting for backend connection"** → Check if server is running on port 3456.
- **401 Unauthorized errors** → Make sure `DASHBOARD_SECRET` is set correctly in `.env`, or remove it for localhost-only mode.
- **WebSocket disconnects frequently** → Check network stability; the dashboard will auto-reconnect.
- **Quotas not updating** → Verify Google OAuth credentials are correct in `.env`.
- **Rate limit errors in proxy** → Your account quota may be exhausted; try another account or wait for reset.
- **Language Server not detected** → Make sure the Antigravity VS Code extension is running.

## Related Projects

- [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) - OpenCode plugin for Antigravity OAuth
- [OpenCode](https://opencode.ai) - AI coding assistant

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Migrating from npm to pnpm

If you previously used npm with this project, see the **[Migration Guide](MIGRATION.md)** for:
- Step-by-step migration instructions
- Complete npm to pnpm command mapping
- IDE/tooling setup (VS Code, WebStorm)
- Common issues and solutions
- Troubleshooting procedures

**Quick migration:**

```bash
rm -rf node_modules apps/*/node_modules package-lock.json
pnpm install
pnpm run build
```

**Key differences from npm:**
| npm | pnpm |
|-----|------|
| `npm install` | `pnpm install` |
| `npm run <script>` | `pnpm run <script>` or `pnpm <script>` |
| `npm run -w apps/web dev` | `pnpm --filter @antigravity/web dev` |
| `npm install <pkg>` | `pnpm add <pkg>` |
| `npm install -D <pkg>` | `pnpm add -D <pkg>` |
| `package-lock.json` | `pnpm-lock.yaml` |

## License

MIT - see [LICENSE](LICENSE) file for details.
