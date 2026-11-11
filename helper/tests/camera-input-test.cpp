// SPDX-License-Identifier: GPL-3.0-or-later
// The camera pipe's two record kinds and the live-WebM reader, on the host with no devices.
// With a file argument it reads that file as a camera stream and prints what it holds
// (frames, keyframe spacing, bitrate): use it on a capture from a real robot.
#include "../media/camera-input.h"
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

#define check(expression) do { if (!(expression)) { \
    std::cerr << "check failed: " #expression " at line " << __LINE__ << "\n"; std::exit(1); } } while (0)

using Bytes = std::vector<uint8_t>;
using jibo_media::EncodedFrame;

static void add(Bytes &to, const Bytes &more) { to.insert(to.end(), more.begin(), more.end()); }
// An element with a known size (sizes here stay below 2^21).
static Bytes element(std::initializer_list<uint8_t> id, const Bytes &body) {
    Bytes out(id);
    size_t n = body.size();
    if (n < 127) out.push_back(uint8_t(0x80 | n));
    else if (n < 16383) { out.push_back(uint8_t(0x40 | n >> 8)); out.push_back(uint8_t(n)); }
    else { out.push_back(uint8_t(0x20 | n >> 16)); out.push_back(uint8_t(n >> 8)); out.push_back(uint8_t(n)); }
    add(out, body); return out;
}
static Bytes open(std::initializer_list<uint8_t> id) { Bytes out(id); out.push_back(0x01); for (int i = 0; i < 7; ++i) out.push_back(0xFF); return out; }
// A stand-in VP8 frame: only the header bytes the reader looks at are real.
static Bytes vp8(bool key, int width, int height, uint8_t fill, size_t size) {
    Bytes out(size, fill);
    out[0] = key ? 0x10 : 0x11;
    if (key) { out[3] = 0x9d; out[4] = 0x01; out[5] = 0x2a; out[6] = uint8_t(width); out[7] = uint8_t(width >> 8); out[8] = uint8_t(height); out[9] = uint8_t(height >> 8); }
    return out;
}
static Bytes simpleBlock(uint8_t track, int16_t relative, const Bytes &frame) {
    Bytes body{uint8_t(0x80 | track), uint8_t(relative >> 8), uint8_t(relative), uint8_t(frame[0] & 1 ? 0x00 : 0x80)};
    add(body, frame); return element({0xA3}, body);
}
// Header, an audio and a video track, then `clusters` clusters of 3 frames, 40 ms apart.
static Bytes stream(int clusters, int width = 1280, int height = 720) {
    Bytes out = element({0x1A, 0x45, 0xDF, 0xA3}, {0x42, 0x82, 0x84, 'w', 'e', 'b', 'm'});
    add(out, open({0x18, 0x53, 0x80, 0x67}));
    add(out, element({0x15, 0x49, 0xA9, 0x66}, element({0x2A, 0xD7, 0xB1}, {0x0F, 0x42, 0x40})));
    Bytes audio = element({0xD7}, {2}); add(audio, element({0x83}, {2}));
    Bytes video = element({0xD7}, {1}); add(video, element({0x83}, {1})); add(video, element({0xE0}, {0xB0, 0x82, 0x05, 0x00}));
    Bytes tracks = element({0xAE}, audio); add(tracks, element({0xAE}, video));
    add(out, element({0x16, 0x54, 0xAE, 0x6B}, tracks));
    for (int c = 0; c < clusters; ++c) {
        add(out, open({0x1F, 0x43, 0xB6, 0x75}));
        add(out, element({0xE7}, {uint8_t(c * 120 >> 8), uint8_t(c * 120)}));
        for (int f = 0; f < 3; ++f) {
            add(out, simpleBlock(2, int16_t(f * 40), Bytes(20, 0xAA)));   // audio: ignored
            add(out, simpleBlock(1, int16_t(f * 40), vp8(c == 0 && f == 0, width, height, uint8_t(c * 3 + f), 200 + size_t(f))));
        }
    }
    return out;
}
static Bytes record(uint32_t serial, uint32_t index, const uint8_t *bytes, size_t size) {
    Bytes out{'J', 'I', 'W', 'M'};
    for (uint32_t value : {uint32_t(size), serial, index}) for (int i = 0; i < 4; ++i) out.push_back(uint8_t(value >> (8 * i)));
    out.insert(out.end(), bytes, bytes + size); return out;
}
static Bytes rawFrame(uint8_t fill) {
    auto header = jibo_media::cameraHeader(jibo_media::cameraWidth, jibo_media::cameraHeight);
    Bytes out(header.begin(), header.end()); out.resize(out.size() + jibo_media::cameraBytes, fill); return out;
}
// Writes it all; a full pipe is emptied by the reader, as the helper's capture thread does.
static void send(int fd, const Bytes &bytes, jibo_media::CameraInput *reader = nullptr) {
    size_t at = 0;
    while (at < bytes.size()) {
        auto n = write(fd, bytes.data() + at, bytes.size() - at);
        if (n > 0) { at += size_t(n); continue; }
        check(n < 0 && (errno == EAGAIN || errno == EINTR) && reader);
        reader->poll();
    }
}

static int describe(const char *path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) { std::cerr << "cannot read " << path << "\n"; return 2; }
    Bytes bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    jibo_media::WebmReader reader; std::vector<EncodedFrame> frames;
    for (size_t at = 0; at < bytes.size(); at += 1000) reader.write(bytes.data() + at, std::min<size_t>(1000, bytes.size() - at), frames);
    if (frames.empty()) { std::cout << "no VP8 frames found" << (reader.failed() ? " (not a readable WebM stream)" : "") << "\n"; return 1; }
    size_t total = 0, keys = 0; int64_t lastKey = -1, widest = 0;
    for (auto &frame : frames) {
        total += frame.data.size();
        if (frame.key) { if (lastKey >= 0) widest = std::max(widest, frame.timeMs - lastKey); lastKey = frame.timeMs; ++keys; }
    }
    double seconds = (frames.back().timeMs - frames.front().timeMs) / 1000.0;
    std::cout << frames.size() << " frames, " << frames.front().width << "x" << frames.front().height << ", " << seconds << " s";
    if (seconds > 0) std::cout << ", " << (frames.size() - 1) / seconds << " fps, " << total * 8 / seconds / 1000 << " kbit/s";
    std::cout << "\n" << keys << " keyframes";
    if (keys > 1) std::cout << ", at most " << widest << " ms apart";
    else std::cout << " (only the first: a new keyframe needs a new stream)";
    std::cout << (reader.failed() ? "\nthe stream stopped being readable part-way" : "") << "\n";
    return 0;
}

int main(int argc, char **argv) {
    if (argc > 1) return describe(argv[1]);
    std::signal(SIGPIPE, SIG_IGN);
    const Bytes webm = stream(4);

    // The reader gives the same frames however the bytes are cut.
    for (size_t chunk : {size_t(1), size_t(7), size_t(1000), webm.size()}) {
        jibo_media::WebmReader reader; std::vector<EncodedFrame> frames;
        for (size_t at = 0; at < webm.size(); at += chunk) check(reader.write(webm.data() + at, std::min(chunk, webm.size() - at), frames));
        check(frames.size() == 12);
        check(frames[0].key && frames[0].width == 1280 && frames[0].height == 720 && frames[0].timeMs == 0);
        for (size_t i = 1; i < frames.size(); ++i) {
            check(!frames[i].key && frames[i].width == 1280 && frames[i].timeMs == int64_t(i) * 40);
            check(frames[i].data.size() == 200 + i % 3 && frames[i].data[20] == uint8_t(i));
        }
    }
    // Not WebM, or an element too large to be a frame: refused, and it stays refused.
    {
        jibo_media::WebmReader reader; std::vector<EncodedFrame> frames;
        Bytes junk(64, 0x00);
        check(!reader.write(junk.data(), junk.size(), frames) && reader.failed());
        check(!reader.write(webm.data(), webm.size(), frames) && frames.empty());
        reader.reset(); check(reader.write(webm.data(), webm.size(), frames) && frames.size() == 12);
        jibo_media::WebmReader big; Bytes huge{0xA3, 0x10, 0x40, 0x00, 0x00};   // a 4 MiB block
        check(!big.write(huge.data(), huge.size(), frames));
    }

    int pipes[2]; check(pipe(pipes) == 0); jibo_media::nonblocking(pipes[1]);
    {
        jibo_media::EncodedQueue queue;
        send(pipes[1], Bytes{'o', 'l', 'd'});
        jibo_media::CameraInput input(pipes[0], queue);
        uint64_t sequence, generation; int64_t time; int w, h; EncodedFrame frame;
        input.poll(); check(!queue.head(sequence, generation, time, w, h) && !input.failed);

        // A stream in three pieces, the middle one split across writes.
        size_t third = webm.size() / 3;
        send(pipes[1], record(1, 0, webm.data(), third));
        Bytes middle = record(1, 1, webm.data() + third, third);
        send(pipes[1], Bytes(middle.begin(), middle.begin() + 9)); input.poll();
        send(pipes[1], Bytes(middle.begin() + 9, middle.end()));
        send(pipes[1], record(1, 2, webm.data() + 2 * third, webm.size() - 2 * third)); input.poll();
        check(queue.streaming && queue.size() == 12 && queue.width == 1280 && queue.height == 720);
        check(queue.head(sequence, generation, time, w, h) && time == 0 && w == 1280);
        uint64_t firstSequence = sequence;
        check(queue.pop(frame) && frame.key);
        check(queue.head(sequence, generation, time, w, h) && sequence == firstSequence + 1 && time == 40);
        check(!queue.takeRestart());

        // A new serial replaces the old stream at once and starts on its keyframe.
        const Bytes second = stream(1, 640, 360);
        uint64_t before = generation;
        send(pipes[1], record(2, 0, second.data(), second.size())); input.poll();
        check(queue.size() == 3 && queue.head(sequence, generation, time, w, h) && generation != before && w == 640 && time == 0);
        check(queue.pop(frame) && frame.key && frame.width == 640);

        // A missing piece cannot be repaired: the queue empties and a new stream is asked for, once.
        send(pipes[1], record(2, 2, second.data(), 10)); input.poll();
        check(queue.size() == 0 && queue.takeRestart() && !queue.takeRestart());
        send(pipes[1], record(2, 3, second.data(), 10)); input.poll();
        check(queue.size() == 0 && !queue.takeRestart());
        // So is a stream joined part-way.
        send(pipes[1], record(7, 5, second.data(), 10)); input.poll();
        queue.requestRestart(); check(!queue.takeRestart());   // within two seconds of the last one

        // Decoded frames still work, and end stream mode; junk between records is skipped.
        send(pipes[1], Bytes{'x', 'y', 'J', 'I'}); send(pipes[1], rawFrame(9), &input); send(pipes[1], rawFrame(11), &input); input.poll();
        Bytes pixels(jibo_media::cameraBytes);
        check(!queue.streaming && input.rawFrame(pixels.data()) && pixels[0] == 11 && pixels.back() == 11);
        check(!input.rawFrame(pixels.data()));

        // Delta frames before a keyframe are never queued; a stalled encoder empties the queue
        // and waits for the camera's next keyframe, without asking for a new stream.
        jibo_media::EncodedQueue waiting; EncodedFrame delta; delta.data = Bytes(10, 1);
        waiting.push(delta); check(waiting.size() == 0);
        EncodedFrame key = delta; key.key = true; key.width = 320; key.height = 240;
        waiting.push(key); for (int i = 0; i < 29; ++i) waiting.push(delta);
        check(waiting.size() == 30 && waiting.overflows == 0);
        waiting.push(delta); check(waiting.size() == 0 && waiting.overflows == 1 && !waiting.takeRestart());
        waiting.push(delta); check(waiting.size() == 0);
        waiting.push(key); waiting.push(delta); check(waiting.size() == 2);   // it resumes at the next keyframe

        // Camera back on: whatever was sent before is dropped.
        send(pipes[1], record(3, 0, webm.data(), webm.size())); input.drain(); input.poll();
        check(queue.size() == 0);
        close(pipes[1]); input.poll(); check(input.failed);
    }
    close(pipes[0]);
    std::cout << "camera input: ok\n";
    return 0;
}
