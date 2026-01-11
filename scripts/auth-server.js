const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// Constants
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
    "openid"
];

// PKCE Generation
function base64URLEncode(str) {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

const verifier = base64URLEncode(crypto.randomBytes(32));
const challenge = base64URLEncode(sha256(verifier));

function generateAuthUrl() {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', SCOPES.join(' '));
    authUrl.searchParams.append('access_type', 'offline');
    authUrl.searchParams.append('prompt', 'consent');
    authUrl.searchParams.append('code_challenge', challenge);
    authUrl.searchParams.append('code_challenge_method', 'S256');
    return authUrl.toString();
}

async function exchangeCode(code) {
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const params = new URLSearchParams();
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code_verifier', verifier);

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    const tokens = await response.json();
    if (!response.ok) {
        throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
    }
    return tokens;
}

function saveAccount(tokens) {
    const configDir = path.join(os.homedir(), '.config', 'opencode');
    const accountFile = path.join(configDir, 'antigravity-accounts.json');

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    let accountsData = { accounts: [] };
    if (fs.existsSync(accountFile)) {
        try {
            accountsData = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
        } catch (e) { /* ignore */ }
    }

    let email = 'unknown_user';
    if (tokens.id_token) {
        try {
            const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString());
            if (payload.email) email = payload.email;
        } catch (e) { }
    }

    const existingIndex = accountsData.accounts.findIndex(a => a.email === email);
    const newAccount = {
        email: email,
        refreshToken: tokens.refresh_token,
        projectId: '',
        addedAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
        accountsData.accounts[existingIndex] = { ...accountsData.accounts[existingIndex], ...newAccount };
    } else {
        accountsData.accounts.push(newAccount);
    }

    fs.writeFileSync(accountFile, JSON.stringify(accountsData, null, 2));
    return email;
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);

    if (parsedUrl.pathname === '/') {
        const authUrl = generateAuthUrl();
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>Antigravity Auth</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            background-color: #0f172a;
            color: #e2e8f0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .card {
            background-color: #1e293b;
            padding: 2rem;
            border-radius: 1rem;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
            text-align: center;
            max-width: 400px;
            width: 100%;
            border: 1px solid #334155;
        }
        h1 { margin-top: 0; font-size: 1.5rem; color: #fff; }
        p { color: #94a3b8; margin-bottom: 2rem; }
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            background-color: #fff;
            color: #1f2937;
            font-weight: 500;
            padding: 0.75rem 1.5rem;
            border-radius: 0.5rem;
            text-decoration: none;
            transition: all 0.2s;
            gap: 12px;
            width: 100%;
            box-sizing: border-box;
            border: 1px solid #e5e7eb;
        }
        .btn:hover { background-color: #f9fafb; }
        .success { color: #4ade80; }
        .error { color: #f87171; text-align: left; background: #450a0a; padding: 1rem; border-radius: 0.5rem; font-family: monospace; font-size: 0.8rem; overflow-x: auto; margin-top: 1rem;}
    </style>
</head>
<body>
    <div class="card">
        <h1>Connect Account</h1>
        <p>Authenticate with Google to enable the Antigravity Dashboard.</p>
        <a href="${authUrl}" class="btn">
            <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
        </a>
    </div>
</body>
</html>
        `);
    } else if (parsedUrl.pathname === '/oauth-callback') {
        const code = parsedUrl.query.code;
        try {
            if (!code) throw new Error('No code recieved');
            const tokens = await exchangeCode(code);
            console.log('Refresh token:', tokens.refresh_token);
            const email = saveAccount(tokens);

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>Success</title>
    <style>
        body { font-family: -apple-system, sans-serif; background: #0f172a; color: #fff; height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
        .card { background: #1e293b; padding: 2rem; border-radius: 1rem; text-align: center; border: 1px solid #334155; }
        h1 { color: #4ade80; }
        p { color: #94a3b8; }
        .btn { display: inline-block; background-color: #3b82f6; color: white; padding: 0.5rem 1rem; text-decoration: none; border-radius: 0.25rem; margin-top: 1rem; font-weight: 500;}
        .btn:hover { background-color: #2563eb; }
        .btn-secondary { background-color: #334155; margin-left: 0.5rem; }
        .btn-secondary:hover { background-color: #475569; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Authentication Successful</h1>
        <p>Connected as <strong>${email}</strong></p>
        <p>The account has been saved. The dashboard should update automatically.</p>
        
        <div style="margin-top: 2rem;">
            <a href="/" class="btn">Add Another Account</a>
            <button onclick="window.close()" class="btn btn-secondary">Close Window</button>
        </div>
    </div>
</body>
</html>
            `);
            console.log(`Successfully authenticated: ${email}`);
            console.log('Server is still running. You can add another account or press Ctrl+C to stop.');
            // Removed process.exit(0) to allow adding multiple accounts
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
<!DOCTYPE html>
<html>
<head><title>Error</title><style>body{background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif}.err{color:#f87171;background:#450a0a;padding:2rem;border-radius:1rem}</style></head>
<body><div class="err"><h1>Authentication Failed</h1><pre>${e.message}\n\n${JSON.stringify(e, null, 2)}</pre><br><a href="/" style="color:#fff">Try Again</a></div></body>
</html>
            `);
            console.error(e);
        }
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(51121, () => {
    console.log('Auth server running at http://localhost:51121');
    const startCmd = process.platform === 'win32' ? 'start' : 'open';
    exec(`${startCmd} http://localhost:51121`);
});
