// SPDX-License-Identifier: GPL-3.0-or-later
// Live device boundary: bounded private pipes, never media files.
#pragma once
#include <atomic>
#include <array>
#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <fcntl.h>
#include <mutex>
#include <poll.h>
#include <sys/ioctl.h>
#include <stdexcept>
#include <thread>
#include <unistd.h>
#include <vector>

namespace jibo_media {
constexpr int microphone = 3, speaker = 4, camera = 5, video = 6;
constexpr size_t audioBytes = 480 * 2 * sizeof(int16_t);
constexpr int cameraWidth = 320, cameraHeight = 240;
constexpr size_t cameraBytes = cameraWidth * cameraHeight * 3 / 2;

inline void nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
        throw std::runtime_error("media_pipe_unavailable");
}

class Reader {
    int fd;
    std::vector<uint8_t> pending;
    size_t filled = 0, backlog;
    // Discards whole frames so at most `backlog` frames wait behind the next one.
    void catchUp() {
        int available = 0;
        if (ioctl(fd, FIONREAD, &available) != 0 || size_t(available) / pending.size() <= backlog + 1) return;
        size_t excess = (size_t(available) / pending.size() - backlog - 1) * pending.size();
        std::array<uint8_t, 4096> scratch;
        while (excess) {
            auto n = read(fd, scratch.data(), std::min(excess, scratch.size()));
            if (n > 0) excess -= size_t(n);
            else if (!(n < 0 && errno == EINTR)) return;
        }
    }
public:
    std::atomic<bool> failed{false};
    Reader(int descriptor, size_t bytes, size_t maximumBacklog = SIZE_MAX / 2)
        : fd(descriptor), pending(bytes), backlog(maximumBacklog) { nonblocking(fd); drain(); }
    // A new call must never receive samples captured before it started.
    void drain() {
        std::array<uint8_t, 4096> scratch;
        for (;;) {
            auto n = read(fd, scratch.data(), scratch.size());
            if (n > 0) continue;
            if (n < 0 && errno == EINTR) continue;
            if (n == 0) failed = true;
            break;
        }
        filled = 0;
    }
    bool frame(uint8_t *out) {
        if (filled == 0) catchUp();
        while (filled < pending.size()) {
            auto n = read(fd, pending.data() + filled, pending.size() - filled);
            if (n > 0) filled += size_t(n);
            else if (n < 0 && errno == EINTR) continue;
            else { if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) failed = true; return false; }
        }
        std::copy(pending.begin(), pending.end(), out); filled = 0; return true;
    }
};

// Camera input: `JICF`, little-endian uint32 width and height, then one I420 frame. The
// header lets a reader find the next frame after any partial one (a frame cut short at a
// call's end, or written before this reader existed), so framing can never drift.
constexpr size_t cameraHeaderBytes = 12;
inline std::array<uint8_t, cameraHeaderBytes> cameraHeader(uint32_t width, uint32_t height) {
    std::array<uint8_t, cameraHeaderBytes> header{'J', 'I', 'C', 'F'};
    for (int i = 0; i < 4; ++i) { header[4 + i] = uint8_t(width >> (8 * i)); header[8 + i] = uint8_t(height >> (8 * i)); }
    return header;
}

class FrameReader {
    int fd;
    std::array<uint8_t, cameraHeaderBytes> header;
    size_t payload;
    std::vector<uint8_t> buffer;
    // Reads what the pipe holds, keeping at most a few frames: older ones are stale anyway.
    void fill() {
        std::array<uint8_t, 16384> scratch;
        size_t frame = cameraHeaderBytes + payload;
        for (;;) {
            auto n = read(fd, scratch.data(), scratch.size());
            if (n > 0) {
                buffer.insert(buffer.end(), scratch.data(), scratch.data() + n);
                if (buffer.size() > 3 * frame) buffer.erase(buffer.begin(), buffer.end() - std::ptrdiff_t(2 * frame));
                continue;
            }
            if (n < 0 && errno == EINTR) continue;
            if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) failed = true;
            return;
        }
    }
    // Drops bytes before the next header; keeps a possible header prefix at the end.
    void sync() {
        auto at = std::search(buffer.begin(), buffer.end(), header.begin(), header.end());
        if (at == buffer.end()) {
            size_t keep = std::min(buffer.size(), cameraHeaderBytes - 1);
            buffer.erase(buffer.begin(), buffer.end() - std::ptrdiff_t(keep));
        } else buffer.erase(buffer.begin(), at);
    }
public:
    std::atomic<bool> failed{false};
    FrameReader(int descriptor, uint32_t width, uint32_t height)
        : fd(descriptor), header(cameraHeader(width, height)), payload(size_t(width) * height * 3 / 2) { nonblocking(fd); drain(); }
    // A new call must never receive frames captured before it started.
    void drain() { fill(); buffer.clear(); }
    // The newest complete frame, if one arrived since the last call.
    bool frame(uint8_t *out) {
        fill();
        bool found = false;
        for (;;) {
            sync();
            if (buffer.size() < cameraHeaderBytes + payload) return found;
            // A header inside the payload means this frame was cut short: restart there.
            auto body = buffer.begin() + cameraHeaderBytes, end = body + std::ptrdiff_t(payload);
            auto limit = buffer.end() - end > std::ptrdiff_t(cameraHeaderBytes - 1) ? end + std::ptrdiff_t(cameraHeaderBytes - 1) : buffer.end();
            auto next = std::search(body, limit, header.begin(), header.end());
            if (next < end) { buffer.erase(buffer.begin(), next); continue; }
            std::copy_n(buffer.begin() + cameraHeaderBytes, payload, out);
            buffer.erase(buffer.begin(), buffer.begin() + std::ptrdiff_t(cameraHeaderBytes + payload));
            found = true;
        }
    }
};

class Writer {
    int fd;
    size_t limit, queued = 0;
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<std::vector<uint8_t>> queue;
    std::atomic<bool> running{true};
    std::thread worker;
    void run() {
        while (running) {
            std::vector<uint8_t> value;
            {
                std::unique_lock lock(mutex);
                changed.wait_for(lock, std::chrono::milliseconds(20), [&] { return !running || !queue.empty(); });
                if (!running) break;
                if (queue.empty()) continue;
                value = std::move(queue.front()); queue.pop_front(); queued -= value.size();
            }
            // A stalled reader costs whole frames, never framing: a frame not yet
            // started is dropped after 250 ms, one already started is finished.
            size_t offset = 0;
            auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
            while (running && offset < value.size()) {
                auto n = write(fd, value.data() + offset, value.size() - offset);
                if (n > 0) { offset += size_t(n); continue; }
                if (n < 0 && errno == EINTR) continue;
                if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                    if (offset == 0 && std::chrono::steady_clock::now() >= deadline) { ++dropped; break; }
                    pollfd wait{fd, POLLOUT, 0}; poll(&wait, 1, 10); continue;
                }
                failed = true; running = false; break;
            }
        }
    }
public:
    std::atomic<bool> failed{false};
    std::atomic<unsigned> dropped{0};
    Writer(int descriptor, size_t maximum) : fd(descriptor), limit(maximum) {
        nonblocking(fd); worker = std::thread([this] { run(); });
    }
    ~Writer() { running = false; changed.notify_all(); worker.join(); }
    bool push(std::vector<uint8_t> value) {
        std::lock_guard lock(mutex);
        if (!running || value.size() > limit || queued + value.size() > limit) { if (running) ++dropped; return false; }
        queued += value.size(); queue.push_back(std::move(value)); changed.notify_one(); return true;
    }
};
}
