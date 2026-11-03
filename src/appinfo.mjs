// Reads app names from Steam's local binary cache (appcache/appinfo.vdf).
// Used for leftover caches and offline libraries, which have no manifest to read.
// Supports format versions 27, 28 and 29 (29 stores keys in a trailing string table).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAGIC = { 0x07564427: 27, 0x07564428: 28, 0x07564429: 29 };
const TYPE = { MAP: 0x00, STRING: 0x01, INT32: 0x02, FLOAT: 0x03, POINTER: 0x04, COLOR: 0x06, UINT64: 0x07, END: 0x08, INT64: 0x0a };

function readCString(buffer, offset) {
    const end = buffer.indexOf(0, offset);
    if (end < 0) throw new Error('unterminated string');
    return [buffer.toString('utf8', offset, end), end + 1];
}

function readStringTable(buffer, offset) {
    const count = buffer.readUInt32LE(offset);
    const strings = new Array(count);
    let cursor = offset + 4;
    for (let index = 0; index < count; index += 1) [strings[index], cursor] = readCString(buffer, cursor);
    return strings;
}

function parseKeyValues(buffer, start, end, strings) {
    let cursor = start;
    function key() {
        if (!strings) {
            const [value, next] = readCString(buffer, cursor);
            cursor = next;
            return value;
        }
        const value = strings[buffer.readUInt32LE(cursor)];
        cursor += 4;
        return value;
    }
    function map() {
        const object = {};
        while (cursor < end) {
            const type = buffer[cursor];
            cursor += 1;
            if (type === TYPE.END) return object;
            const name = key();
            if (type === TYPE.MAP) object[name] = map();
            else if (type === TYPE.STRING) [object[name], cursor] = readCString(buffer, cursor);
            else if (type === TYPE.INT32 || type === TYPE.POINTER || type === TYPE.COLOR) { object[name] = buffer.readInt32LE(cursor); cursor += 4; }
            else if (type === TYPE.FLOAT) { object[name] = buffer.readFloatLE(cursor); cursor += 4; }
            else if (type === TYPE.UINT64 || type === TYPE.INT64) { object[name] = String(buffer.readBigUInt64LE(cursor)); cursor += 8; }
            else throw new Error(`unknown type ${type}`);
        }
        return object;
    }
    return map();
}

export function parseAppNames(buffer, wanted) {
    const version = MAGIC[buffer.readUInt32LE(0)];
    if (!version) throw new Error('unsupported appinfo.vdf format');
    const strings = version >= 29 ? readStringTable(buffer, Number(buffer.readBigInt64LE(8))) : null;
    const headerAfterSize = version >= 28 ? 60 : 40;
    const names = new Map();
    let cursor = version >= 29 ? 16 : 8;
    while (cursor + 8 <= buffer.length && names.size < wanted.size) {
        const appid = String(buffer.readUInt32LE(cursor));
        if (appid === '0') break;
        const size = buffer.readUInt32LE(cursor + 4);
        const entryEnd = cursor + 8 + size;
        if (wanted.has(appid)) {
            try {
                const data = parseKeyValues(buffer, cursor + 8 + headerAfterSize, entryEnd, strings);
                const common = data.appinfo?.common;
                if (common && typeof common.name === 'string') {
                    const localized = common.name_localized?.schinese;
                    names.set(appid, { name: common.name, zh: typeof localized === 'string' ? localized : null });
                }
            } catch {
                // One damaged entry should not hide the others.
            }
        }
        cursor = entryEnd;
    }
    return names;
}

export async function readAppNames(steamPath, appids) {
    const wanted = new Set(appids);
    if (!wanted.size) return new Map();
    try {
        return parseAppNames(await readFile(path.join(steamPath, 'appcache', 'appinfo.vdf')), wanted);
    } catch {
        return new Map();
    }
}
