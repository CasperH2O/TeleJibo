// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Telegram identifies each client app by an api_id/api_hash pair. Release builds carry the
// publisher's pair in config/app-key.bin (written by tools/package.py from a private file
// that never enters Git). It is scrambled only so it does not show up in a plain text
// search: anyone with the package can recover it, which Telegram's terms allow. Builders of
// their own copy register their own pair (https://core.telegram.org/api/obtaining_api_id).
//
// A person may also place their own pair at <data root>/api.override.json; it wins.
var fs = require('fs'), path = require('path');

var MAGIC = 'TJK2';
var SALT = 'TeleJibo app key v1';

// A deterministic byte stream (xorshift32 seeded with FNV-1a of SALT). Not cryptography:
// it only has to be identical everywhere the skill runs, including the web simulator,
// whose crypto shim has no hashes.
function pad(length) {
    var seed = 0x811c9dc5, out = Buffer.alloc(length);
    for (var i = 0; i < SALT.length; ++i) seed = Math.imul(seed ^ SALT.charCodeAt(i), 0x01000193) >>> 0;
    for (var j = 0; j < length; ++j) {
        seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
        out[j] = seed & 255;
    }
    return out;
}
function scramble(bytes) {
    var key = pad(bytes.length), out = Buffer.alloc(bytes.length);
    for (var i = 0; i < bytes.length; ++i) out[i] = bytes[i] ^ key[i];
    return out;
}
function valid(value) {
    return !!value && typeof value === 'object' && Number.isInteger(value.api_id) && value.api_id > 0 &&
        typeof value.api_hash === 'string' && /^[0-9a-f]{32}$/.test(value.api_hash);
}
function encode(value) {
    if (!valid(value)) throw Error('app_key_invalid');
    var json = Buffer.from(JSON.stringify({api_id: value.api_id, api_hash: value.api_hash}), 'utf8');
    return Buffer.concat([Buffer.from(MAGIC, 'ascii'), scramble(json)]);
}
function decode(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > 1024 || bytes.toString('ascii', 0, 4) !== MAGIC) throw Error('app_key_invalid');
    var value;
    try { value = JSON.parse(scramble(bytes.slice(4)).toString('utf8')); } catch (_) { throw Error('app_key_invalid'); }
    if (!valid(value)) throw Error('app_key_invalid');
    return value;
}
function readJson(file) {
    var st = fs.statSync(file);
    if (!st.isFile() || st.size > 4096) throw Error('app_key_invalid');
    var value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!valid(value)) throw Error('app_key_invalid');
    return value;
}

// The helper's --api-file: the person's override, else the bundled pair, written (0600)
// into the private data root. The helper only reads a regular file it owns that no one
// else may read, so an override is copied there rather than passed as placed (any mode,
// owner or link). Returns null when neither exists.
function apiFile(appRoot, dataRoot) {
    var override = path.join(dataRoot, 'api.override.json'), bundled = path.join(appRoot, 'config', 'app-key.bin');
    var value;
    if (fs.existsSync(override)) value = readJson(override);
    else if (fs.existsSync(bundled)) value = decode(fs.readFileSync(bundled));
    else return null;
    var target = path.join(dataRoot, 'api.json');
    var json = JSON.stringify(value) + '\n', current = null;
    try { current = fs.readFileSync(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== json) {
        var temporary = target + '.tmp';
        fs.writeFileSync(temporary, json, {mode: 384});
        fs.renameSync(temporary, target);
    }
    try { fs.chmodSync(target, 384); } catch (_) { /* the simulator's file system keeps host modes */ }
    return target;
}
module.exports = {apiFile: apiFile, encode: encode, decode: decode, valid: valid};
