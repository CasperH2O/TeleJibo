// SPDX-License-Identifier: GPL-3.0-or-later
// Native account/call helper. stdin/stdout are private bounded JSON-line pipes.
#include "account.h"
#include "Instance.h"
#include "v2/InstanceV2Impl.h"
#include "VideoCaptureInterface.h"
#include "StaticThreads.h"
#include "FakeAudioDeviceModule.h"
#include "api/video/video_frame.h"
#include "api/video/video_sink_interface.h"
#include "modules/audio_device/include/audio_device.h"
#include "rtc_base/ssl_adapter.h"
#include "api/video/i420_buffer.h"
#include "rtc_base/time_utils.h"
#include "pipe-media.h"
#include "camera-input.h"
#include "video-frame.h"
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <deque>
#include <filesystem>
#include <fstream>
#include <future>
#include <mutex>
#include <poll.h>
#include <set>
#include <stdexcept>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/prctl.h>
#include <fcntl.h>
#include <unistd.h>

extern "C" {
int td_create_client_id();
void td_send(int, const char*);
const char *td_receive(double);
const char *td_execute(const char*);
}
namespace tgcalls { void SetProbeCodec(const std::string&); void SetPipeCapture(bool); }
using namespace jibo;
using namespace std::chrono_literals;
namespace fs = std::filesystem;
namespace {
volatile sig_atomic_t interrupted = 0;
void interrupt(int) { interrupted = 1; }

std::string encode(const uint8_t *data, size_t size) {
    std::string result(4 * ((size + 2) / 3), '\0');
    // EVP appends a NUL byte in addition to the returned base64 characters.
    result.resize(result.size() + 1);
    int length = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(result.data()), data, int(size));
    result.resize(length);
    return result;
}
std::vector<uint8_t> decode(const std::string &text, size_t maximum) {
    if (text.empty() || text.size() % 4 || text.size() > 4 * ((maximum + 2) / 3))
        throw std::runtime_error("invalid_base64");
    std::vector<uint8_t> result(text.size() / 4 * 3);
    int size = EVP_DecodeBlock(result.data(), reinterpret_cast<const unsigned char*>(text.data()), text.size());
    if (size < 0) throw std::runtime_error("invalid_base64");
    if (text.back() == '=') --size;
    if (text.size() > 1 && text[text.size() - 2] == '=') --size;
    result.resize(size);
    if (result.size() > maximum || encode(result.data(), result.size()) != text)
        throw std::runtime_error("invalid_base64");
    return result;
}
Json parse(const std::string &text) {
    std::string error;
    auto value = Json::parse(text, error);
    if (!error.empty() || !value.is_object()) throw std::runtime_error("invalid_json_object");
    return value;
}
std::string privateFile(const fs::path &path, size_t maximum) {
    int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) throw std::runtime_error("private_file_unavailable");
    struct stat state{};
    if (fstat(fd, &state) || !S_ISREG(state.st_mode) || state.st_uid != geteuid() ||
        (state.st_mode & 077) || state.st_size < 0 || size_t(state.st_size) > maximum) {
        close(fd); throw std::runtime_error("private_file_permissions_or_size");
    }
    std::string result(size_t(state.st_size), '\0');
    size_t offset = 0;
    while (offset < result.size()) {
        auto length = read(fd, result.data() + offset, result.size() - offset);
        if (length < 0 && errno == EINTR) continue;
        if (length <= 0) { close(fd); throw std::runtime_error("private_file_read"); }
        offset += length;
    }
    close(fd); return result;
}
// All or nothing: written beside the target, then renamed into place (never over
// an existing file), so an interrupted run leaves only a stale `.partial`.
void savePrivate(const fs::path &path, const std::string &content) {
    const auto partial = path.string() + ".partial";
    unlink(partial.c_str());
    int fd = open(partial.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) throw std::runtime_error("private_file_create");
    bool okay = write(fd, content.data(), content.size()) == ssize_t(content.size()) && fsync(fd) == 0;
    close(fd);
    struct stat existing{};
    okay = okay && lstat(path.c_str(), &existing) != 0 && errno == ENOENT && rename(partial.c_str(), path.c_str()) == 0;
    unlink(partial.c_str());
    if (!okay) throw std::runtime_error("private_file_write");
    int directory = open(path.parent_path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0 || fsync(directory) != 0) { if (directory >= 0) close(directory); throw std::runtime_error("private_file_write"); }
    close(directory);
}
void output(const Json &message) {
    auto line = message.dump() + "\n";
    if (line.size() > 131072) throw std::runtime_error("output_limit");
    auto deadline = std::chrono::steady_clock::now() + 500ms;
    size_t offset = 0;
    while (offset < line.size()) {
        auto length = write(STDOUT_FILENO, line.data() + offset, line.size() - offset);
        if (length > 0) offset += length;
        else if (length < 0 && (errno == EAGAIN || errno == EINTR) && std::chrono::steady_clock::now() < deadline) {
            pollfd descriptor{STDOUT_FILENO, POLLOUT, 0}; poll(&descriptor, 1, 10);
        } else throw std::runtime_error("renderer_pipe_unavailable");
    }
}

struct Tone : tgcalls::FakeAudioDeviceModule::Recorder {
    std::array<int16_t, 960> samples{};
    unsigned phase = 0;
    tgcalls::AudioFrame Record() override {
        for (size_t i = 0; i < 480; ++i) {
            int16_t sample = int16_t(2000 * std::sin(2 * 3.141592653589793 * 440 * (phase++ % 48000) / 48000));
            samples[2*i] = samples[2*i+1] = sample;
        }
        return {samples.data(), 480, sizeof(int16_t), 2, 48000, 0, 0};
    }
};
struct Microphone : tgcalls::FakeAudioDeviceModule::Recorder {
    // At most 40 ms of queued microphone audio; older frames are dropped.
    jibo_media::Reader input{jibo_media::microphone, jibo_media::audioBytes, 4};
    std::array<int16_t, 960> samples{};
    tgcalls::AudioFrame Record() override {
        if (!input.frame(reinterpret_cast<uint8_t*>(samples.data()))) samples.fill(0);
        return {samples.data(), 480, sizeof(int16_t), 2, 48000, 0, 0};
    }
};
struct AudioSink : tgcalls::FakeAudioDeviceModule::Renderer {
    std::atomic<unsigned> nonzero{0};
    std::unique_ptr<jibo_media::Writer> output;
    explicit AudioSink(bool pipes) { if (pipes) output = std::make_unique<jibo_media::Writer>(jibo_media::speaker, 38400); }
    bool Render(const tgcalls::AudioFrame &frame) override {
        // Render's count is total interleaved samples, not samples per channel.
        for (size_t i = 0; i < frame.num_samples; ++i)
            if (std::abs(int(frame.audio_samples[i])) > 100) { ++nonzero; break; }
        if (output) {
            const auto *bytes = reinterpret_cast<const uint8_t*>(frame.audio_samples);
            output->push(std::vector<uint8_t>(bytes, bytes + frame.num_samples * sizeof(int16_t)));
        }
        return true;
    }
};
struct VideoSink : rtc::VideoSinkInterface<webrtc::VideoFrame> {
    std::atomic<unsigned> frames{0};
    std::atomic<int> width{0}, height{0};
    std::unique_ptr<jibo_media::Writer> output;
    int64_t last = 0;
    explicit VideoSink(bool pipes) { if (pipes) output = std::make_unique<jibo_media::Writer>(jibo_media::video, 640 * 480 * 3); }
    void OnFrame(const webrtc::VideoFrame &frame) override {
        ++frames; width = frame.width(); height = frame.height();
        if (output && rtc::TimeMicros() - last >= 100000) {
            last = rtc::TimeMicros();
            auto pixels = jibo_media::displayFrame(frame);
            const int w = pixels->width(), h = pixels->height();
            std::vector<uint8_t> bytes(12 + w * h * 3 / 2);
            memcpy(bytes.data(), "JIVF", 4);
            for (int i = 0; i < 4; ++i) { bytes[4+i] = uint8_t(w >> (i*8)); bytes[8+i] = uint8_t(h >> (i*8)); }
            auto *cursor = bytes.data() + 12;
            for (int y = 0; y < h; ++y) { memcpy(cursor, pixels->DataY() + y * pixels->StrideY(), w); cursor += w; }
            for (int y = 0; y < h/2; ++y) { memcpy(cursor, pixels->DataU() + y * pixels->StrideU(), w/2); cursor += w/2; }
            for (int y = 0; y < h/2; ++y) { memcpy(cursor, pixels->DataV() + y * pixels->StrideV(), w/2); cursor += w/2; }
            output->push(std::move(bytes));
        }
    }
};

class Engine {
    std::unique_ptr<tgcalls::Instance> instance;
    std::shared_ptr<tgcalls::VideoCaptureInterface> capture;
    std::shared_ptr<VideoSink> sink;
    std::shared_ptr<AudioSink> audio;
    std::shared_ptr<Microphone> microphone;
    std::mutex mutex;
    std::deque<std::pair<std::string, std::string>> events;
    std::deque<std::vector<uint8_t>> pending;
    std::atomic<bool> overflow{false};
    void enqueue(std::string kind, std::string data) {
        std::lock_guard lock(mutex);
        if (events.size() >= 128 || data.size() > 90000) overflow = true;
        else events.emplace_back(std::move(kind), std::move(data));
    }
public:
    bool relayOnly = false, pipeMedia = false;
    ~Engine() { stop(); }
    void start(const Json &ready, bool outgoing) {
        if (instance) return;
        const auto available = tgcalls::Meta::Versions();
        std::string version;
        for (const auto &item : ready["protocol"]["library_versions"].array_items())
            if (std::find(available.begin(), available.end(), item.string_value()) != available.end()) {
                version = item.string_value(); break;
            }
        if (version.empty()) throw std::runtime_error("unsupported_call_protocol");
        auto bytes = decode(ready["encryption_key"].string_value(), 256);
        if (bytes.size() != 256) throw std::runtime_error("invalid_call_key");
        auto key = std::shared_ptr<std::array<uint8_t, 256>>(new std::array<uint8_t, 256>, [](auto *value) {
            OPENSSL_cleanse(value->data(), value->size()); delete value;
        });
        std::copy(bytes.begin(), bytes.end(), key->begin()); OPENSSL_cleanse(bytes.data(), bytes.size());
        auto servers = ready["servers"].array_items();
        if (servers.size() > 128) throw std::runtime_error("server_limit");
        std::set<int64_t> reflectorIds;
        for (const auto &server : servers)
            if (type(server["type"]) == "callServerTypeTelegramReflector") reflectorIds.insert(number(server["id"]));
        std::vector<tgcalls::RtcServer> rtcServers;
        for (const auto &server : servers) {
            auto description = server["type"];
            auto port = number(server["port"]);
            if (port < 1 || port > 65535) throw std::runtime_error("invalid_call_server");
            for (const auto *field : {"ip_address", "ipv6_address"}) {
                const auto host = server[field].string_value();
                if (host.empty()) continue;
                if (host.size() > 255) throw std::runtime_error("invalid_call_server");
                if (type(description) == "callServerTypeTelegramReflector") {
                    auto tag = decode(description["peer_tag"].string_value(), 16);
                    if (tag.size() != 16) throw std::runtime_error("invalid_peer_tag");
                    std::string password;
                    for (uint8_t byte : tag) { password += "0123456789abcdef"[byte >> 4]; password += "0123456789abcdef"[byte & 15]; }
                    const auto index = std::distance(reflectorIds.begin(), reflectorIds.find(number(server["id"])));
                    rtcServers.push_back({.id = uint8_t(index + 1), .host = host, .port = uint16_t(port),
                        .login = "reflector", .password = password, .isTurn = true, .isTcp = description["is_tcp"].bool_value()});
                } else if (type(description) == "callServerTypeWebrtc") {
                    if (description["supports_stun"].bool_value()) rtcServers.push_back({.host = host, .port = uint16_t(port)});
                    if (description["supports_turn"].bool_value()) rtcServers.push_back({.host = host, .port = uint16_t(port),
                        .login = description["username"].string_value(), .password = description["password"].string_value(), .isTurn = true});
                }
            }
        }
        sink = std::make_shared<VideoSink>(pipeMedia);
        audio = std::make_shared<AudioSink>(pipeMedia);
        if (pipeMedia) microphone = std::make_shared<Microphone>();
        capture = std::shared_ptr<tgcalls::VideoCaptureInterface>(tgcalls::VideoCaptureInterface::Create(tgcalls::StaticThreads::getThreads(), "synthetic"));
        // The robot camera stays off until the person turns it on for this call.
        if (pipeMedia) capture->setState(tgcalls::VideoState::Inactive);
        tgcalls::Descriptor descriptor{
            .version = version,
            .config = {.initializationTimeout = 20, .receiveTimeout = 20, .enableP2P = ready["allow_p2p"].bool_value() && !relayOnly,
                       .maxApiLayer = tgcalls::Meta::MaxLayer(), .preferredVideoCodecs = pipeMedia ? std::vector<std::string>{"VP8"} : std::vector<std::string>{"VP8", "H264"},
                       .customParameters = ready["custom_parameters"].string_value()},
            .rtcServers = rtcServers,
            .encryptionKey = tgcalls::EncryptionKey(key, outgoing),
            .videoCapture = capture,
            .stateUpdated = [this](tgcalls::State state) {
                enqueue("state", state == tgcalls::State::Established ? "established" :
                    state == tgcalls::State::Failed ? "failed" : state == tgcalls::State::Reconnecting ? "reconnecting" : "connecting");
            },
            .signalingDataEmitted = [this](const std::vector<uint8_t> &data) {
                if (data.size() > 65536) overflow = true;
                else enqueue("signal", encode(data.data(), data.size()));
            },
            .createAudioDeviceModule = tgcalls::FakeAudioDeviceModule::Creator(audio,
                microphone ? std::shared_ptr<tgcalls::FakeAudioDeviceModule::Recorder>(microphone) : std::make_shared<Tone>(),
                {.samples_per_sec = 48000, .num_channels = 2})
        };
        instance = tgcalls::Meta::Create(version, std::move(descriptor));
        if (!instance) throw std::runtime_error("engine_create_failed");
        instance->setIncomingVideoOutput(sink);
        for (const auto &packet : pending) instance->receiveSignalingData(packet);
        pending.clear();
    }
    void receive(const std::string &data) {
        auto bytes = decode(data, 65536);
        if (instance) instance->receiveSignalingData(bytes);
        else if (pending.size() < 64) pending.push_back(std::move(bytes));
        else throw std::runtime_error("signaling_limit");
    }
    auto drain() {
        if (overflow) throw std::runtime_error("engine_event_limit");
        std::lock_guard lock(mutex);
        std::deque<std::pair<std::string, std::string>> result;
        result.swap(events); return result;
    }
    void setMute(bool enabled) { if (instance) instance->setMuteMicrophone(enabled); }
    bool active() const { return bool(instance); }
    void setCamera(bool enabled) { if (capture) capture->setState(enabled ? tgcalls::VideoState::Active : tgcalls::VideoState::Inactive); }
    Json stats() {
        rusage usage{}; getrusage(RUSAGE_SELF, &usage);
        auto &camera = jibo_media::encodedCamera();
        return Object{{"event", "media_stats"}, {"media_source", pipeMedia ? "robot" : "synthetic"}, {"relay_only", relayOnly},
            {"decoded_video_frames", sink ? double(sink->frames.load()) : 0},
            {"decoded_width", sink ? sink->width.load() : 0}, {"decoded_height", sink ? sink->height.load() : 0},
            {"nonzero_audio_frames", audio ? double(audio->nonzero.load()) : 0},
            // A failed device pipe stays failed for the call; drops are a stalled reader.
            {"microphone_pipe_failed", microphone && microphone->input.failed},
            {"speaker_pipe_failed", audio && audio->output && audio->output->failed},
            {"video_pipe_failed", sink && sink->output && sink->output->failed},
            {"dropped_speaker_frames", audio && audio->output ? double(audio->output->dropped.load()) : 0},
            {"dropped_video_frames", sink && sink->output ? double(sink->output->dropped.load()) : 0},
            // Outgoing camera: "stream" is Jibo's own VP8 passed through, "frames" the encoded fallback.
            {"camera_mode", !pipeMedia ? "synthetic" : camera.streaming ? "stream" : "frames"},
            {"camera_sent_frames", double(camera.sent.load())}, {"camera_waiting_frames", double(camera.size())},
            {"camera_restarts", double(camera.restarts.load())}, {"camera_overflows", double(camera.overflows.load())},
            {"camera_width", camera.width.load()}, {"camera_height", camera.height.load()},
            {"camera_target_bps", camera.targetBps.load()},
            {"maxrss_kib", double(usage.ru_maxrss)},
            {"cpu_seconds", usage.ru_utime.tv_sec + usage.ru_stime.tv_sec + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000000.0}};
    }
    void stop() {
        if (instance) {
            auto completion = std::make_shared<std::promise<void>>(); auto future = completion->get_future();
            instance->stop([completion](tgcalls::FinalState) { completion->set_value(); });
            if (future.wait_for(5s) != std::future_status::ready) std::_Exit(71);
            instance.reset(); capture.reset(); sink.reset(); audio.reset(); microphone.reset();
            tgcalls::StaticThreads::getThreads()->getMediaThread()->BlockingCall([]{});
        }
        pending.clear(); std::lock_guard lock(mutex); events.clear(); overflow = false;
    }
};

Json protocol(bool relayOnly) {
    Array versions;
    for (const auto &version : tgcalls::Meta::Versions()) versions.emplace_back(version);
    // The pinned TDLib schema explicitly specifies min_layer=65; maximum and
    // supported library versions come from the engine actually linked here.
    return Object{{"@type", "callProtocol"}, {"udp_p2p", !relayOnly}, {"udp_reflector", true},
                  {"min_layer", 65}, {"max_layer", tgcalls::Meta::MaxLayer()}, {"library_versions", versions}};
}
}

int main(int argc, char **argv) {
    umask(077);
    // Enforce this in the shipped helper too, not only in the lab's init script:
    // a crash dump must not persist session keys or decoded call buffers.
    rlimit noCore{0, 0};
    if (setrlimit(RLIMIT_CORE, &noCore) != 0 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 70;
    std::signal(SIGPIPE, SIG_IGN); std::signal(SIGTERM, interrupt); std::signal(SIGINT, interrupt);
    fs::path apiFile, stateDir;
    bool synthetic = false, pipeMedia = false, relayOnly = false, requireHeartbeat = false;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--api-file" && i+1 < argc) apiFile = argv[++i];
        else if (arg == "--state-dir" && i+1 < argc) stateDir = argv[++i];
        else if (arg == "--synthetic-media") synthetic = true;
        else if (arg == "--pipe-media") pipeMedia = true;
        else if (arg == "--relay-only") relayOnly = true;
        else if (arg == "--require-heartbeat") requireHeartbeat = true;
        else return 64;
    }
    if (apiFile.empty() || stateDir.empty()) {
        std::fputs("Usage: telegram-helper --api-file PRIVATE_JSON --state-dir PRIVATE_DIRECTORY [--synthetic-media]\n", stderr);
        return 64;
    }
    int client = 0;
    std::unique_ptr<Account> account;
    Engine engine;
    engine.relayOnly = relayOnly;
    engine.pipeMedia = pipeMedia;
    try {
        if (synthetic && pipeMedia) throw std::runtime_error("conflicting_media_modes");
        if (pipeMedia) for (int fd : {3,4,5,6}) jibo_media::nonblocking(fd);
        auto api = parse(privateFile(apiFile, 4096));
        const auto apiId = number(api["api_id"]);
        if (apiId < 1 || apiId > INT32_MAX || api["api_hash"].string_value().size() != 32)
            throw std::runtime_error("invalid_api_credentials");
        stateDir = fs::absolute(stateDir).lexically_normal();
        if (fs::weakly_canonical(apiFile).string().rfind(fs::weakly_canonical(stateDir).string() + "/", 0) == 0)
            throw std::runtime_error("api_file_must_be_outside_account_state");
        bool created = mkdir(stateDir.c_str(), 0700) == 0;
        struct stat directory{};
        if (lstat(stateDir.c_str(), &directory) || !S_ISDIR(directory.st_mode) || directory.st_uid != geteuid() || (directory.st_mode & 077))
            throw std::runtime_error("account_directory_permissions");
        // A first run interrupted before its marker landed leaves nothing but `.partial` files.
        const auto unfinished = [&] {
            for (const auto &entry : fs::directory_iterator(stateDir))
                if (entry.path().extension() != ".partial") return false;
            return true;
        };
        if (created || unfinished()) savePrivate(stateDir / ".jibo-telegram-state", "v1\n");
        if (privateFile(stateDir / ".jibo-telegram-state", 16) != "v1\n") throw std::runtime_error("account_directory_not_owned");
        if (!fs::exists(stateDir / "database.key")) {
            std::array<uint8_t, 32> key{};
            if (RAND_bytes(key.data(), key.size()) != 1) throw std::runtime_error("entropy_unavailable");
            savePrivate(stateDir / "database.key", std::string(reinterpret_cast<char*>(key.data()), key.size()));
            OPENSSL_cleanse(key.data(), key.size());
        }
        auto databaseKey = privateFile(stateDir / "database.key", 32);
        if (databaseKey.size() != 32) throw std::runtime_error("invalid_database_key");
        Json parameters = Object{{"@type", "setTdlibParameters"}, {"database_directory", (stateDir / "tdlib").string()},
            {"files_directory", (stateDir / "files").string()}, {"database_encryption_key", encode(reinterpret_cast<const uint8_t*>(databaseKey.data()), databaseKey.size())},
            {"use_file_database", false}, {"use_chat_info_database", false}, {"use_message_database", false}, {"use_secret_chats", false},
            {"api_id", double(apiId)}, {"api_hash", api["api_hash"]}, {"system_language_code", "en"},
            {"device_model", "JIBO"}, {"system_version", "BEam"}, {"application_version", "0.1.0"}};
        OPENSSL_cleanse(databaseKey.data(), databaseKey.size());
        fcntl(STDOUT_FILENO, F_SETFL, fcntl(STDOUT_FILENO, F_GETFL) | O_NONBLOCK);
        fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
        td_execute("{\"@type\":\"setLogVerbosityLevel\",\"new_verbosity_level\":0}");
        td_execute("{\"@type\":\"setLogStream\",\"log_stream\":{\"@type\":\"logStreamEmpty\"}}");
        if (!rtc::InitializeSSL()) throw std::runtime_error("ssl_initialization");
        // Jibo's camera stream is VP8, so the robot offers only that; every Telegram app takes it.
        tgcalls::SetProbeCodec(pipeMedia ? "VP8" : "AUTO"); tgcalls::SetPipeCapture(pipeMedia); tgcalls::Register<tgcalls::InstanceV2Impl>();
        client = td_create_client_id();
        account = std::make_unique<Account>([client](Json value) { td_send(client, value.dump().c_str()); }, output, parameters, protocol(relayOnly), synthetic);
        if (pipeMedia) account->mediaSource = "robot";
        account->startMedia = [&](const Json &ready, bool outgoing) {
            try { engine.start(ready, outgoing); }
            catch (const std::exception&) { account->discard(account->callId, true); account->error("engine_start_failed"); engine.stop(); }
        };
        account->stopMedia = [&] {
            if (engine.active()) { try { output(engine.stats()); } catch (...) {} }
            engine.stop();
        };
        account->receiveSignaling = [&](const std::string &data) { engine.receive(data); };
        account->mute = [&](bool value) { engine.setMute(value); };
        account->camera = [&](bool value) { engine.setCamera(value); };
        account->mediaStats = [&] { return engine.stats(); };
        // Profile photos: only TDLib's photo/file directories, small JPEGs, once per contacts page.
        const std::array<fs::path, 2> photoRoots{fs::weakly_canonical(stateDir / "tdlib" / "profile_photos"),
                                                 fs::weakly_canonical(stateDir / "files")};
        account->avatarFile = [&, photoRoots](int64_t id, const std::string &path) {
            std::error_code failed;
            const auto file = fs::weakly_canonical(fs::path(path), failed);
            const auto inside = [&](const fs::path &root) {
                const auto relative = file.lexically_relative(root);
                return !relative.empty() && *relative.begin() != "..";
            };
            if (failed || std::none_of(photoRoots.begin(), photoRoots.end(), inside) || !fs::is_regular_file(file, failed)) return;
            const auto size = fs::file_size(file, failed);
            if (failed || size == 0 || size > 65536) return;
            std::ifstream stream(file, std::ios::binary);
            std::string bytes(size, '\0');
            if (!stream.read(bytes.data(), std::streamsize(size))) return;
            output(Object{{"event", "avatar"}, {"user_id", double(id)},
                          {"jpeg", encode(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size())}});
        };
        output(Object{{"event", "helper"}, {"version", 1}, {"media_source", pipeMedia ? "robot" : synthetic ? "synthetic" : "unavailable"}, {"relay_only", relayOnly}});
        account->request({{"@type", "getAuthorizationState"}});
        std::string input;
        bool closing = false;
        bool heartbeat = requireHeartbeat;
        auto lastBeat = std::chrono::steady_clock::now();
        auto lastStats = lastBeat;
        auto deadline = std::chrono::steady_clock::time_point::max();
        while (!account->closed && std::chrono::steady_clock::now() < deadline) {
            char buffer[4096];
            auto length = closing ? -1 : read(STDIN_FILENO, buffer, sizeof(buffer));
            if (length == 0) { account->shutdown(); closing = true; deadline = std::chrono::steady_clock::now() + 5s; }
            else if (length > 0) {
                input.append(buffer, size_t(length));
                if (input.size() > 16384) throw std::runtime_error("input_limit");
                size_t end;
                while ((end = input.find('\n')) != std::string::npos) {
                    auto line = input.substr(0, end); input.erase(0, end + 1);
                    try {
                        auto command = parse(line);
                        if (command["method"].string_value() == "ping") { heartbeat = true; lastBeat = std::chrono::steady_clock::now(); }
                        if (pipeMedia && command["method"].string_value() == "media.ready" && command["enabled"].is_bool()) {
                            account->mediaEnabled = command["enabled"].bool_value();
                            if (!account->mediaEnabled && account->callId) { account->discard(account->callId, true); engine.stop(); }
                        } else account->command(command);
                        if (command["method"].string_value() == "close" || command["method"].string_value() == "logout") {
                            closing = true; deadline = std::chrono::steady_clock::now() + 10s; break;
                        }
                    } catch (const std::exception&) { account->error("invalid_command"); }
                }
            } else if (!closing && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                throw std::runtime_error("input_pipe_failed");
            }
            // After reading: pings queued behind a slow iteration (a call teardown) still count.
            if (heartbeat && !closing && std::chrono::steady_clock::now() - lastBeat > 5s) {
                output(Object{{"event", "error"}, {"reason", "heartbeat_expired"}});
                interrupted = 1;
            }
            if (interrupted && !closing) { account->shutdown(); closing = true; deadline = std::chrono::steady_clock::now() + 5s; }
            if (const char *message = td_receive(0.01)) account->update(parse(message));
            if (engine.active() && std::chrono::steady_clock::now() - lastStats >= 5s) {
                output(engine.stats()); lastStats = std::chrono::steady_clock::now();
            }
            // The far side needs a keyframe, or the camera stream broke: the skill starts a new one.
            if (pipeMedia && jibo_media::encodedCamera().takeRestart() && engine.active())
                output(Object{{"event", "camera"}, {"state", "restart"}});
            for (auto &[kind, data] : engine.drain()) {
                if (kind == "signal" && account->callId) account->request({{"@type", "sendCallSignalingData"}, {"call_id", account->callId}, {"data", data}});
                else if (kind == "state") {
                    output(Object{{"event", "media"}, {"state", data}, {"media_source", pipeMedia ? "robot" : "synthetic"}});
                    if (data == "failed" && account->callId) { account->discard(account->callId, true); engine.stop(); }
                }
            }
        }
        engine.stop();
        if (!account->closed) throw std::runtime_error("tdlib_close_deadline");
        if (account->loggedOut) {
            fs::remove_all(stateDir);
            output(Object{{"event", "signed_out"}, {"local_state_removed", true}});
        }
        return 0;
    } catch (const std::exception&) {
        // Never print exception text from a library, raw TDLib updates, secrets,
        // QR links, call keys, relay passwords or media payloads to diagnostics.
        if (account) { try { account->shutdown(); } catch (...) {} }
        engine.stop();
        std::fputs("telegram-helper failed; private state retained\n", stderr);
        return 70;
    }
}
