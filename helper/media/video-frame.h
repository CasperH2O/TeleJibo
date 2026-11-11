// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include <algorithm>

namespace jibo_media {
// JIVF carries upright pixels, not WebRTC's separate pending-rotation metadata.
// Scale before rotating to keep the extra allocation within the pipe's bounds.
inline rtc::scoped_refptr<webrtc::I420Buffer> displayFrame(const webrtc::VideoFrame &frame) {
    const auto rotation = frame.rotation();
    const bool sideways = rotation == webrtc::kVideoRotation_90 || rotation == webrtc::kVideoRotation_270;
    const int displayWidth = sideways ? frame.height() : frame.width();
    const int displayHeight = sideways ? frame.width() : frame.height();
    const float scale = std::min(1.f, std::min(640.f / displayWidth, 480.f / displayHeight));
    const int w = std::max(2, int(frame.width() * scale) & ~1);
    const int h = std::max(2, int(frame.height() * scale) & ~1);
    auto pixels = webrtc::I420Buffer::Create(w, h);
    pixels->CropAndScaleFrom(*frame.video_frame_buffer()->ToI420());
    return rotation == webrtc::kVideoRotation_0 ? pixels : webrtc::I420Buffer::Rotate(*pixels, rotation);
}
} // namespace jibo_media
