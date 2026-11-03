import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'screenshots');
const base = 'http://127.0.0.1:47331';
const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
});
const server = spawn(process.execPath, [path.join(root, 'src/server.mjs'), '--no-open'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stderr.on('data', (chunk) => { serverLog += chunk; });
const pageErrors = [];
const consoleErrors = [];

try {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Server did not start: ${serverLog}`)), 10000);
        server.once('error', reject);
        server.once('exit', (code) => reject(new Error(`Server exited: ${code} ${serverLog}`)));
        server.stdout.on('data', (chunk) => {
            if (String(chunk).includes('Disk Bill http')) { clearTimeout(timer); resolve(); }
        });
    });
    await mkdir(output, { recursive: true });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1120, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    let scanRequests = 0;
    page.on('request', (request) => { if (request.url().includes('/api/scan?')) scanRequests += 1; });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const reportPromise = page.waitForResponse((response) => response.url().includes('/api/scan?'), { timeout: 120000 }).then((response) => response.json());
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const report = await reportPromise;
    assert.equal(report.ok, true);
    await page.waitForSelector('body.has-report');
    const installed = report.rows.filter((app) => !app.offline && !app.redist);
    assert.equal(await page.locator('.game-row').count(), installed.length);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    const covers = await page.locator('.game-art img').count();
    assert.ok(covers > 0, 'At least one cached cover should load on this machine');
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    console.log(`PASS: real scan (${report.rows.length} apps), ${covers} local covers`);

    const search = page.locator('#search');
    await search.pressSequentially('Terraria', { delay: 60 });
    assert.equal(await search.inputValue(), 'Terraria');
    assert.equal(await page.locator('.game-row').count(), installed.filter((app) => app.name.toLowerCase().includes('terraria')).length);
    assert.equal(await search.evaluate((element) => document.activeElement === element), true);
    await search.fill('no-game-can-have-this-name-78427');
    assert.match(await page.locator('.empty-state').textContent(), /No matching games/);
    await search.fill('');
    console.log('PASS: multi-character search, focus and empty result');

    await page.locator('[data-view="cold"]').click();
    assert.equal(await page.locator('.game-row').count(), installed.filter((app) => app.cold).length);
    await page.locator('[data-days="365"]').click();
    const cold365 = installed.filter((app) => app.never || report.scannedAt - app.lastPlayed >= 365 * 86400);
    assert.equal(await page.locator('.game-row').count(), cold365.length);
    await page.locator('#copy').click();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /inactive after 365 days/);
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Leftover caches/);
    console.log('PASS: threshold updates immediately, inactive filter and copy');

    await page.locator('[data-view="cache"]').click();
    assert.equal(await page.locator('.game-row').count(), report.orphans.shader.length + report.orphans.workshop.length);
    await page.locator('[data-view="offline"]').click();
    assert.equal(await page.locator('.game-row').count(), report.rows.filter((app) => app.offline).length);
    const offlineIndex = report.libraryRows.findIndex((lib) => !lib.online);
    if (offlineIndex >= 0) {
        await page.locator(`#libraries [data-library="${offlineIndex}"]`).click();
        assert.equal(await page.locator('#list-heading').textContent(), 'Offline libraries');
    }
    await page.locator('#library-nav [data-library="all"]').click();
    await page.locator('[data-view="all"]').click();
    await page.locator('[data-days="730"]').click();
    await page.locator('#sort').selectOption('name');
    const sortedNames = await page.locator('.game-name').allTextContents();
    assert.deepEqual(sortedNames, installed.map((app) => app.name).sort((a, b) => a.localeCompare(b, 'en')));
    await page.locator('#sort').selectOption('size');
    const expand = page.locator('.expand-button').first();
    await expand.click();
    assert.equal(await expand.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('.game-details').first().isVisible(), true);
    const details = page.locator('.game-details').first();
    assert.equal(await details.locator('[data-app-action="open"]').isEnabled(), true);
    const removeButton = details.locator('[data-app-action="remove"]');
    assert.match(await removeButton.getAttribute('class'), /button-danger/);
    assert.equal(await removeButton.textContent(), 'Uninstall via Steam');
    // Only "prepare" is allowed to reach the server here; a commit would be a real uninstall request.
    const actionBodies = [];
    page.on('request', (request) => { if (request.url().endsWith('/api/action')) actionBodies.push(request.postDataJSON()); });
    await removeButton.click();
    const dialog = page.locator('#action-dialog');
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await page.locator('#action-name').textContent(), installed.slice().sort((a, b) => (b.size + b.shader + b.workshop) - (a.size + a.shader + a.workshop))[0].name);
    assert.equal(await page.locator('#action-confirm').isDisabled(), true);
    await page.locator('#action-ack').check();
    assert.equal(await page.locator('#action-confirm').isEnabled(), true);
    await page.screenshot({ path: path.join(output, 'confirm.png') });
    // App chrome only; game names come from Steam and may legitimately contain dots.
    const chromeText = await page.evaluate(() => [...document.querySelectorAll('button:not(.game-name), dialog, h1, h2, label, #status, .sidebar, .stat-label')].map((element) => element.innerText).join('\n'));
    assert.doesNotMatch(chromeText, /…|\.\.\./, 'UI text must not use ellipses');
    await page.locator('#action-cancel').click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(actionBodies.map((body) => body.operation), ['prepare']);
    await page.screenshot({ path: path.join(output, 'details.png'), fullPage: true });
    await expand.click();
    assert.equal(await page.locator('.game-details').first().isVisible(), false);
    console.log('PASS: cache/offline/library filters, sorting and expandable details');

    await page.locator('#toast').evaluate((element) => { element.hidden = true; });
    for (const width of [800, 580, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width, `Horizontal overflow at ${width}: ${layout.scroll}`);
    }
    await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    console.log('PASS: no horizontal overflow at 800, 580 and 390px');
    await page.setViewportSize({ width: 1120, height: 820 });
    await page.evaluate(() => window.scrollTo(0, 0));

    const language = page.locator('#language');
    assert.equal(await language.inputValue(), 'en');
    await page.locator('[data-view="cold"]').click();
    await page.locator('[data-days="365"]').click();
    const onlineIndex = report.libraryRows.findIndex((lib) => lib.online);
    await page.locator(`#library-nav [data-library="${onlineIndex}"]`).click();
    const candidate = cold365.find((app) => app.library === report.libraryRows[onlineIndex].path);
    assert.ok(candidate, 'A local inactive game is needed to check state preservation');
    await search.fill(candidate.appid);
    await page.locator('#sort').selectOption('played');
    await page.locator('.expand-button').first().click();
    const beforeSwitch = scanRequests;
    const reviewValue = await page.locator('#review-value').textContent();
    await language.selectOption('zh-CN');
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    assert.equal(await page.locator('h1').textContent(), '存储空间概览');
    assert.equal(await page.locator('#list-heading').textContent(), '长期未玩');
    assert.equal(await search.getAttribute('placeholder'), '搜索游戏名称或 App ID');
    assert.equal(await search.getAttribute('aria-label'), '搜索游戏名称或 App ID');
    assert.equal(await page.locator('#language').getAttribute('aria-label'), '界面语言');
    assert.match(await page.locator('#summary-stats').textContent(), /长期未玩占用/);
    assert.match(await page.locator('#status').textContent(), /扫描完成/);
    assert.match(await page.locator('#scan-time').textContent(), /上次扫描/);
    assert.equal(await search.inputValue(), candidate.appid);
    assert.equal(await page.locator('#sort').inputValue(), 'played');
    assert.equal(await page.locator('[data-days="365"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator(`#library-nav [data-library="${onlineIndex}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.game-row').count(), 1);
    assert.equal(await page.locator('.game-details').first().isVisible(), true);
    assert.match(await page.locator('.game-details').first().textContent(), /安装清单记录.*着色器缓存.*创意工坊文件/);
    assert.match(await page.locator('.expand-button').first().getAttribute('aria-label'), /的详细信息/);
    assert.equal(await page.locator('#review-value').textContent(), reviewValue);
    assert.equal(scanRequests, beforeSwitch, 'Language switching must not trigger a scan');
    await page.screenshot({ path: path.join(output, 'details-zh.png'), fullPage: true });
    await page.locator('#copy').click();
    const chineseReport = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(chineseReport, /长期未玩阈值为 365 天/);
    assert.match(chineseReport, /待检查空间.*不保证可以安全删除/);
    assert.match(chineseReport, /遗留缓存：/);
    assert.match(chineseReport, /离线游戏库（上次记录，不计入总计）/);
    assert.ok(chineseReport.includes(candidate.name), 'Game names must stay unchanged');
    assert.equal(await page.locator('#toast').textContent(), '报告已复制到剪贴板');
    await language.selectOption('en');
    assert.equal(await page.locator('#toast').textContent(), 'Report copied to clipboard');
    assert.equal(await page.locator('.game-details').first().isVisible(), true);
    assert.match(await page.locator('.game-details').first().textContent(), /Install manifest/);
    await language.selectOption('zh-CN');
    await search.fill('');
    await page.locator('#library-nav [data-library="all"]').click();
    await page.locator('[data-view="cache"]').click();
    if (await page.locator('.expand-button').count()) {
        await page.locator('.expand-button').first().click();
        assert.match(await page.locator('.game-details').first().textContent(), /未找到对应的在线安装记录/);
    }
    await page.locator('[data-view="offline"]').click();
    if (await page.locator('.expand-button').count()) {
        await page.locator('.expand-button').first().click();
        assert.match(await page.locator('.game-details').first().textContent(), /并非本次测量结果/);
    }
    await page.locator('[data-view="never"]').click();
    assert.equal(await page.locator('#list-heading').textContent(), '无游玩记录');
    await page.locator('[data-view="all"]').click();
    await search.fill('no-game-can-have-this-name-78427');
    assert.match(await page.locator('.empty-state').textContent(), /没有匹配的游戏/);
    await search.fill('');
    await page.locator('#sort').selectOption('size');
    await page.locator('[data-days="730"]').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, 'desktop-zh.png'), fullPage: true });
    for (const width of [800, 580, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        assert.ok(layout.scroll <= layout.width, `Chinese horizontal overflow at ${width}: ${layout.scroll}`);
        assert.equal(await language.isVisible(), true);
    }
    await page.screenshot({ path: path.join(output, 'mobile-zh.png'), fullPage: true });
    await page.setViewportSize({ width: 1120, height: 820 });
    console.log('PASS: bilingual UI, details, accessibility labels, reports, toast and narrow layouts');
    console.log('PASS: switching preserves scan, search, sort, library, threshold and expanded details');

    // Replay the real report for reload/lifecycle checks without rescanning the disk.
    const replay = (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(report) });
    await page.route('**/api/scan?*', replay);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.has-report');
    assert.equal(await language.inputValue(), 'zh-CN');
    assert.equal(await page.locator('h1').textContent(), '存储空间概览');
    console.log('PASS: language preference survives reload over an English browser locale');
    await page.unroute('**/api/scan?*', replay);

    let releaseScan;
    await page.route('**/api/scan?*', async (route) => {
        await new Promise((resolve) => { releaseScan = resolve; });
        await replay(route);
    });
    await page.locator('#rescan').click();
    await page.waitForFunction(() => document.body.classList.contains('scanning'));
    await language.selectOption('en');
    assert.equal(await page.locator('#rescan span').textContent(), 'Scanning');
    assert.match(await page.locator('#status').textContent(), /Scanning local libraries/);
    assert.equal(await page.locator('#rescan').isDisabled(), true);
    await language.selectOption('zh-CN');
    assert.equal(await page.locator('#rescan span').textContent(), '正在扫描');
    assert.match(await page.locator('#status').textContent(), /正在扫描本地游戏库/);
    assert.equal(typeof releaseScan, 'function');
    releaseScan();
    await page.waitForFunction(() => !document.body.classList.contains('scanning'));
    assert.match(await page.locator('#status').textContent(), /扫描完成/);
    await page.unroute('**/api/scan?*');
    await language.selectOption('en');
    console.log('PASS: switching language while a scan is pending keeps busy state coherent');

    await page.route('**/api/scan?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Test scan unavailable' }) }));
    await page.locator('#rescan').click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Showing the previous scan'));
    assert.equal(await page.locator('.game-row').count(), installed.length);
    assert.equal(await page.locator('#rescan').isEnabled(), true);
    console.log('PASS: rescan failure preserves previous data and enables retry');
    await language.selectOption('zh-CN');
    assert.match(await page.locator('#status').textContent(), /当前显示上一次扫描结果/);
    assert.equal(await page.locator('#rescan span').textContent(), '扫描游戏库');

    const chineseContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1120, height: 820 } });
    const firstFailure = await chineseContext.newPage();
    firstFailure.on('pageerror', (error) => pageErrors.push(error.message));
    await firstFailure.route('**/api/scan?*', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false }) }));
    await firstFailure.goto(base, { waitUntil: 'domcontentloaded' });
    await firstFailure.waitForSelector('#status-dot.error');
    assert.equal(await firstFailure.locator('#language').inputValue(), 'zh-CN');
    assert.match(await firstFailure.locator('.empty-state').textContent(), /无法读取游戏库.*扫描失败/);
    assert.equal(await firstFailure.locator('#summary-stats').textContent(), '扫描暂不可用');
    await firstFailure.locator('#language').selectOption('en');
    assert.match(await firstFailure.locator('.empty-state').textContent(), /Could not read the library.*Scan failed/);
    assert.equal(await firstFailure.locator('#summary-stats').textContent(), 'Scan unavailable');
    assert.equal(await firstFailure.locator('#rescan').isEnabled(), true);
    await firstFailure.unroute('**/api/scan?*');
    await firstFailure.route('**/api/scan?*', replay);
    await firstFailure.locator('#rescan').click();
    await firstFailure.waitForSelector('body.has-report');
    assert.equal(await firstFailure.locator('.game-row').count(), installed.length);
    await firstFailure.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard blocked for test'); }; });
    await firstFailure.locator('#copy').click();
    await firstFailure.waitForFunction(() => document.getElementById('toast').textContent.includes('Clipboard is unavailable'));
    await firstFailure.locator('#language').selectOption('zh-CN');
    assert.equal(await firstFailure.locator('#toast').textContent(), '当前窗口无法使用剪贴板');
    await chineseContext.close();
    console.log('PASS: Chinese auto-selection, bilingual initial errors, retry and clipboard failure');

    const blockedContext = await browser.newContext({ locale: 'zh-TW' });
    await blockedContext.addInitScript(() => {
        Storage.prototype.getItem = () => { throw new Error('Storage blocked for test'); };
        Storage.prototype.setItem = () => { throw new Error('Storage blocked for test'); };
    });
    const blocked = await blockedContext.newPage();
    blocked.on('pageerror', (error) => pageErrors.push(error.message));
    await blocked.route('**/api/scan?*', replay);
    await blocked.goto(base, { waitUntil: 'domcontentloaded' });
    await blocked.waitForSelector('body.has-report');
    assert.equal(await blocked.locator('#language').inputValue(), 'zh-CN');
    await blocked.locator('#language').selectOption('en');
    assert.equal(await blocked.locator('h1').textContent(), 'Storage overview');
    await blocked.reload({ waitUntil: 'domcontentloaded' });
    await blocked.waitForSelector('body.has-report');
    assert.equal(await blocked.locator('#language').inputValue(), 'zh-CN');
    await blockedContext.close();
    console.log('PASS: blocked preference storage does not break scanning or language switching');
    assert.deepEqual(pageErrors, []);
    assert.ok(consoleErrors.every((error) => error.includes('500')), `Unexpected console errors: ${consoleErrors.join('; ')}`);
    console.log('PASS: no runtime JavaScript errors');
    console.log(`Screenshots: ${output}`);
} finally {
    await browser.close();
    server.kill();
}
