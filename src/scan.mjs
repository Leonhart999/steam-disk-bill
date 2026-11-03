// Read-only Steam library scan. Used by the desktop app and tools/preview.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';

const REDIST_APPID = '228980';
const FULLY_INSTALLED = 4;

let cachedSteamPath = '';

export function formatBytes(bytes) {
    if (!bytes) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseVdf(text) {
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    let index = 0;

    function skip() {
        while (index < text.length) {
            const char = text[index];
            if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
                index += 1;
            } else if (char === '/' && text[index + 1] === '/') {
                while (index < text.length && text[index] !== '\n') {
                    index += 1;
                }
            } else {
                return;
            }
        }
    }

    function parseString() {
        skip();
        if (text[index] !== '"') {
            throw new Error(`expected string at ${index}`);
        }
        index += 1;
        let out = '';
        while (index < text.length) {
            const char = text[index];
            if (char === '"') {
                index += 1;
                return out;
            }
            if (char === '\\') {
                out += text[index + 1] ?? '';
                index += 2;
            } else {
                out += char;
                index += 1;
            }
        }
        throw new Error('unterminated string');
    }

    function parseValue() {
        skip();
        if (text[index] === '"') {
            return parseString();
        }
        if (text[index] === '{') {
            index += 1;
            const object = {};
            while (true) {
                skip();
                if (index >= text.length) {
                    throw new Error('unterminated object');
                }
                if (text[index] === '}') {
                    index += 1;
                    return object;
                }
                const key = parseString();
                object[key] = parseValue();
            }
        }
        throw new Error(`expected value at ${index}`);
    }

    skip();
    parseString();
    return parseValue();
}

function findSteam() {
    if (cachedSteamPath) {
        return cachedSteamPath;
    }
    if (process.env.STEAM_PATH && existsSync(path.join(process.env.STEAM_PATH, 'steamapps', 'libraryfolders.vdf'))) {
        cachedSteamPath = process.env.STEAM_PATH;
        return cachedSteamPath;
    }
    try {
        const registered = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-Command', '(Get-ItemProperty HKCU:\\Software\\Valve\\Steam).SteamPath'],
            { encoding: 'utf8' },
        ).trim();
        if (registered && existsSync(path.join(registered, 'steamapps', 'libraryfolders.vdf'))) {
            cachedSteamPath = registered;
            return cachedSteamPath;
        }
    } catch {
        // Registry lookup is only a convenience.
    }
    const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean);
    for (const candidate of programFiles.map((directory) => path.join(directory, 'Steam'))) {
        if (existsSync(path.join(candidate, 'steamapps', 'libraryfolders.vdf'))) {
            cachedSteamPath = candidate;
            return cachedSteamPath;
        }
    }
    throw new Error('Steam install not found. Set STEAM_PATH.');
}

function dirSize(root) {
    let total = 0;
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            total += dirSize(full);
        } else if (entry.isFile()) {
            try {
                total += statSync(full).size;
            } catch {
                // A file can disappear mid-scan. Skip it.
            }
        }
    }
    return total;
}

function hasBit(flags, mask) {
    return Math.floor(flags / mask) % 2 === 1;
}

function isRedist(appid, name) {
    const lower = (name || '').toLowerCase();
    return appid === REDIST_APPID || lower.includes('redistributable') || lower.includes('steamworks common');
}

function numericDirs(root) {
    const found = new Map();
    if (!existsSync(root)) {
        return found;
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
            found.set(entry.name, path.join(root, entry.name));
        }
    }
    return found;
}

function volumeFree(root) {
    if (typeof fs.statfsSync !== 'function') {
        return 0;
    }
    try {
        const stats = fs.statfsSync(root);
        return Number(stats.bavail) * Number(stats.bsize);
    } catch {
        return 0;
    }
}

export function loadLibraries(steamPath) {
    const body = parseVdf(readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const libraries = Object.entries(body)
        .filter(([, folder]) => folder && typeof folder === 'object' && typeof folder.path === 'string')
        .map(([key, folder]) => ({
            order: Number(key) || 0,
            path: folder.path,
            apps: Object.fromEntries(
                Object.entries(folder.apps || {}).map(([appid, size]) => [appid, Number(size) || 0]),
            ),
        }))
        .sort((left, right) => left.order - right.order);
    return libraries.length > 0 ? libraries : [{ order: 0, path: steamPath, apps: {} }];
}

function totalBytes(row) {
    return row.size + row.shader + row.workshop;
}

export function scan(coldDays) {
    const steamPath = findSteam();
    const now = Math.floor(Date.now() / 1000);
    const libraries = loadLibraries(steamPath);
    const known = new Set();
    const apps = [];
    const errors = [];

    for (const library of libraries) {
        const online = existsSync(library.path);
        if (!online) {
            for (const [appid, size] of Object.entries(library.apps)) {
                known.add(appid);
                apps.push({
                    appid,
                    name: `App ${appid}`,
                    library: library.path,
                    size,
                    lastPlayed: 0,
                    stateFlags: 0,
                    installdir: '',
                    shared: null,
                    offline: true,
                });
            }
            continue;
        }
        const steamapps = path.join(library.path, 'steamapps');
        if (!existsSync(steamapps)) {
            continue;
        }
        for (const name of readdirSync(steamapps)) {
            const match = name.match(/^appmanifest_(\d+)\.acf$/);
            if (!match) {
                continue;
            }
            let body;
            try {
                body = parseVdf(readFileSync(path.join(steamapps, name), 'utf8'));
            } catch (error) {
                errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            const appid = String(body.appid || match[1]);
            known.add(appid);
            apps.push({
                appid,
                name: body.name || `App ${appid}`,
                library: library.path,
                size: Number(body.SizeOnDisk) || library.apps[appid] || 0,
                lastPlayed: Number(body.LastPlayed) || 0,
                stateFlags: Number(body.StateFlags) || 0,
                installdir: body.installdir || '',
                shared: body.SharedDepots || null,
                offline: false,
            });
        }
    }

    const rows = apps.map((app) => {
        const redist = isRedist(app.appid, app.name);
        let missing = [];
        if (!app.offline && app.shared) {
            const owners = new Set();
            for (const owner of Object.values(app.shared)) {
                const id = String(owner);
                if (id !== app.appid && id !== REDIST_APPID && !known.has(id)) {
                    owners.add(id);
                }
            }
            missing = [...owners].sort();
        }
        const never = !app.offline && app.lastPlayed === 0;
        const cold = !app.offline && !redist && (never || now - app.lastPlayed >= coldDays * 86400);
        const installMissing =
            !app.offline &&
            app.installdir !== '' &&
            !existsSync(path.join(app.library, 'steamapps', 'common', app.installdir));
        return {
            appid: app.appid,
            name: app.name,
            library: app.library,
            installDir: app.installdir,
            size: app.size,
            lastPlayed: app.lastPlayed,
            offline: app.offline,
            redist,
            missing,
            never,
            cold,
            incomplete: !app.offline && !hasBit(app.stateFlags, FULLY_INSTALLED),
            installMissing,
            shader: 0,
            workshop: 0,
        };
    });

    const orphans = { shader: [], workshop: [] };

    function claim(libraryPath, root, field, bucket) {
        let orphanBytes = 0;
        let emptyDirs = 0;
        for (const [appid, folder] of numericDirs(root)) {
            const bytes = dirSize(folder);
            if (bytes <= 0) {
                emptyDirs += 1;
                continue;
            }
            const home = rows.find((row) => row.appid === appid && row.library === libraryPath && !row.offline);
            const target = home || rows.find((row) => row.appid === appid && !row.offline);
            if (target) {
                target[field] += bytes;
            } else {
                bucket.push({ appid, library: libraryPath, bytes });
                orphanBytes += bytes;
            }
        }
        return { orphanBytes, emptyDirs };
    }

    let orphanShader = 0;
    let orphanWorkshop = 0;
    let emptyShaderDirs = 0;
    let downloads = 0;
    let temp = 0;
    const libraryRows = [];

    for (const library of libraries) {
        const online = existsSync(library.path);
        if (online) {
            const shader = claim(library.path, path.join(library.path, 'steamapps', 'shadercache'), 'shader', orphans.shader);
            const workshop = claim(
                library.path,
                path.join(library.path, 'steamapps', 'workshop', 'content'),
                'workshop',
                orphans.workshop,
            );
            orphanShader += shader.orphanBytes;
            orphanWorkshop += workshop.orphanBytes;
            emptyShaderDirs += shader.emptyDirs;
            const downloading = path.join(library.path, 'steamapps', 'downloading');
            if (existsSync(downloading)) {
                for (const entry of readdirSync(downloading)) {
                    const full = path.join(downloading, entry);
                    try {
                        const stat = statSync(full);
                        downloads += stat.isDirectory() ? dirSize(full) : stat.size;
                    } catch {
                        errors.push(`downloading/${entry}: unreadable`);
                    }
                }
            }
            const staging = path.join(library.path, 'steamapps', 'temp');
            if (existsSync(staging)) {
                temp += dirSize(staging);
            }
        }
        const installed = rows.filter((row) => row.library === library.path);
        libraryRows.push({
            path: library.path,
            online,
            free: online ? volumeFree(library.path) : 0,
            installed: installed.reduce((sum, row) => sum + row.size, 0),
            count: installed.length,
        });
    }

    rows.sort((left, right) => totalBytes(right) - totalBytes(left));
    orphans.shader.sort((left, right) => right.bytes - left.bytes);
    orphans.workshop.sort((left, right) => right.bytes - left.bytes);

    const onlineRows = rows.filter((row) => !row.offline && !row.redist);
    const installedBytes = rows.filter((row) => !row.offline).reduce((sum, row) => sum + row.size, 0);
    const coldBytes = onlineRows.filter((row) => row.cold).reduce((sum, row) => sum + row.size, 0);

    return {
        ok: true,
        steamPath,
        coldDays,
        scannedAt: now,
        libraryRows,
        rows,
        orphans,
        errors,
        totals: {
            installed: installedBytes,
            cold: coldBytes,
            shader: rows.reduce((sum, row) => sum + row.shader, 0),
            workshop: rows.reduce((sum, row) => sum + row.workshop, 0),
            orphanShader,
            orphanWorkshop,
            downloads,
            temp,
            reclaimable: coldBytes + orphanShader + orphanWorkshop,
            emptyShaderDirs,
        },
    };
}
