// SPDX-License-Identifier: GPL-3.0-or-later
// The camera pipe (fd 5) carries one of two record kinds, never mixed inside a record:
//
//   JICF  u32 width, u32 height, I420 pixels          a decoded preview frame (fallback)
//   JIWM  u32 length, u32 serial, u32 index, bytes    a piece of the camera's live WebM
//
// All integers are little-endian. A WebM stream is the records of one serial, index 0
// upward with none missing; a new serial is a new stream, which starts with a keyframe.
// Its VP8 frames wait in EncodedQueue for the call's encoder, which sends them unchanged.
#pragma once
#include "pipe-media.h"
#include "webm-reader.h"
#include <chrono>

namespace jibo_media {
constexpr size_t streamHeaderBytes = 16, streamRecordLimit = 1024 * 1024;

// Shared by the camera reader (one thread) and the call's video encoder (another).
class EncodedQueue {
    // About 1.2 s of video. Frames cannot be skipped, so a longer wait means starting over.
    static constexpr size_t limit = 30;
    mutable std::mutex mutex;
    std::deque<EncodedFrame> frames;
    uint64_t first = 1, generation = 0;   // sequence number of frames.front(); stream count
    bool waitingKey = true, wanted = false;
    std::chrono::steady_clock::time_point asked{};
public:
    std::atomic<unsigned> sent{0}, restarts{0}, overflows{0};
    std::atomic<int> width{0}, height{0};
    std::atomic<int> targetBps{0};   // what the call would like the camera to use; it cannot be changed
    std::atomic<bool> streaming{false};
    // A new stream: nothing of the old one may follow.
    void clear() {
        std::lock_guard lock(mutex);
        first += frames.size(); frames.clear(); waitingKey = true; ++generation;
    }
    void push(EncodedFrame frame) {
        std::lock_guard lock(mutex);
        if (waitingKey && !frame.key) return;
        waitingKey = false;
        if (frame.key) { width = frame.width; height = frame.height; }
        if (frames.size() >= limit) {
            first += frames.size(); frames.clear(); waitingKey = true; ++overflows; wanted = true;
            return;
        }
        frames.push_back(std::move(frame));
    }
    // The frame the encoder will send next.
    bool head(uint64_t &sequence, uint64_t &stream, int64_t &timeMs, int &w, int &h) const {
        std::lock_guard lock(mutex);
        if (frames.empty()) return false;
        sequence = first; stream = generation; timeMs = frames.front().timeMs; w = frames.front().width; h = frames.front().height;
        return true;
    }
    bool pop(EncodedFrame &out) {
        std::lock_guard lock(mutex);
        if (frames.empty()) return false;
        out = std::move(frames.front()); frames.pop_front(); ++first; return true;
    }
    size_t size() const { std::lock_guard lock(mutex); return frames.size(); }
    // The far side needs a keyframe, or the stream is unusable: ask the skill for a new one.
    void requestRestart() { std::lock_guard lock(mutex); wanted = true; }
    // True at most once per two seconds: a new stream takes a moment to arrive.
    bool takeRestart() {
        std::lock_guard lock(mutex);
        auto now = std::chrono::steady_clock::now();
        if (!wanted || now - asked < std::chrono::seconds(2)) return false;
        wanted = false; asked = now; ++restarts; return true;
    }
    void forget() { std::lock_guard lock(mutex); wanted = false; }
};
inline EncodedQueue &encodedCamera() { static EncodedQueue queue; return queue; }

class CameraInput {
    int fd;
    EncodedQueue &queue;
    std::vector<uint8_t> buffer, raw;
    WebmReader webm;
    bool rawFresh = false, following = false;
    uint32_t serial = 0, next = 0;
    static constexpr size_t bufferLimit = 4 * 1024 * 1024;

    static uint32_t word(const uint8_t *at) { return uint32_t(at[0]) | uint32_t(at[1]) << 8 | uint32_t(at[2]) << 16 | uint32_t(at[3]) << 24; }
    static bool magic(const uint8_t *at, const char *name) { return memcmp(at, name, 4) == 0; }
    void fill() {
        std::array<uint8_t, 16384> scratch;
        for (;;) {
            auto n = read(fd, scratch.data(), scratch.size());
            if (n > 0) { buffer.insert(buffer.end(), scratch.data(), scratch.data() + n); if (buffer.size() > bufferLimit) return; continue; }
            if (n < 0 && errno == EINTR) continue;
            if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) failed = true;
            return;
        }
    }
    // Drops bytes up to the next record start; keeps a possible partial start at the end.
    void resync(size_t from) {
        for (size_t at = from; at + 4 <= buffer.size(); ++at)
            if (magic(buffer.data() + at, "JICF") || magic(buffer.data() + at, "JIWM")) { buffer.erase(buffer.begin(), buffer.begin() + std::ptrdiff_t(at)); return; }
        size_t keep = std::min<size_t>(buffer.size() > from ? buffer.size() - from : 0, 3);
        buffer.erase(buffer.begin(), buffer.end() - std::ptrdiff_t(keep));
    }
    void abandon() { following = false; queue.clear(); queue.requestRestart(); }
    void piece(uint32_t stream, uint32_t index, const uint8_t *bytes, size_t size) {
        if (index == 0) { serial = stream; next = 0; following = true; webm.reset(); queue.clear(); queue.forget(); }
        // A stream joined part-way, or one with a piece missing, cannot be read.
        if (!following || stream != serial || index != next) { if (following || stream != serial) { serial = stream; abandon(); } return; }
        ++next;
        std::vector<EncodedFrame> frames;
        if (!webm.write(bytes, size, frames)) { abandon(); return; }
        queue.streaming = true;
        for (auto &frame : frames) queue.push(std::move(frame));
    }
public:
    std::atomic<bool> failed{false};
    CameraInput(int descriptor, EncodedQueue &target) : fd(descriptor), queue(target), raw(cameraBytes) { nonblocking(fd); drain(); }
    // A new call, or the camera switched back on: nothing sent before now may be used.
    void drain() { fill(); buffer.clear(); rawFresh = false; following = false; queue.clear(); queue.forget(); }
    // Reads what the pipe holds and files it: stream pieces to the queue, the newest raw frame aside.
    void poll() {
        fill();
        if (buffer.size() > bufferLimit) { buffer.clear(); abandon(); return; }
        for (;;) {
            if (buffer.size() < 4) return;
            const uint8_t *at = buffer.data();
            if (magic(at, "JICF")) {
                if (buffer.size() < cameraHeaderBytes) return;
                if (word(at + 4) != uint32_t(cameraWidth) || word(at + 8) != uint32_t(cameraHeight)) { resync(1); continue; }
                if (buffer.size() < cameraHeaderBytes + cameraBytes) return;
                std::copy_n(at + cameraHeaderBytes, cameraBytes, raw.begin()); rawFresh = true;
                if (queue.streaming.exchange(false)) { following = false; queue.clear(); }
                buffer.erase(buffer.begin(), buffer.begin() + std::ptrdiff_t(cameraHeaderBytes + cameraBytes));
            } else if (magic(at, "JIWM")) {
                if (buffer.size() < streamHeaderBytes) return;
                uint32_t length = word(at + 4);
                if (length > streamRecordLimit) { resync(1); continue; }
                if (buffer.size() < streamHeaderBytes + length) return;
                piece(word(at + 8), word(at + 12), at + streamHeaderBytes, length);
                buffer.erase(buffer.begin(), buffer.begin() + std::ptrdiff_t(streamHeaderBytes + length));
            } else resync(1);
        }
    }
    // The newest decoded frame, if one arrived since the last call.
    bool rawFrame(uint8_t *out) {
        if (!rawFresh) return false;
        std::copy(raw.begin(), raw.end(), out); rawFresh = false; return true;
    }
};
}
