// SPDX-License-Identifier: GPL-3.0-or-later
// A streaming reader for the live WebM that Jibo's camera encoder produces (VP8 video,
// clusters of unknown size). It takes the byte stream in any chunking and yields the VP8
// frames as they complete. Nothing is decoded: the frames go into the call as they are.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

namespace jibo_media {
struct EncodedFrame {
    std::vector<uint8_t> data;
    bool key = false;
    int width = 0, height = 0;   // of the latest keyframe
    int64_t timeMs = 0;          // stream time
};

class WebmReader {
    // Containers whose children are read in place; every other element is taken whole.
    static constexpr uint32_t Segment = 0x18538067, Cluster = 0x1F43B675, BlockGroup = 0xA0,
        Info = 0x1549A966, Tracks = 0x1654AE6B, TrackEntry = 0xAE;
    static constexpr uint32_t TimecodeScale = 0x2AD7B1, Timecode = 0xE7, SimpleBlock = 0xA3, Block = 0xA1,
        TrackNumber = 0xD7, TrackType = 0x83;
    static constexpr uint64_t unknown = UINT64_MAX;
    // One video frame is far below this; anything larger is not this stream.
    static constexpr size_t elementLimit = 2 * 1024 * 1024;

    std::vector<uint8_t> buffer;
    uint64_t scaleNs = 1000000, cluster = 0;
    int64_t videoTrack = -1, entryNumber = -1, entryType = -1;
    int width = 0, height = 0;
    bool broken = false;

    static bool container(uint32_t id) {
        return id == Segment || id == Cluster || id == BlockGroup || id == Info || id == Tracks || id == TrackEntry;
    }
    // EBML variable-length number at `at`. Ids keep their length marker; sizes drop it.
    static int number(const uint8_t *at, size_t available, bool id, uint64_t &value) {
        if (!available) return 0;
        int length = 1;
        for (uint8_t mask = 0x80; length <= 8 && !(at[0] & mask); mask >>= 1) ++length;
        if (length > (id ? 4 : 8)) return -1;
        if (size_t(length) > available) return 0;
        value = id ? at[0] : at[0] & (0xFF >> length);
        bool ones = (at[0] & (0xFF >> length)) == (0xFF >> length);
        for (int i = 1; i < length; ++i) { value = value << 8 | at[i]; ones = ones && at[i] == 0xFF; }
        if (!id && ones) value = unknown;
        return length;
    }
    static uint64_t integer(const uint8_t *at, size_t size) {
        uint64_t value = 0;
        for (size_t i = 0; i < size && i < 8; ++i) value = value << 8 | at[i];
        return value;
    }
    void block(const uint8_t *at, size_t size, std::vector<EncodedFrame> &out) {
        uint64_t track = 0;
        int used = number(at, size, false, track);
        if (used <= 0 || size < size_t(used) + 3) { broken = true; return; }
        if (videoTrack >= 0 && int64_t(track) != videoTrack) return;
        int16_t relative = int16_t(at[used] << 8 | at[used + 1]);
        // Lacing (flags bits 1-2) would pack several frames; a video stream never uses it.
        if (at[used + 2] & 0x06) { broken = true; return; }
        const uint8_t *frame = at + used + 3;
        size_t length = size - size_t(used) - 3;
        if (length < 3) return;
        EncodedFrame value;
        value.key = !(frame[0] & 1);
        if (value.key) {
            // VP8 keyframe header: 3-byte tag, start code 9d 01 2a, 14-bit width and height.
            if (length < 10 || frame[3] != 0x9d || frame[4] != 0x01 || frame[5] != 0x2a) { broken = true; return; }
            width = (frame[6] | frame[7] << 8) & 0x3fff; height = (frame[8] | frame[9] << 8) & 0x3fff;
            if (width < 16 || height < 16) { broken = true; return; }
        }
        value.width = width; value.height = height;
        value.timeMs = int64_t((int64_t(cluster) + relative) * int64_t(scaleNs) / 1000000);
        value.data.assign(frame, frame + length);
        out.push_back(std::move(value));
    }
public:
    void reset() { *this = WebmReader(); }
    bool failed() const { return broken; }
    // Appends the frames completed by these bytes. False once the stream is not readable;
    // it stays so until reset().
    bool write(const uint8_t *bytes, size_t size, std::vector<EncodedFrame> &out) {
        if (broken) return false;
        buffer.insert(buffer.end(), bytes, bytes + size);
        size_t at = 0;
        while (!broken) {
            uint64_t id = 0, length = 0;
            int idBytes = number(buffer.data() + at, buffer.size() - at, true, id);
            if (idBytes < 0) { broken = true; break; }
            if (!idBytes) break;
            int sizeBytes = number(buffer.data() + at + idBytes, buffer.size() - at - idBytes, false, length);
            if (sizeBytes < 0) { broken = true; break; }
            if (!sizeBytes) break;
            size_t header = size_t(idBytes + sizeBytes);
            if (container(uint32_t(id))) {
                if (id == TrackEntry) entryNumber = entryType = -1;
                at += header; continue;
            }
            if (length == unknown || length > elementLimit) { broken = true; break; }
            if (buffer.size() - at - header < length) break;
            const uint8_t *body = buffer.data() + at + header;
            if (id == TimecodeScale) { scaleNs = integer(body, size_t(length)); if (!scaleNs) broken = true; }
            else if (id == Timecode) cluster = integer(body, size_t(length));
            else if (id == TrackNumber) entryNumber = int64_t(integer(body, size_t(length)));
            else if (id == TrackType) entryType = int64_t(integer(body, size_t(length)));
            else if (id == SimpleBlock || id == Block) block(body, size_t(length), out);
            if ((id == TrackNumber || id == TrackType) && entryType == 1 && entryNumber >= 0 && videoTrack < 0) videoTrack = entryNumber;
            at += header + size_t(length);
        }
        buffer.erase(buffer.begin(), buffer.begin() + std::ptrdiff_t(at));
        if (buffer.size() > elementLimit + 16) broken = true;
        if (broken) { buffer.clear(); buffer.shrink_to_fit(); }
        return !broken;
    }
};
}
