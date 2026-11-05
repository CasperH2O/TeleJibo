// SPDX-License-Identifier: GPL-3.0-or-later
#include "../media/pipe-media.h"
#include <csignal>
#include <cstdlib>
#include <iostream>

// Always evaluated: the checked expressions carry pipe/write side effects.
#define check(expression) do { if (!(expression)) { \
    std::cerr << "check failed: " #expression " at line " << __LINE__ << "\n"; std::exit(1); } } while (0)

int main() {
    std::signal(SIGPIPE, SIG_IGN);
    int input[2]; check(pipe(input) == 0);
    {
        jibo_media::Reader reader(input[0], 24);
        std::array<uint8_t, 24> bytes{}, expected{};
        for (int i = 0; i < 24; ++i) expected[i] = uint8_t(i);
        check(write(input[1], expected.data(), 9) == 9);
        check(!reader.frame(bytes.data()));
        check(write(input[1], expected.data() + 9, 15) == 15);
        check(reader.frame(bytes.data())); check(bytes == expected);
        close(input[1]); check(!reader.frame(bytes.data())); check(reader.failed);
    }
    close(input[0]);
    int stale[2]; check(pipe(stale) == 0);
    {
        std::array<uint8_t, 8> bytes{};
        check(write(stale[1], "previous", 8) == 8);
        jibo_media::Reader reader(stale[0], 8, 1);
        check(!reader.frame(bytes.data()) && !reader.failed);
        for (uint8_t i = 0; i < 5; ++i) { bytes.fill(i); check(write(stale[1], bytes.data(), 8) == 8); }
        check(reader.frame(bytes.data()) && bytes[0] == 3);
        check(reader.frame(bytes.data()) && bytes[0] == 4);
        check(!reader.frame(bytes.data()) && !reader.failed);
    }
    close(stale[0]); close(stale[1]);
    int output[2]; check(pipe(output) == 0);
    {
        jibo_media::Writer writer(output[1], 1920);
        check(!writer.push(std::vector<uint8_t>(1921)));
        check(writer.push(std::vector<uint8_t>(1920, 42)));
        pollfd wait{output[0], POLLIN, 0}; check(poll(&wait, 1, 1000) == 1);
        std::array<uint8_t, 1920> bytes{}; check(read(output[0], bytes.data(), bytes.size()) == 1920);
        for (auto value : bytes) check(value == 42);
    }
    close(output[0]); close(output[1]);
    auto receive = [](int fd, size_t size) {
        std::vector<uint8_t> bytes(size); size_t filled = 0;
        while (filled < size) {
            pollfd wait{fd, POLLIN, 0}; check(poll(&wait, 1, 1000) == 1);
            auto n = read(fd, bytes.data() + filled, size - filled); check(n > 0); filled += size_t(n);
        }
        return bytes;
    };
    int stalled[2]; check(pipe(stalled) == 0);
    {
        // A reader that pauses mid-frame still gets the whole frame, then the next one.
        jibo_media::Writer writer(stalled[1], 1 << 20);
        std::vector<uint8_t> frame(200000);
        for (size_t i = 0; i < frame.size(); ++i) frame[i] = uint8_t(i % 251);
        check(writer.push(frame));
        std::this_thread::sleep_for(std::chrono::milliseconds(400));
        check(receive(stalled[0], frame.size()) == frame);
        check(writer.push(std::vector<uint8_t>(64, 7)));
        check(receive(stalled[0], 64) == std::vector<uint8_t>(64, 7));
        check(!writer.failed && writer.dropped == 0);
    }
    close(stalled[0]); close(stalled[1]);
    int full[2]; check(pipe(full) == 0);
    {
        // A frame that cannot start within 250 ms is dropped whole; the writer carries on.
        jibo_media::Writer writer(full[1], 4096);
        std::array<uint8_t, 4096> filler{}; size_t buffered = 0;
        for (ssize_t n; (n = write(full[1], filler.data(), filler.size())) > 0;) buffered += size_t(n);
        check(writer.push(std::vector<uint8_t>(64, 1)));
        std::this_thread::sleep_for(std::chrono::milliseconds(400));
        check(writer.dropped == 1);
        receive(full[0], buffered);
        check(writer.push(std::vector<uint8_t>(64, 2)));
        check(receive(full[0], 64) == std::vector<uint8_t>(64, 2));
        check(!writer.failed);
    }
    close(full[0]); close(full[1]);
    int camera[2]; check(pipe(camera) == 0);
    {
        // Framed camera input: a frame cut short before (or while) a reader exists never
        // shifts later frames, and only the newest complete frame is delivered.
        auto framed = [](uint8_t value, size_t size) {
            auto header = jibo_media::cameraHeader(4, 2);
            std::vector<uint8_t> bytes(header.begin(), header.end());
            bytes.insert(bytes.end(), size, value); return bytes;
        };
        auto send = [&](const std::vector<uint8_t> &bytes) {
            check(write(camera[1], bytes.data(), bytes.size()) == ssize_t(bytes.size()));
        };
        std::array<uint8_t, 12> bytes{};
        auto stale = framed(1, 12); stale.resize(17); send(stale);
        jibo_media::FrameReader reader(camera[0], 4, 2);
        check(!reader.frame(bytes.data()) && !reader.failed);
        auto cut = framed(2, 12); cut.resize(9); send(cut);
        send(framed(3, 12));
        check(reader.frame(bytes.data()) && bytes[0] == 3 && bytes[11] == 3);
        send(framed(4, 12)); send(framed(5, 12));
        auto split = framed(6, 12); send(std::vector<uint8_t>(split.begin(), split.begin() + 5));
        check(reader.frame(bytes.data()) && bytes[0] == 5);
        check(!reader.frame(bytes.data()));
        send(std::vector<uint8_t>(split.begin() + 5, split.end()));
        check(reader.frame(bytes.data()) && bytes[0] == 6);
        // Cut after a whole header: the next frame's header inside the payload wins.
        auto headerOnly = framed(7, 12); headerOnly.resize(15); send(headerOnly); send(framed(8, 12));
        check(reader.frame(bytes.data()) && bytes[0] == 8 && bytes[11] == 8);
        close(camera[1]); check(!reader.frame(bytes.data()) && reader.failed);
    }
    close(camera[0]);
    std::cout << "Private media pipes: fragmentation, EOF, stale drain, latency bound, output, stalls, camera resync and shutdown passed\n";
}
