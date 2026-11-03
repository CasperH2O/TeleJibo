// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Private data outside the installed package, so it survives skill updates, BEam OTAs and
// restarts (BEacon keeps custom skill state under Knowledge/beacon on the robot and under
// /tmp/beam-beacon in development checkouts and the simulator).
var fs = require('fs'), path = require('path');

var NAME = 'telejibo';
function onRobot() { return fs.existsSync('/opt/jibo/Jibo/Skills'); }
function dataRoot() {
    if (process.env.TELEJIBO_DATA_DIR) return path.resolve(process.env.TELEJIBO_DATA_DIR);
    return onRobot() ? '/opt/jibo/Knowledge/beacon/custom-skills/' + NAME : '/tmp/beam-beacon/custom-skills/' + NAME;
}
// mkdir -p with private (0700) directories; an existing non-directory is an error.
function ensureDirectory(dir) {
    try { fs.mkdirSync(dir, 448); }
    catch (error) {
        if (error.code === 'ENOENT') { ensureDirectory(path.dirname(dir)); fs.mkdirSync(dir, 448); }
        else if (error.code !== 'EEXIST' || !fs.statSync(dir).isDirectory()) throw error;
    }
    return dir;
}
module.exports = {NAME: NAME, onRobot: onRobot, dataRoot: dataRoot, ensureDirectory: ensureDirectory};
