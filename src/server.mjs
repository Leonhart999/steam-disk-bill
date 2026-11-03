// Local desktop window for Steam Disk Bill. Listens on 127.0.0.1 only.
// Closing the window stops the process after the page stops checking in.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ActionError, createActions } from './actions.mjs';
import { readAsset } from './assets.mjs';
import { createHistory } from './history.mjs';
import { scan } from './scan.mjs';

const PORT = 47331;
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const sessionToken = randomBytes(32).toString('hex');
const actions = createActions();
const history = createHistory();
const STATIC_FILES = {
    '/': { name: 'app/index.html', type: 'text/html; charset=utf-8' },
    '/index.html': { name: 'app/index.html', type: 'text/html; charset=utf-8' },
    '/styles.css': { name: 'app/styles.css', type: 'text/css; charset=utf-8' },
    '/app.js': { name: 'app/app.js', type: 'text/javascript; charset=utf-8' },
    '/i18n.js': { name: 'app/i18n.js', type: 'text/javascript; charset=utf-8' },
    '/history.js': { name: 'app/history.js', type: 'text/javascript; charset=utf-8' },
};
const EDGE_CANDIDATES = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

let lastBeat = Date.now();
let scanning = false;
let progress = null;
let lastReport = null;
let opened = false;
let artworkRoot = null;
const artworkFiles = new Map();

function findArtwork(appid) {
    if (!artworkRoot) return null;
    if (artworkFiles.has(appid)) return artworkFiles.get(appid);
    const candidates = [
        path.join(artworkRoot, `${appid}_header.jpg`),
        path.join(artworkRoot, `${appid}_library_600x900.jpg`),
    ];
    const folder = path.join(artworkRoot, appid);
    const folders = [folder];
    if (existsSync(folder)) {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.isSymbolicLink()) folders.push(path.join(folder, entry.name));
        }
    }
    const headers = [];
    const heroes = [];
    const portraits = [];
    for (const directory of folders) {
        if (!existsSync(directory)) continue;
        const relative = path.relative(realpathSync(artworkRoot), realpathSync(directory));
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue;
            const candidate = path.join(directory, entry.name);
            if (/^(library_header|header)(_[a-z]+)?\.jpg$/.test(entry.name)) headers.push(candidate);
            else if (/^library_hero\.jpg$/.test(entry.name)) heroes.push(candidate);
            else if (/^library_600x900(_[a-z]+)?\.jpg$/.test(entry.name)) portraits.push(candidate);
        }
    }
    candidates.push(...headers, ...heroes, ...portraits);
    let found = null;
    const canonicalRoot = realpathSync(artworkRoot) + path.sep;
    for (const candidate of candidates) {
        if (!existsSync(candidate)) continue;
        const canonical = realpathSync(candidate);
        if (!canonical.startsWith(canonicalRoot)) continue;
        found = canonical;
        break;
    }
    artworkFiles.set(appid, found);
    return found;
}

function clampDays(value) {
    const days = Number(value);
    if (!Number.isFinite(days)) {
        return 730;
    }
    return Math.min(3650, Math.max(1, Math.round(days)));
}

function sendJson(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
    });
    response.end(payload);
}

function openWindow(url) {
    const edge = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
    if (!edge) {
        console.log(`Edge was not found. Open ${url}`);
        return;
    }
    const child = spawn(edge, [`--app=${url}`, '--new-window', '--window-size=1120,820'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}

function trustedRequest(request, mutation = false) {
    if (request.headers.host !== `${HOST}:${PORT}`) return false;
    if (request.headers.origin && request.headers.origin !== ORIGIN) return false;
    if (request.headers['sec-fetch-site'] === 'cross-site') return false;
    return !mutation || request.headers['x-disk-bill-token'] === sessionToken;
}

async function readJson(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ActionError('invalidRequest');
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) throw new ActionError('invalidRequest');
    }
    try { return JSON.parse(body); } catch { throw new ActionError('invalidRequest'); }
}

const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!trustedRequest(request)) {
        sendJson(response, 403, { ok: false, code: 'forbidden' });
        return;
    }
    const url = new URL(request.url || '/', ORIGIN);
    if (request.method === 'GET' && url.pathname === '/api/session') {
        sendJson(response, 200, { ok: true, token: sessionToken });
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/action') {
        if (!trustedRequest(request, true)) {
            sendJson(response, 403, { ok: false, code: 'forbidden' });
            return;
        }
        lastBeat = Date.now();
        try {
            sendJson(response, 200, await actions.perform(await readJson(request)));
        } catch (error) {
            const code = error instanceof ActionError ? error.code : error.actionCode || 'operationFailed';
            sendJson(response, 400, { ok: false, code });
        } finally { lastBeat = Date.now(); }
        return;
    }
    if (request.method === 'GET' && Object.hasOwn(STATIC_FILES, url.pathname)) {
        const asset = STATIC_FILES[url.pathname];
        const content = readAsset(asset.name);
        response.writeHead(200, {
            'Content-Type': asset.type,
            'Content-Length': content.length,
            'Cache-Control': 'no-store',
        });
        response.end(content);
        return;
    }
    const artworkMatch = /^\/art\/(\d+)$/.exec(url.pathname);
    if (request.method === 'GET' && artworkMatch) {
        try {
            const file = findArtwork(artworkMatch[1]);
            if (file) {
                const content = readFileSync(file);
                response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
                response.end(content);
                return;
            }
        } catch {
            // A missing or changing local cache falls back to the game's initials.
        }
        response.writeHead(204);
        response.end();
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/scan') {
        if (actions.busy || scanning) { sendJson(response, 409, { ok: false, error: 'Another scan or action is still running.' }); return; }
        actions.invalidate();
        scanning = true;
        progress = null;
        lastBeat = Date.now();
        const started = Date.now();
        try {
            const report = await scan(clampDays(url.searchParams.get('days')), (step) => { progress = step; });
            const cache = path.join(report.steamPath, 'appcache', 'librarycache');
            artworkRoot = existsSync(cache) ? cache : null;
            artworkFiles.clear();
            report.elapsedMs = Date.now() - started;
            lastReport = report;
            try {
                report.historySaved = await history.record(report);
            } catch {
                report.historySaved = false; // History is optional; a write failure must not hide the scan.
            }
            sendJson(response, 200, actions.register(report));
        } catch (error) {
            sendJson(response, 500, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            scanning = false;
            progress = null;
            lastBeat = Date.now();
        }
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/progress') {
        sendJson(response, 200, { ok: true, scanning, progress });
        return;
    }
    if (request.method === 'GET' && url.pathname === '/api/history') {
        sendJson(response, 200, { ok: true, ...(await history.state()) });
        return;
    }
    if (request.method === 'POST' && (url.pathname === '/api/history/settings' || url.pathname === '/api/history/clear')) {
        if (!trustedRequest(request, true)) {
            sendJson(response, 403, { ok: false, code: 'forbidden' });
            return;
        }
        try {
            if (url.pathname === '/api/history/clear') await history.clear();
            else await history.setEnabled((await readJson(request)).enabled === true, lastReport);
            sendJson(response, 200, { ok: true, ...(await history.state()) });
        } catch (error) {
            sendJson(response, 400, { ok: false, code: error instanceof ActionError ? error.code : 'operationFailed' });
        }
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
        lastBeat = Date.now();
        sendJson(response, 200, { ok: true });
        return;
    }
    if (request.method === 'POST' && url.pathname === '/api/shutdown') {
        if (!trustedRequest(request, true) || actions.busy) {
            sendJson(response, 403, { ok: false, code: 'forbidden' });
            return;
        }
        sendJson(response, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
});

server.on('error', (error) => {
    if (error && error.code === 'EADDRINUSE') {
        openWindow(`http://${HOST}:${PORT}/`);
        process.exit(0);
    }
    console.error(error);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    console.log(`Steam Disk Bill ${url}`);
    if (!process.argv.includes('--no-open')) openWindow(url);
    opened = true;
    setInterval(() => {
        if (opened && !scanning && !actions.busy && Date.now() - lastBeat > 8000) {
            process.exit(0);
        }
    }, 2000);
});
