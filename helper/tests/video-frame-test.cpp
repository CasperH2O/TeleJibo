// SPDX-License-Identifier: GPL-3.0-or-later
#include "video-frame.h"
#include <array>
#include <iostream>
#include <stdexcept>

void check(bool condition) { if (!condition) throw std::runtime_error("video rotation check failed"); }

void plane(const uint8_t *source, int stride, int width, int height,
           const uint8_t *rotated, int outStride, int degrees) {
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        int dx = x, dy = y;
        if (degrees == 90) { dx = height - 1 - y; dy = x; }
        if (degrees == 180) { dx = width - 1 - x; dy = height - 1 - y; }
        if (degrees == 270) { dx = y; dy = width - 1 - x; }
        check(source[y * stride + x] == rotated[dy * outStride + dx]);
    }
}

int main() {
    const std::array<webrtc::VideoRotation, 4> rotations = {webrtc::kVideoRotation_0,
        webrtc::kVideoRotation_90, webrtc::kVideoRotation_180, webrtc::kVideoRotation_270};
    auto source = webrtc::I420Buffer::Create(8, 4);
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 8; ++x) source->MutableDataY()[y * source->StrideY() + x] = 16 + y * 8 + x;
    for (int y = 0; y < 2; ++y) for (int x = 0; x < 4; ++x) {
        source->MutableDataU()[y * source->StrideU() + x] = 80 + y * 4 + x;
        source->MutableDataV()[y * source->StrideV() + x] = 160 + y * 4 + x;
    }
    for (auto rotation : rotations) {
        auto frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(source).set_rotation(rotation).build();
        auto out = jibo_media::displayFrame(frame);
        const bool sideways = rotation == 90 || rotation == 270;
        check(out->width() == (sideways ? 4 : 8)); check(out->height() == (sideways ? 8 : 4));
        plane(source->DataY(), source->StrideY(), 8, 4, out->DataY(), out->StrideY(), rotation);
        plane(source->DataU(), source->StrideU(), 4, 2, out->DataU(), out->StrideU(), rotation);
        plane(source->DataV(), source->StrideV(), 4, 2, out->DataV(), out->StrideV(), rotation);
        check(frame.rotation() == rotation); // Incoming frame is not mutated.
        for (auto size : {std::pair{1280, 720}, std::pair{720, 1280}}) {
            auto big = webrtc::I420Buffer::Create(size.first, size.second);
            big->InitializeData();
            auto scaled = jibo_media::displayFrame(webrtc::VideoFrame::Builder().set_video_frame_buffer(big).set_rotation(rotation).build());
            check(scaled->width() <= 640 && scaled->height() <= 480);
            check(scaled->width() % 2 == 0 && scaled->height() % 2 == 0);
            check((scaled->height() > scaled->width()) == ((size.second > size.first) != sideways));
        }
    }
    std::cout << "video-frame-test: all Y/U/V pixels correct at 0/90/180/270 degrees; upright scaling bounded\n";
}
