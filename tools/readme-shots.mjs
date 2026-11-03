// Renders the README screenshots from made-up demo data, so no real library is published.
// Usage: node tools/readme-shots.mjs  (stop any running instance first; it uses port 47331)
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs');
const data = path.join(root, '.test-tmp', 'readme-data');
const GIB = 1024 ** 3;
const now = Math.floor(Date.now() / 1000);
const day = 86400;

const games = [
    ['900001', 'Starfall Tactics', '星落战术', 86.4, 3, 'C', 4.1, 0],
    ['900002', 'Harbor Lights', '港湾灯火', 61.2, 410, 'C', 0, 12.6],
    ['900003', 'Iron Orchard', null, 48.7, 0, 'C', 0.8, 0],
    ['900004', 'Pixel Kitchen Deluxe', '像素厨房豪华版', 23.5, 21, 'C', 0, 0],
    ['900005', 'Deep Signal', '深层信号', 19.9, 900, 'C', 0.2, 0],
    ['900006', 'Moonlit Rally', null, 41.3, 15, 'E', 1.6, 2.4],
    ['900007', 'Cobalt Frontier', '钴蓝边境', 72.8, 200, 'E', 0, 0],
    ['900008', 'Paper Lanterns', '纸灯笼', 3.1, 2, 'E', 0, 0],
    ['900009', 'Tiny Tram Tycoon', null, 6.4, 1200, 'E', 0, 0.7],
];
const libraries = { C: 'C:\\Program Files (x86)\\Steam', E: 'E:\\SteamLibrary', F: 'F:\\Games\\SteamLibrary' };
const rows = games.map(([appid, name, nameZh, size, ageDays, lib, shader, workshop]) => ({
    appid, name, nameZh, library: libraries[lib], installDir: name, size: size * GIB,
    lastPlayed: ageDays ? now - ageDays * day : 0, offline: false, redist: false, missing: [],
    never: !ageDays, cold: !ageDays || ageDays >= 730, incomplete: false, installMissing: false,
    shader: shader * GIB, workshop: workshop * GIB,
}));
rows.push({ appid: '228980', name: 'Steamworks Common Redistributables', nameZh: null, library: libraries.C, installDir: 'Steamworks Shared', size: 0.4 * GIB, lastPlayed: 0, offline: false, redist: true, missing: [], never: true, cold: false, incomplete: false, installMissing: false, shader: 0, workshop: 0 });
for (const [appid, name, size] of [['900010', 'Skyline Racers', 54.2], ['900011', 'Ember Saga', 38.9]]) {
    rows.push({ appid, name, nameZh: null, library: libraries.F, installDir: '', size: size * GIB, lastPlayed: 0, offline: true, redist: false, missing: [], never: false, cold: false, incomplete: false, installMissing: false, shader: 0, workshop: 0 });
}
let id = 0;
for (const row of rows) row.actions = { id: `demo-${id += 1}`, folder: `${row.library}\\steamapps\\common\\${row.installDir}`, canOpen: !row.offline, canRemove: !row.offline && !row.redist, mode: 'uninstall' };
const orphans = {
    shader: [{ appid: '900012', name: 'Neon Drift', nameZh: '霓虹漂移', library: libraries.C, bytes: 1.3 * GIB }],
    workshop: [{ appid: '900013', name: 'Castle Builder', nameZh: null, library: libraries.E, bytes: 3.6 * GIB }],
};
for (const row of [...orphans.shader, ...orphans.workshop]) row.actions = { id: `demo-${id += 1}`, folder: '', canOpen: true, canRemove: true, mode: 'recycle' };
const sum = (list) => list.reduce((total, value) => total + value, 0);
const online = rows.filter((row) => !row.offline);
const coldBytes = sum(online.filter((row) => row.cold && !row.redist).map((row) => row.size));
const installedOn = (key) => sum(rows.filter((row) => row.library === libraries[key]).map((row) => row.size));
const report = {
    ok: true, steamPath: libraries.C, coldDays: 730, scannedAt: now, elapsedMs: 3400, errors: [],
    libraryRows: [
        { path: libraries.C, volume: 'C:\\', online: true, free: 38 * GIB, total: 476 * GIB, installed: installedOn('C'), count: 6 },
        { path: libraries.E, volume: 'E:\\', online: true, free: 612 * GIB, total: 931 * GIB, installed: installedOn('E'), count: 4 },
        { path: libraries.F, volume: 'F:\\', online: false, free: 0, total: 0, installed: installedOn('F'), count: 2 },
    ],
    rows, orphans,
    totals: {
        installed: sum(online.map((row) => row.size)), cold: coldBytes,
        shader: sum(rows.map((row) => row.shader)), workshop: sum(rows.map((row) => row.workshop)),
        orphanShader: orphans.shader[0].bytes, orphanWorkshop: orphans.workshop[0].bytes,
        downloads: 5.8 * GIB, temp: 0, reclaimable: coldBytes + orphans.shader[0].bytes + orphans.workshop[0].bytes, emptyShaderDirs: 12,
    },
};
const trend = [338, 344, 351, 349, 357, 362, 371, 366, 374];
const history = {
    ok: true, enabled: true, location: 'C:\\Users\\you\\AppData\\Local\\SteamDiskBill', limit: 180,
    entries: trend.map((gib, index) => {
        const last = index === trend.length - 1;
        const apps = online.map((row) => [row.appid, row.name, row.size + row.shader + row.workshop]);
        if (!last) apps.find((app) => app[0] === '900001')[2] -= 9.6 * GIB;
        if (!last) apps.find((app) => app[0] === '900006')[2] += 0;
        if (!last) apps.push(['900014', 'Old Racer', 7.2 * GIB]);
        return { scannedAt: now - (trend.length - 1 - index) * 7 * day, installed: gib * GIB, caches: 4.9 * GIB, workshop: 15.7 * GIB, downloads: 0, libraries: [], apps };
    }),
};
const palette = [['#1f4e79', '#3f8fd2'], ['#5a2e6e', '#b55d9b'], ['#2f5d3a', '#7cb36b'], ['#6e3b1f', '#d08a46'], ['#283a5e', '#6a7fd1'], ['#5e2a2a', '#c75b5b']];
function cover(appid) {
    const row = [...rows, ...orphans.shader, ...orphans.workshop].find((item) => item.appid === appid);
    const [from, to] = palette[Number(appid) % palette.length];
    const title = (row?.name || '').toUpperCase();
    return `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="215" viewBox="0 0 460 215"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="460" height="215" fill="url(#g)"/><circle cx="380" cy="40" r="90" fill="#ffffff" opacity=".08"/><text x="28" y="130" font-family="Segoe UI, sans-serif" font-size="34" font-weight="700" fill="#ffffff" letter-spacing="2">${title}</text></svg>`;
}

await rm(data, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'src', 'server.mjs'), '--no-open'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, STEAM_DISK_BILL_DATA: data } });
await new Promise((resolve) => server.stdout.on('data', (chunk) => { if (String(chunk).includes('http')) resolve(); }));
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
try {
    for (const [locale, suffix] of [['en-US', 'en'], ['zh-CN', 'zh']]) {
        const context = await browser.newContext({ locale, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.route('**/api/scan?*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(report) }));
        await page.route('**/api/history', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(history) }));
        await page.route('**/art/*', (route) => route.fulfill({ contentType: 'image/svg+xml', body: cover(route.request().url().split('/').pop()) }));
        await page.goto('http://127.0.0.1:47331/', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body.has-report');
        await page.waitForSelector('#history-body .chart-line');
        await page.waitForFunction(() => [...document.images].every((image) => image.complete));
        await page.screenshot({ path: path.join(output, `overview-${suffix}.png`) });
        await page.locator('.expand-button').nth(1).click();
        const games = page.locator('.games-section');
        await games.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `games-${suffix}.png`), clip: await games.boundingBox().then((box) => ({ x: box.x - 24, y: box.y - 12, width: box.width + 48, height: Math.min(box.height, 640) + 24 })) });
        const chart = page.locator('#history-body .chart');
        await chart.scrollIntoViewIfNeeded();
        const box = await chart.boundingBox();
        await page.mouse.move(box.x + box.width * 0.82, box.y + box.height / 2);
        const section = await page.locator('.history-section').boundingBox();
        await page.screenshot({ path: path.join(output, `trend-${suffix}.png`), clip: { x: section.x - 24, y: section.y - 12, width: section.width + 48, height: section.height + 24 } });
        await context.close();
    }
    console.log(`Screenshots written to ${path.relative(root, output)}`);
} finally {
    await browser.close();
    server.kill();
    await rm(data, { recursive: true, force: true });
}
