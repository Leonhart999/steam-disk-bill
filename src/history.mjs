// Optional local scan history. Off by default; nothing is written until the user turns it on.
// Stored as JSON under %LOCALAPPDATA%\SteamDiskBill (override with STEAM_DISK_BILL_DATA).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LIMIT = 180;

export function createHistory(folder = process.env.STEAM_DISK_BILL_DATA || path.join(process.env.LOCALAPPDATA || os.homedir(), 'SteamDiskBill')) {
    const settingsFile = path.join(folder, 'settings.json');
    const historyFile = path.join(folder, 'history.json');

    async function readJson(file, fallback) {
        try {
            return JSON.parse(await readFile(file, 'utf8'));
        } catch {
            return fallback;
        }
    }

    async function writeJson(file, value) {
        await mkdir(folder, { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(value));
        await rename(temporary, file);
    }

    async function enabled() {
        return (await readJson(settingsFile, {})).saveHistory === true;
    }

    async function entries() {
        const list = await readJson(historyFile, []);
        return Array.isArray(list) ? list : [];
    }

    function summarize(report) {
        const online = report.rows.filter((row) => !row.offline);
        return {
            scannedAt: report.scannedAt,
            installed: report.totals.installed,
            caches: report.totals.orphanShader + report.totals.orphanWorkshop,
            workshop: report.totals.workshop,
            downloads: report.totals.downloads,
            libraries: report.libraryRows.map((lib) => ({ path: lib.path, online: lib.online, installed: lib.installed, free: lib.free, total: lib.total })),
            apps: online.map((row) => [row.appid, row.name, row.size + row.shader + row.workshop]),
        };
    }

    async function record(report) {
        if (!(await enabled())) return false;
        const list = await entries();
        if (list.at(-1)?.scannedAt === report.scannedAt) return false;
        list.push(summarize(report));
        await writeJson(historyFile, list.slice(-LIMIT));
        return true;
    }

    async function setEnabled(value, report) {
        await writeJson(settingsFile, { saveHistory: value === true });
        if (value === true && report) await record(report);
    }

    async function clear() {
        await rm(historyFile, { force: true });
    }

    async function state() {
        return { enabled: await enabled(), location: folder, limit: LIMIT, entries: await entries() };
    }

    return { record, setEnabled, clear, state };
}
