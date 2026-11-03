import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadLibraries } from './scan.mjs';
import * as windows from './windows-actions.mjs';

export class ActionError extends Error {
    constructor(code) { super(code); this.code = code; }
}

function requireSafeDirectory(library, folder, recursive = false) {
    const root = path.resolve(library);
    const target = path.resolve(folder);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ActionError('unsafePath');
    let current = root;
    for (const part of ['', ...relative.split(path.sep)]) {
        current = path.join(current, part);
        const entry = lstatSync(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ActionError('unsafePath');
    }
    if (realpathSync(target).toLowerCase() !== target.toLowerCase()) throw new ActionError('unsafePath');
    if (recursive) {
        const pending = [target];
        while (pending.length) {
            const directory = pending.pop();
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isSymbolicLink()) throw new ActionError('unsafePath');
                if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
            }
        }
    }
    const stat = lstatSync(target);
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

export function createActions(effects = windows) {
    let snapshot = null;
    let running = false;
    const targets = new Map();
    const tickets = new Map();

    function invalidate() { snapshot = null; targets.clear(); tickets.clear(); }

    function register(report) {
        invalidate();
        snapshot = report;
        function attach(row, kind = 'game') {
            const id = randomUUID();
            const allowed = /^\d+$/.test(row.appid) && !row.offline && !row.redist;
            let folder = '';
            if (allowed && kind !== 'game') folder = path.join(row.library, 'steamapps', ...(kind === 'shader' ? ['shadercache'] : ['workshop', 'content']), row.appid);
            else if (allowed && row.installDir && path.basename(row.installDir) === row.installDir && !/[<>:"|?*]/.test(row.installDir)) folder = path.join(row.library, 'steamapps', 'common', row.installDir);
            let canOpen = false;
            if (folder) {
                try { requireSafeDirectory(row.library, folder); canOpen = true; } catch { /* Unavailable and linked paths are not actionable. */ }
            }
            const mode = kind === 'game' ? 'uninstall' : 'recycle';
            const canRemove = allowed && (mode === 'uninstall' || (canOpen && !report.errors.length));
            row.actions = { id, folder, canOpen, canRemove, mode };
            targets.set(id, { ...row.actions, appid: row.appid, name: row.name || `App ${row.appid}`, library: row.library, kind });
        }
        report.rows.forEach((row) => attach(row));
        for (const kind of ['shader', 'workshop']) report.orphans[kind].forEach((row) => attach(row, kind));
        return report;
    }

    function validate(target, remove = false) {
        if (!snapshot || !target) throw new ActionError('staleTarget');
        const libraries = loadLibraries(snapshot.steamPath);
        if (!libraries.some((lib) => path.resolve(lib.path).toLowerCase() === path.resolve(target.library).toLowerCase())) throw new ActionError('staleTarget');
        if (target.kind === 'game') {
            if (!existsSync(path.join(target.library, 'steamapps', `appmanifest_${target.appid}.acf`))) throw new ActionError('staleTarget');
        } else if (remove) {
            if (snapshot.errors.length) throw new ActionError('scanIncomplete');
            for (const library of libraries) {
                if (existsSync(path.join(library.path, 'steamapps', `appmanifest_${target.appid}.acf`)) || Object.hasOwn(library.apps, target.appid)) throw new ActionError('cacheInUse');
                if (existsSync(path.join(library.path, 'steamapps', 'downloading', target.appid))) throw new ActionError('cacheInUse');
            }
        }
        if (target.folder && (target.canOpen || target.kind !== 'game')) return requireSafeDirectory(target.library, target.folder, remove && target.kind !== 'game');
        return '';
    }

    async function perform(body) {
        if (running) throw new ActionError('actionBusy');
        if (!body || typeof body !== 'object') throw new ActionError('invalidRequest');
        const target = targets.get(body.id);
        if (!target) throw new ActionError('staleTarget');
        if (body.operation === 'open') {
            if (!target.canOpen) throw new ActionError('unavailableTarget');
            validate(target);
            await effects.launch('explorer.exe', [target.folder]);
            return { ok: true, result: 'folderOpened' };
        }
        if (!target.canRemove) throw new ActionError('unavailableTarget');
        if (body.operation === 'prepare') {
            const identity = validate(target, true);
            tickets.clear();
            const ticket = randomUUID();
            tickets.set(ticket, { id: body.id, identity, expires: Date.now() + 120000 });
            return { ok: true, ticket, mode: target.mode, folder: target.folder || target.library, appid: target.appid, name: target.name };
        }
        if (body.operation !== 'commit' || body.confirmed !== true) throw new ActionError('confirmationRequired');
        const ticket = tickets.get(body.ticket);
        tickets.delete(body.ticket);
        if (!ticket || ticket.id !== body.id || ticket.expires < Date.now()) throw new ActionError('confirmationExpired');
        running = true;
        try {
            if (target.mode === 'recycle' && await effects.steamRunning()) throw new ActionError('steamRunning');
            if (validate(target, true) !== ticket.identity) throw new ActionError('staleTarget');
            if (target.mode === 'uninstall') {
                const executable = path.join(snapshot.steamPath, 'steam.exe');
                if (!existsSync(executable)) throw new ActionError('steamUnavailable');
                await effects.launch(executable, ['--', `steam://uninstall/${target.appid}`]);
                return { ok: true, result: 'uninstallRequested' };
            }
            await effects.recycle(target.folder);
            if (existsSync(target.folder)) throw new ActionError('operationFailed');
            targets.delete(body.id);
            return { ok: true, result: 'cacheRemoved' };
        } finally {
            running = false;
        }
    }

    return { register, invalidate, perform, get busy() { return running; } };
}
