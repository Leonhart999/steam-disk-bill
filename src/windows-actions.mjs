import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readAsset } from './assets.mjs';

const execute = promisify(execFile);

export async function steamRunning() {
    const { stdout } = await execute('tasklist.exe', ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
    return /"steam\.exe"/i.test(stdout);
}

export function launch(executable, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}

// The script is passed inline so the packaged exe needs no file next to it.
function recycleCommand() {
    return Buffer.from(readAsset('src/recycle.ps1').toString('utf8'), 'utf16le').toString('base64');
}

export async function recycle(folder, env = {}) {
    try {
        await execute('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', recycleCommand()], {
            windowsHide: true,
            timeout: 600000,
            env: { ...process.env, ...env, STEAM_DISK_BILL_TARGET: folder },
        });
    } catch (error) {
        if (error.code === 2) error.actionCode = 'cancelled';
        throw error;
    }
}
