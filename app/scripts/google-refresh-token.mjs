// One-time helper: get a Google OAuth refresh token for the calendar collector (B37).
// Runs on your own machine. Uses a Desktop-app OAuth client and a loopback redirect; prints the
// refresh token and writes nothing to disk. No dependencies (Node >= 18).
// Usage: node scripts/google-refresh-token.mjs --client-id ID --client-secret SECRET [--scopes calendar,gmail]
import http from 'http';
import crypto from 'crypto';

const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const clientId = arg('client-id') || process.env.GOOGLE_CLIENT_ID;
const clientSecret = arg('client-secret') || process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Usage: node scripts/google-refresh-token.mjs --client-id ID --client-secret SECRET [--scopes calendar,gmail]');
  process.exit(1);
}
const SCOPES = { calendar: 'https://www.googleapis.com/auth/calendar.readonly', gmail: 'https://www.googleapis.com/auth/gmail.readonly' };
const scopes = (arg('scopes') || 'calendar').split(',').map(s => SCOPES[s.trim()] || s.trim());

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
  const done = (msg) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(msg); };
  if (u.searchParams.get('state') !== state) return done('State mismatch; start again.');
  if (u.searchParams.get('error')) { done('Denied: ' + u.searchParams.get('error')); server.close(); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: u.searchParams.get('code'), client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
    }),
  });
  const data = await r.json();
  if (!data.refresh_token) {
    done('No refresh token returned. Check the terminal.');
    console.error('Token response had no refresh_token:', JSON.stringify({ ...data, access_token: data.access_token ? '…' : undefined }));
    console.error('Revoke the app at https://myaccount.google.com/permissions and run again (consent must be re-granted).');
  } else {
    done('Done. You can close this tab and go back to the terminal.');
    console.log('\nRefresh token (store it as a Worker secret, then clear your terminal):\n');
    console.log(data.refresh_token);
    console.log('\n  npx wrangler secret put GOOGLE_REFRESH_TOKEN');
    console.log('Granted scopes: ' + data.scope);
  }
  server.close();
});

let redirectUri;
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString();
  console.log('Open this URL in a browser signed in to the Google account to read from:\n\n' + auth + '\n\nWaiting for the redirect…');
});
