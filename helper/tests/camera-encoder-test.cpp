// SPDX-License-Identifier: GPL-3.0-or-later
// The call's VP8 encoder with a camera stream: every frame of a real live WebM file must
// come out of Encode() unchanged, in order, keyframe first, and decode to the stream's
// own picture size. ARM build, run under qemu with a WebM file (VP8) as its argument.
#include "platform/PlatformInterface.h"
#include "api/environment/environment_factory.h"
#include "api/video/i420_buffer.h"
#include "api/video/video_frame.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/sdp_video_format.h"
#include "api/video_codecs/video_codec.h"
#include "api/video_codecs/video_decoder.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "camera-input.h"
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace tgcalls { void SetProbeCodec(const std::string&); void SetPipeCapture(bool); }

#define check(expression) do { if (!(expression)) { \
    std::cerr << "check failed: " #expression " at line " << __LINE__ << "\n"; std::exit(1); } } while (0)

struct Collected : webrtc::EncodedImageCallback {
    std::vector<webrtc::EncodedImage> images;
    unsigned dropped = 0;
    Result OnEncodedImage(const webrtc::EncodedImage &image, const webrtc::CodecSpecificInfo *info) override {
        check(info && info->codecType == webrtc::kVideoCodecVP8);
        images.push_back(image); return Result(Result::OK);
    }
    void OnDroppedFrame(DropReason) override { ++dropped; }
};
struct Pictures : webrtc::DecodedImageCallback {
    int count = 0, width = 0, height = 0;
    int32_t Decoded(webrtc::VideoFrame &frame) override { ++count; width = frame.width(); height = frame.height(); return 0; }
};

int main(int argc, char **argv) {
    check(argc == 2);
    std::ifstream file(argv[1], std::ios::binary);
    check(bool(file));
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    jibo_media::WebmReader reader; std::vector<jibo_media::EncodedFrame> frames;
    check(reader.write(bytes.data(), bytes.size(), frames) && frames.size() >= 20 && frames[0].key);

    tgcalls::SetProbeCodec("VP8"); tgcalls::SetPipeCapture(true);
    auto factory = tgcalls::PlatformInterface::SharedInstance()->makeVideoEncoderFactory(false, false);
    auto formats = factory->GetSupportedFormats();
    check(!formats.empty());
    for (const auto &format : formats) check(format.name == "VP8");
    auto encoder = factory->CreateVideoEncoder(formats[0]);
    check(bool(encoder));
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecVP8; codec.width = 1280; codec.height = 720;
    codec.startBitrate = 1500; codec.maxBitrate = 2500; codec.minBitrate = 100; codec.maxFramerate = 30;
    codec.numberOfSimulcastStreams = 0; *codec.VP8() = webrtc::VideoEncoder::GetDefaultVp8Settings();
    check(encoder->InitEncode(&codec, webrtc::VideoEncoder::Settings(webrtc::VideoEncoder::Capabilities(false), 1, 1200)) == WEBRTC_VIDEO_CODEC_OK);
    Collected out; check(encoder->RegisterEncodeCompleteCallback(&out) == WEBRTC_VIDEO_CODEC_OK);
    webrtc::VideoBitrateAllocation rate; rate.SetBitrate(0, 0, 1500000);
    encoder->SetRates(webrtc::VideoEncoder::RateControlParameters(rate, 25.0));

    auto &queue = jibo_media::encodedCamera();
    queue.clear(); queue.streaming = true;
    check(queue.targetBps == 1500000);
    auto info = encoder->GetEncoderInfo();
    check(info.implementation_name == "jibo-camera" && info.has_trusted_rate_controller && info.is_hardware_accelerated);
    check(!info.scaling_settings.thresholds);
    // A small black picture stands in for the camera's: its pixels must not matter.
    auto carrier = webrtc::I420Buffer::Create(1280, 720); webrtc::I420Buffer::SetBlack(carrier.get());
    std::vector<webrtc::VideoFrameType> key{webrtc::VideoFrameType::kVideoFrameKey}, delta{webrtc::VideoFrameType::kVideoFrameDelta};
    auto picture = [&](uint32_t stamp) {
        return webrtc::VideoFrame::Builder().set_video_frame_buffer(carrier).set_timestamp_rtp(stamp).set_timestamp_ms(stamp / 90).build();
    };
    // Nothing waiting: the frame is dropped, not invented.
    check(encoder->Encode(picture(1), &key) == WEBRTC_VIDEO_CODEC_OK && out.images.empty() && out.dropped == 1);
    for (size_t i = 0; i < frames.size(); ++i) {
        queue.push(frames[i]);
        check(encoder->Encode(picture(uint32_t(3600 * (i + 1))), i == 0 ? &key : &delta) == WEBRTC_VIDEO_CODEC_OK);
    }
    check(out.images.size() == frames.size() && queue.sent == frames.size() && queue.size() == 0);
    for (size_t i = 0; i < frames.size(); ++i) {
        const auto &image = out.images[i];
        check(image.size() == frames[i].data.size() && memcmp(image.data(), frames[i].data.data(), image.size()) == 0);
        check((image._frameType == webrtc::VideoFrameType::kVideoFrameKey) == frames[i].key);
        check(image.RtpTimestamp() == uint32_t(3600 * (i + 1)));
        check(int(image._encodedWidth) == frames[0].width && int(image._encodedHeight) == frames[0].height);
    }
    // The far side asks for a keyframe mid-stream: the stream goes on to the camera's next
    // keyframe, and no new stream is asked for meanwhile.
    check(!queue.takeRestart());
    queue.push(frames[1]);
    check(encoder->Encode(picture(9000000), &key) == WEBRTC_VIDEO_CODEC_OK && out.images.size() == frames.size() + 1);
    check(!queue.takeRestart() && queue.restarts == 0);

    auto decoder = webrtc::CreateBuiltinVideoDecoderFactory()->Create(webrtc::EnvironmentFactory().Create(), webrtc::SdpVideoFormat("VP8"));
    check(bool(decoder));
    webrtc::VideoDecoder::Settings settings; settings.set_codec_type(webrtc::kVideoCodecVP8); settings.set_number_of_cores(1);
    settings.set_max_render_resolution({1280, 720});
    check(decoder->Configure(settings));
    Pictures shown; decoder->RegisterDecodeCompleteCallback(&shown);
    for (size_t i = 0; i < frames.size(); ++i) check(decoder->Decode(out.images[i], 0) == WEBRTC_VIDEO_CODEC_OK);
    check(shown.count == int(frames.size()) && shown.width == frames[0].width && shown.height == frames[0].height);

    // Preview frames instead of the stream: the stock encoder takes over and starts with a keyframe.
    queue.streaming = false;
    size_t before = out.images.size();
    auto small = webrtc::I420Buffer::Create(1280, 720); webrtc::I420Buffer::SetBlack(small.get());
    check(encoder->Encode(webrtc::VideoFrame::Builder().set_video_frame_buffer(small).set_timestamp_rtp(9003600).set_timestamp_ms(100040).build(), &delta) == WEBRTC_VIDEO_CODEC_OK);
    check(out.images.size() == before + 1 && out.images.back()._frameType == webrtc::VideoFrameType::kVideoFrameKey);
    check(encoder->GetEncoderInfo().implementation_name != "jibo-camera");
    encoder->Release();
    std::cout << "camera encoder: " << frames.size() << " frames passed through unchanged and decoded at "
              << shown.width << "x" << shown.height << "\n";
    return 0;
}
