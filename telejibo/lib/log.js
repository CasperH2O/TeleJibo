// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Use the BeSkill logger so robot diagnostics follow Jibo's namespace, levels and
// syslog configuration. A single string also keeps every argument visible in the
// old Electron console. Console output is a fallback for standalone development.
module.exports = function createLog(logger, area) {
    var prefix = '[telejibo]' + (area ? ' ' + area : ''), output = {};
    ['debug', 'info', 'warn', 'error'].forEach(function (level) {
        output[level] = function () {
            var message = [prefix].concat([].slice.call(arguments)).join(' ');
            var target = logger || console, write = target[level] || target.log;
            try { if (typeof write === 'function') write.call(target, message); } catch (_) {}
        };
    });
    return output;
};
