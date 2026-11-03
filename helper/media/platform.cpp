// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic capture only: 320x240 I420 at 10 fps. No device or file access.
#include "platform/PlatformInterface.h"
#include "VideoCapturerInterface.h"
#include "VideoCaptureInterface.h"
#include "api/video/i420_buffer.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/video_encoder.h"
#include "media/base/adapted_video_track_source.h"
#include "rtc_base/time_utils.h"
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include "pipe-media.h"

namespace tgcalls {
namespace {
std::string selectedCodec = "VP8";
bool pipeCapture = false;

class EncoderFactory : public webrtc::VideoEncoderFactory {
    std::unique_ptr<webrtc::VideoEncoderFactory> inner_ = webrtc::CreateBuiltinVideoEncoderFactory();
public:
    std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
        auto formats = inner_->GetSupportedFormats();
        std::erase_if(formats, [](const auto &format) {
            return selectedCodec == "AUTO" ? format.name != "VP8" && format.name != "H264" : format.name != selectedCodec;
        });
        return formats;
    }
    std::unique_ptr<webrtc::VideoEncoder> CreateVideoEncoder(const webrtc::SdpVideoFormat &format) override {
        return selectedCodec == "AUTO" || format.name == selectedCodec ? inner_->CreateVideoEncoder(format) : nullptr;
    }
};

class Source : public rtc::AdaptedVideoTrackSource {
    std::unique_ptr<jibo_media::Reader> input;
public:
    Source() { if (pipeCapture) input = std::make_unique<jibo_media::Reader>(jibo_media::camera, jibo_media::cameraBytes, 0); }
    SourceState state() const override { return kLive; }
    bool remote() const override { return false; }
    bool is_screencast() const override { return false; }
    absl::optional<bool> needs_denoising() const override { return false; }
    void frame(int sequence) {
        auto pixels = webrtc::I420Buffer::Create(320, 240);
        if (input) {
            std::array<uint8_t, jibo_media::cameraBytes> bytes;
            if (!input->frame(bytes.data())) return;
            for (int y = 0; y < 240; ++y) memcpy(pixels->MutableDataY() + y * pixels->StrideY(), bytes.data() + y * 320, 320);
            for (int y = 0; y < 120; ++y) {
                memcpy(pixels->MutableDataU() + y * pixels->StrideU(), bytes.data() + 76800 + y * 160, 160);
                memcpy(pixels->MutableDataV() + y * pixels->StrideV(), bytes.data() + 96000 + y * 160, 160);
            }
            OnFrame(webrtc::VideoFrame::Builder().set_video_frame_buffer(pixels)
                .set_timestamp_us(rtc::TimeMicros()).set_rotation(webrtc::kVideoRotation_0).build());
            return;
        }
        for (int y = 0; y < 240; ++y) {
            for (int x = 0; x < 320; ++x) {
                pixels->MutableDataY()[y * pixels->StrideY() + x] = 32 + ((x + y + sequence * 5) % 192);
            }
        }
        memset(pixels->MutableDataU(), 90, pixels->StrideU() * 120);
        memset(pixels->MutableDataV(), 160, pixels->StrideV() * 120);
        OnFrame(webrtc::VideoFrame::Builder().set_video_frame_buffer(pixels)
            .set_timestamp_us(rtc::TimeMicros()).set_rotation(webrtc::kVideoRotation_0).build());
    }
};

class Capturer : public VideoCapturerInterface {
public:
    explicit Capturer(webrtc::scoped_refptr<Source> source, std::function<void(VideoState)> changed)
        : source_(source), changed_(std::move(changed)), thread_([this] {
        int sequence = 0;
        while (running_) {
            if (active_) source_->frame(sequence++);
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }) {}
    ~Capturer() override { running_ = false; thread_.join(); }
    void setState(VideoState state) override {
        bool enabled = state == VideoState::Active;
        if (active_.exchange(enabled) != enabled && changed_) changed_(state);
    }
    void setPreferredCaptureAspectRatio(float) override {}
    void setUncroppedOutput(std::shared_ptr<rtc::VideoSinkInterface<webrtc::VideoFrame>>) override {}
    int getRotation() override { return 0; }
private:
    webrtc::scoped_refptr<Source> source_;
    std::function<void(VideoState)> changed_;
    std::atomic<bool> running_{true}, active_{true};
    std::thread thread_;
};

class Platform : public PlatformInterface {
public:
    std::unique_ptr<webrtc::VideoEncoderFactory> makeVideoEncoderFactory(bool, bool) override {
        return std::make_unique<EncoderFactory>();
    }
    std::unique_ptr<webrtc::VideoDecoderFactory> makeVideoDecoderFactory() override {
        return webrtc::CreateBuiltinVideoDecoderFactory();
    }
    bool supportsEncoding(const std::string &codec) override {
        return selectedCodec == "AUTO" ? codec == "VP8" || codec == "H264" : codec == selectedCodec;
    }
    webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> makeVideoSource(rtc::Thread*, rtc::Thread*) override {
        return rtc::make_ref_counted<Source>();
    }
    void adaptVideoSource(webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface>, int, int, int) override {}
    std::unique_ptr<VideoCapturerInterface> makeVideoCapturer(
        webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> source, std::string,
        std::function<void(VideoState)> changed, std::function<void(PlatformCaptureInfo)>,
        std::shared_ptr<PlatformContext>, std::pair<int, int> &resolution) override {
        resolution = {320, 240};
        return std::make_unique<Capturer>(webrtc::scoped_refptr<Source>(static_cast<Source*>(source.get())), std::move(changed));
    }
};
}

void SetPipeCapture(bool enabled) { pipeCapture = enabled; }
void SetProbeCodec(const std::string &codec) { selectedCodec = codec; }
std::unique_ptr<PlatformInterface> CreatePlatformInterface() { return std::make_unique<Platform>(); }
}
