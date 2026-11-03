// Safety tests for the open-folder, uninstall and cache-removal actions.
// Uses a throwaway Steam layout under .test-tmp with fake Windows side effects,
// so no real game, cache or Recycle Bin item is touched.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.test-tmp');
mkdirSync(scratch, { recursive: true });
const fixture = mkdtempSync(path.join(scratch, 'actions-'));
const steam = path.join(fixture, 'Steam');
const second = path.join(fixture, 'SecondLibrary');
const outside = path.join(fixture, 'outside');

function file(target, content = 'data') {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
}

function vdfPath(value) { return value.split(path.sep).join(path.sep + path.sep); }

function manifest(library, appid, name, installdir) {
    file(path.join(library, 'steamapps', `appmanifest_${appid}.acf`), [
        '"AppState"', '{', `"appid" "${appid}"`, `"name" "${name}"`, `"installdir" "${installdir}"`,
        '"SizeOnDisk" "1000"', '"LastPlayed" "0"', '"StateFlags" "4"', '}',
    ].join('\n'));
    file(path.join(library, 'steamapps', 'common', installdir, 'game.bin'));
}

file(path.join(steam, 'steam.exe'));
file(path.join(steam, 'steamapps', 'libraryfolders.vdf'), [
    '"libraryfolders"', '{',
    '"0"', '{', `"path" "${vdfPath(steam)}"`, '"apps"', '{', '"111" "1000"', '}', '}',
    '"1"', '{', `"path" "${vdfPath(second)}"`, '"apps"', '{', '"222" "1000"', '}', '}',
    '}',
].join('\n'));
manifest(steam, '111', 'Game One', 'GameOne');
manifest(second, '222', 'Game Two', 'GameTwo');
for (const appid of ['999', '666', '333', '444', '555']) file(path.join(steam, 'steamapps', 'shadercache', appid, 'cache.bin'));
file(path.join(steam, 'steamapps', 'workshop', 'content', '888', 'item.bin'));
file(path.join(second, 'steamapps', 'downloading', '333', 'partial.bin'));
file(path.join(outside, 'keep.txt'), 'must survive');
// Must be set before scan.mjs caches the Steam path.
process.env.STEAM_PATH = steam;
const { createActions } = await import('../src/actions.mjs');
const { scan } = await import('../src/scan.mjs');
const { launch, steamRunning } = await import('../src/windows-actions.mjs');

let steamIsRunning = false;
let holdRecycle = null;
const launched = [];
const recycled = [];
const effects = {
    steamRunning: async () => steamIsRunning,
    launch: async (executable, args) => { launched.push([executable, args]); },
    recycle: async (folder) => {
        assert.ok(folder.startsWith(fixture + path.sep), 'Fake recycle must stay inside the fixture');
        recycled.push(folder);
        if (holdRecycle) await holdRecycle;
        rmSync(folder, { recursive: true });
    },
};

async function rejects(promise, code) {
    await assert.rejects(promise, (error) => error.code === code, `Expected ${code}`);
}

try {
    const actions = createActions(effects);
    let report = actions.register(scan(730));
    const game = report.rows.find((row) => row.appid === '111');
    const shader = (appid) => report.orphans.shader.find((row) => row.appid === appid);
    const target999 = shader('999');
    const target888 = report.orphans.workshop.find((row) => row.appid === '888');
    assert.equal(report.errors.length, 0, report.errors.join('; '));
    assert.deepEqual(
        { mode: game.actions.mode, canOpen: game.actions.canOpen, canRemove: game.actions.canRemove },
        { mode: 'uninstall', canOpen: true, canRemove: true },
    );
    assert.equal(game.actions.folder, path.join(steam, 'steamapps', 'common', 'GameOne'));
    assert.equal(target999.actions.mode, 'recycle');
    assert.equal(target888.actions.folder, path.join(steam, 'steamapps', 'workshop', 'content', '888'));
    console.log('PASS: scan report exposes only the expected targets');

    await actions.perform({ operation: 'open', id: game.actions.id });
    assert.deepEqual(launched.at(-1), ['explorer.exe', [game.actions.folder]]);
    await rejects(actions.perform({ operation: 'open', id: '../../Windows' }), 'staleTarget');
    await rejects(actions.perform({ operation: 'unknown', id: game.actions.id }), 'confirmationRequired');
    await rejects(actions.perform(null), 'invalidRequest');
    console.log('PASS: open-folder only accepts known targets');

    steamIsRunning = true;
    const first = await actions.perform({ operation: 'prepare', id: game.actions.id });
    assert.equal(first.mode, 'uninstall');
    await rejects(actions.perform({ operation: 'commit', id: game.actions.id, ticket: first.ticket }), 'confirmationRequired');
    await rejects(actions.perform({ operation: 'commit', id: game.actions.id, ticket: first.ticket, confirmed: 'yes' }), 'confirmationRequired');
    const uninstalled = await actions.perform({ operation: 'commit', id: game.actions.id, ticket: first.ticket, confirmed: true });
    assert.equal(uninstalled.result, 'uninstallRequested');
    assert.deepEqual(launched.at(-1), [path.join(steam, 'steam.exe'), ['--', 'steam://uninstall/111']]);
    assert.ok(existsSync(game.actions.folder), 'The app must not delete a game folder itself');
    await rejects(actions.perform({ operation: 'commit', id: game.actions.id, ticket: first.ticket, confirmed: true }), 'confirmationExpired');
    const mismatched = await actions.perform({ operation: 'prepare', id: game.actions.id });
    await rejects(actions.perform({ operation: 'commit', id: target999.actions.id, ticket: mismatched.ticket, confirmed: true }), 'confirmationExpired');
    console.log('PASS: uninstall goes through Steam, needs a fresh one-time ticket and leaves files alone');

    const whileRunning = await actions.perform({ operation: 'prepare', id: target999.actions.id });
    await rejects(actions.perform({ operation: 'commit', id: target999.actions.id, ticket: whileRunning.ticket, confirmed: true }), 'steamRunning');
    assert.equal(recycled.length, 0);
    steamIsRunning = false;
    const expiring = await actions.perform({ operation: 'prepare', id: target999.actions.id });
    const realNow = Date.now;
    Date.now = () => realNow() + 121000;
    try {
        await rejects(actions.perform({ operation: 'commit', id: target999.actions.id, ticket: expiring.ticket, confirmed: true }), 'confirmationExpired');
    } finally { Date.now = realNow; }
    assert.equal(recycled.length, 0);
    const fresh = await actions.perform({ operation: 'prepare', id: target999.actions.id });
    assert.equal(fresh.mode, 'recycle');
    const removed = await actions.perform({ operation: 'commit', id: target999.actions.id, ticket: fresh.ticket, confirmed: true });
    assert.equal(removed.result, 'cacheRemoved');
    assert.deepEqual(recycled, [target999.actions.folder]);
    assert.equal(existsSync(target999.actions.folder), false);
    await rejects(actions.perform({ operation: 'open', id: target999.actions.id }), 'staleTarget');
    console.log('PASS: cache removal waits for Steam to exit, expires tickets and only touches the chosen folder');

    await rejects(actions.perform({ operation: 'prepare', id: shader('333').actions.id }), 'cacheInUse');
    const late = shader('555');
    manifest(second, '555', 'Late Install', 'LateInstall');
    await rejects(actions.perform({ operation: 'prepare', id: late.actions.id }), 'cacheInUse');
    console.log('PASS: caches with a download or newly appeared install record are blocked');

    const target666 = shader('666');
    rmSync(target666.actions.folder, { recursive: true });
    symlinkSync(outside, target666.actions.folder, 'junction');
    await rejects(actions.perform({ operation: 'open', id: target666.actions.id }), 'unsafePath');
    await rejects(actions.perform({ operation: 'prepare', id: target666.actions.id }), 'unsafePath');
    const target444 = shader('444');
    symlinkSync(outside, path.join(target444.actions.folder, 'link'), 'junction');
    await rejects(actions.perform({ operation: 'prepare', id: target444.actions.id }), 'unsafePath');
    assert.ok(existsSync(path.join(outside, 'keep.txt')), 'Linked folders must never be followed');
    console.log('PASS: junctions at the target or inside it are refused');

    const ticket888 = await actions.perform({ operation: 'prepare', id: target888.actions.id });
    let release;
    holdRecycle = new Promise((resolve) => { release = resolve; });
    const inFlight = actions.perform({ operation: 'commit', id: target888.actions.id, ticket: ticket888.ticket, confirmed: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(actions.busy, true);
    await rejects(actions.perform({ operation: 'prepare', id: game.actions.id }), 'actionBusy');
    release();
    assert.equal((await inFlight).result, 'cacheRemoved');
    holdRecycle = null;
    assert.equal(actions.busy, false);
    console.log('PASS: only one destructive action can run at a time');

    file(path.join(second, 'steamapps', 'appmanifest_777.acf'), '"AppState" {');
    report = actions.register(scan(730));
    assert.ok(report.errors.length > 0, 'The corrupt manifest should produce a scan warning');
    await rejects(actions.perform({ operation: 'open', id: game.actions.id }), 'staleTarget');
    const blocked = report.orphans.shader.find((row) => row.appid === '444');
    assert.equal(blocked.actions.canRemove, false);
    await rejects(actions.perform({ operation: 'prepare', id: blocked.actions.id }), 'unavailableTarget');
    assert.equal(report.rows.find((row) => row.appid === '111').actions.canRemove, true);
    console.log('PASS: a rescan invalidates old targets and scan warnings block cache deletion');

    await launch('cmd.exe', ['/c', 'exit', '0']);
    assert.equal(typeof (await steamRunning()), 'boolean');
    await assert.rejects(launch('definitely-missing-steam-disk-bill.exe', []));
    console.log('PASS: real process helpers behave (launch, missing executable, Steam process check)');
} finally {
    for (const link of [path.join(steam, 'steamapps', 'shadercache', '666'), path.join(steam, 'steamapps', 'shadercache', '444', 'link')]) {
        try { unlinkSync(link); } catch { /* The link may not exist. */ }
    }
    assert.ok(fixture.startsWith(scratch + path.sep));
    rmSync(fixture, { recursive: true, force: true });
}
