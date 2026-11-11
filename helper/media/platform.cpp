// SPDX-License-Identifier: GPL-3.0-or-later
// The call's video input. With --pipe-media it is the camera pipe (camera-input.h): the
// live VP8 stream of Jibo's hardware encoder is sent as it is, and decoded preview
// frames (the fallback) are encoded here. Without it, a synthetic 320x240 pattern.
// No device or file access.
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
#include "api/video/encoded_image.h"
#include "modules/video_coding/codecs/interface/common_constants.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "camera-input.h"

namespace tgcalls {
namespace {
std::string selectedCodec = "VP8";
bool pipeCapture = false;

std::unique_ptr<webrtc::VideoEncoder> cameraEncoder(std::unique_ptr<webrtc::VideoEncoder> inner);

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
        if (selectedCodec != "AUTO" && format.name != selectedCodec) return nullptr;
        auto encoder = inner_->CreateVideoEncoder(format);
        if (encoder && pipeCapture && format.name == "VP8") return cameraEncoder(std::move(encoder));
        return encoder;
    }
};

// VP8 for the call. While the camera stream runs, each Encode sends the next camera frame
// unchanged and ignores the pixels it is given; otherwise it is the stock encoder.
class CameraEncoder : public webrtc::VideoEncoder {
    std::unique_ptr<webrtc::VideoEncoder> inner_;
    webrtc::EncodedImageCallback *callback_ = nullptr;
    bool wantKey_ = false, passed_ = false;
    int64_t wantedAt_ = 0;
    // The camera's encoder makes a keyframe about every two seconds by itself.
    static constexpr int64_t keyframePatienceUs = 4000000;
public:
    explicit CameraEncoder(std::unique_ptr<webrtc::VideoEncoder> inner) : inner_(std::move(inner)) {}
    void SetFecControllerOverride(webrtc::FecControllerOverride *value) override { inner_->SetFecControllerOverride(value); }
    int InitEncode(const webrtc::VideoCodec *codec, const Settings &settings) override { return inner_->InitEncode(codec, settings); }
    int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback *callback) override {
        callback_ = callback; return inner_->RegisterEncodeCompleteCallback(callback);
    }
    int32_t Release() override { return inner_->Release(); }
    int32_t Encode(const webrtc::VideoFrame &frame, const std::vector<webrtc::VideoFrameType> *types) override {
        auto &queue = jibo_media::encodedCamera();
        if (!queue.streaming) {
            // The far side has the camera stream's pictures as reference: start afresh.
            if (passed_) {
                passed_ = false;
                std::vector<webrtc::VideoFrameType> key{webrtc::VideoFrameType::kVideoFrameKey};
                return inner_->Encode(frame, &key);
            }
            return inner_->Encode(frame, types);
        }
        passed_ = true;
        if (types && std::find(types->begin(), types->end(), webrtc::VideoFrameType::kVideoFrameKey) != types->end() && !wantKey_) {
            wantKey_ = true; wantedAt_ = rtc::TimeMicros();
        }
        jibo_media::EncodedFrame next;
        if (!queue.pop(next) || !callback_) {
            if (callback_) callback_->OnDroppedFrame(webrtc::EncodedImageCallback::DropReason::kDroppedByEncoder);
            return WEBRTC_VIDEO_CODEC_OK;
        }
        // The hardware encoder cannot be asked for a keyframe, but its next one is never far
        // off: the far side waits for it. Only if none comes is a new stream asked for.
        if (next.key) wantKey_ = false;
        else if (wantKey_ && rtc::TimeMicros() - wantedAt_ > keyframePatienceUs) { queue.requestRestart(); wantedAt_ = rtc::TimeMicros(); }
        webrtc::EncodedImage image;
        image.SetEncodedData(webrtc::EncodedImageBuffer::Create(next.data.data(), next.data.size()));
        image._encodedWidth = uint32_t(next.width); image._encodedHeight = uint32_t(next.height);
        image._frameType = next.key ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta;
        image.SetRtpTimestamp(frame.timestamp());
        image.capture_time_ms_ = frame.render_time_ms();
        image.rotation_ = webrtc::kVideoRotation_0;
        image.SetSimulcastIndex(0);
        webrtc::CodecSpecificInfo info;
        info.codecType = webrtc::kVideoCodecVP8;
        info.codecSpecific.VP8.nonReference = false;
        info.codecSpecific.VP8.temporalIdx = webrtc::kNoTemporalIdx;
        info.codecSpecific.VP8.layerSync = false;
        info.codecSpecific.VP8.keyIdx = webrtc::kNoKeyIdx;
        info.codecSpecific.VP8.useExplicitDependencies = false;
        callback_->OnEncodedImage(image, &info);
        ++queue.sent;
        return WEBRTC_VIDEO_CODEC_OK;
    }
    void SetRates(const RateControlParameters &parameters) override {
        jibo_media::encodedCamera().targetBps = int(parameters.bitrate.get_sum_bps());
        inner_->SetRates(parameters);
    }
    void OnPacketLossRateUpdate(float rate) override { inner_->OnPacketLossRateUpdate(rate); }
    void OnRttUpdate(int64_t rtt) override { inner_->OnRttUpdate(rtt); }
    void OnLossNotification(const LossNotification &notification) override { inner_->OnLossNotification(notification); }
    EncoderInfo GetEncoderInfo() const override {
        auto info = inner_->GetEncoderInfo();
        if (jibo_media::encodedCamera().streaming) {
            // The stream's size and rate are fixed: nothing here may ask for less.
            info.scaling_settings = webrtc::VideoEncoder::ScalingSettings::kOff;
            info.has_trusted_rate_controller = true; info.is_hardware_accelerated = true;
            info.implementation_name = "jibo-camera";
        }
        return info;
    }
};

std::unique_ptr<webrtc::VideoEncoder> cameraEncoder(std::unique_ptr<webrtc::VideoEncoder> inner) {
    return std::make_unique<CameraEncoder>(std::move(inner));
}

class Source : public rtc::AdaptedVideoTrackSource {
    std::unique_ptr<jibo_media::CameraInput> input;
    std::vector<uint8_t> raw;
    webrtc::scoped_refptr<webrtc::I420Buffer> placeholder;
    std::atomic<bool> fresh{false};
    uint64_t ticked = 0, stream = 0;
    int64_t tickedAt = 0, base = 0, last = 0, syntheticAt = 0;
    bool based = false;
    int sequence = 0;
    void send(webrtc::scoped_refptr<webrtc::I420Buffer> pixels, int64_t stamp) {
        last = stamp;
        OnFrame(webrtc::VideoFrame::Builder().set_video_frame_buffer(pixels)
            .set_timestamp_us(stamp).set_rotation(webrtc::kVideoRotation_0).build());
    }
    void pattern() {
        auto pixels = webrtc::I420Buffer::Create(320, 240);
        for (int y = 0; y < 240; ++y) {
            for (int x = 0; x < 320; ++x) {
                pixels->MutableDataY()[y * pixels->StrideY() + x] = 32 + ((x + y + sequence * 5) % 192);
            }
        }
        ++sequence;
        memset(pixels->MutableDataU(), 90, pixels->StrideU() * 120);
        memset(pixels->MutableDataV(), 160, pixels->StrideV() * 120);
        send(pixels, rtc::TimeMicros());
    }
public:
    Source() {
        if (!pipeCapture) return;
        input = std::make_unique<jibo_media::CameraInput>(jibo_media::camera, jibo_media::encodedCamera());
        raw.resize(jibo_media::cameraBytes);
    }
    SourceState state() const override { return kLive; }
    bool remote() const override { return false; }
    bool is_screencast() const override { return false; }
    absl::optional<bool> needs_denoising() const override { return false; }
    // The camera was switched on: nothing sent while it was off may reach the call.
    void resume() { fresh = true; }
    // Called every few milliseconds by the capture thread while the camera is on.
    void pump() {
        int64_t now = rtc::TimeMicros();
        if (!input) {
            if (now - syntheticAt >= 100000) { syntheticAt = now; pattern(); }
            return;
        }
        if (fresh.exchange(false)) input->drain();
        input->poll();
        if (input->rawFrame(raw.data())) {
            auto pixels = webrtc::I420Buffer::Create(320, 240);
            for (int y = 0; y < 240; ++y) memcpy(pixels->MutableDataY() + y * pixels->StrideY(), raw.data() + y * 320, 320);
            for (int y = 0; y < 120; ++y) {
                memcpy(pixels->MutableDataU() + y * pixels->StrideU(), raw.data() + 76800 + y * 160, 160);
                memcpy(pixels->MutableDataV() + y * pixels->StrideV(), raw.data() + 96000 + y * 160, 160);
            }
            send(pixels, std::max(now, last + 1000));
            return;
        }
        // A waiting camera frame: pass one picture through the engine so its encoder takes
        // it. The picture is only a carrier, black and shared. If the engine dropped the
        // last carrier, send another; a backlog drains at this loop's pace.
        uint64_t head, generation; int64_t timeMs; int width, height;
        if (!jibo_media::encodedCamera().head(head, generation, timeMs, width, height)) return;
        if (head == ticked && now - tickedAt < 40000) return;
        if (!placeholder || placeholder->width() != width || placeholder->height() != height) {
            placeholder = webrtc::I420Buffer::Create(width, height);
            webrtc::I420Buffer::SetBlack(placeholder.get());
        }
        // Frames keep the camera's own spacing, whatever the pipe's delivery jitter.
        if (!based || generation != stream) { based = true; stream = generation; base = now - timeMs * 1000; }
        ticked = head; tickedAt = now;
        send(placeholder, std::max(base + timeMs * 1000, last + 1000));
    }
};

class Capturer : public VideoCapturerInterface {
public:
    explicit Capturer(webrtc::scoped_refptr<Source> source, std::function<void(VideoState)> changed)
        : source_(source), changed_(std::move(changed)), thread_([this] {
        while (running_) {
            if (active_) source_->pump();
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
    }) {}
    ~Capturer() override { running_ = false; thread_.join(); }
    void setState(VideoState state) override {
        bool enabled = state == VideoState::Active;
        if (active_.exchange(enabled) != enabled) {
            if (enabled) source_->resume();
            if (changed_) changed_(state);
        }
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
