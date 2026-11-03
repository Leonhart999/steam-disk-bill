import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const recycleScript = fileURLToPath(new URL('../tools/recycle.ps1', import.meta.url));

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

export async function recycle(folder) {
    try {
        await execute('powershell.exe', ['-NoProfile', '-STA', '-File', recycleScript], {
            windowsHide: true,
            timeout: 600000,
            env: { ...process.env, STEAM_DISK_BILL_TARGET: folder },
        });
    } catch (error) {
        if (error.code === 2) error.actionCode = 'cancelled';
        throw error;
    }
}
