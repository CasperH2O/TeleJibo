// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
function toI420(rgba, width, height) {
    var size = width * height, bytes = Buffer.alloc(size * 3 / 2);
    for (var y = 0; y < height; ++y) for (var x = 0; x < width; ++x) {
        var at = (y * width + x) * 4, r = rgba[at], g = rgba[at + 1], b = rgba[at + 2];
        bytes[y * width + x] = Math.max(16, Math.min(235, ((66*r + 129*g + 25*b + 128) >> 8) + 16));
        if (!(x & 1) && !(y & 1)) {
            var red = 0, green = 0, blue = 0;
            for (var row = 0; row < 2; ++row) for (var col = 0; col < 2; ++col) {
                var p = ((y + row) * width + x + col) * 4; red += rgba[p]; green += rgba[p+1]; blue += rgba[p+2];
            }
            red /= 4; green /= 4; blue /= 4;
            var uv = y / 2 * (width / 2) + x / 2;
            bytes[size + uv] = Math.max(16, Math.min(240, ((-38*red - 74*green + 112*blue + 128) >> 8) + 128));
            bytes[size + size / 4 + uv] = Math.max(16, Math.min(240, ((112*red - 94*green - 18*blue + 128) >> 8) + 128));
        }
    }
    return bytes;
}
module.exports = toI420;
