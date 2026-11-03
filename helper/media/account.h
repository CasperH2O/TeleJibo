// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
// Small, allowlisted TDLib controller. Raw TDLib objects never reach the UI.
#include "third-party/json11.hpp"
#include <algorithm>
#include <cstdint>
#include <cmath>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace jibo {
using Json = json11::Json;
using Object = Json::object;
using Array = Json::array;

inline std::string type(const Json &value) { return value["@type"].string_value(); }
inline int64_t number(const Json &value) {
    if (value.is_number()) {
        auto n = value.number_value();
        return std::isfinite(n) && std::abs(n) <= 9007199254740991.0 && std::trunc(n) == n ? int64_t(n) : 0;
    }
    try {
        size_t consumed = 0;
        auto result = std::stoll(value.string_value(), &consumed);
        return consumed == value.string_value().size() ? result : 0;
    } catch (...) { return 0; }
}

class Account {
public:
    using Send = std::function<void(Json)>;
    Send send, emit;
    std::function<void(const Json&, bool)> startMedia;
    // Receives a downloaded profile photo path; the helper reads and forwards it.
    std::function<void(int64_t, const std::string &)> avatarFile;
    std::function<void()> stopMedia;
    std::function<void(const std::string&)> receiveSignaling;
    std::function<void(bool)> mute, camera;
    std::function<Json()> mediaStats;
    Json parameters, protocol;
    std::string auth = "starting";
    int callId = 0;
    bool outgoing = false, mediaEnabled = false, closed = false;
    std::string mediaSource;
    bool callStarting = false, cancelPending = false, loggedOut = false;
    int64_t self = 0;

    Account(Send requests, Send events, Json settings, Json capabilities, bool enabled, std::string source = "synthetic")
        : send(std::move(requests)), emit(std::move(events)), parameters(std::move(settings)),
          protocol(std::move(capabilities)), mediaEnabled(enabled), mediaSource(enabled ? std::move(source) : "unavailable") {}

    void request(Object query, std::string tag = "") {
        if (!tag.empty()) query["@extra"] = tag;
        send(query);
    }
    void error(std::string reason) { emit(Object{{"event", "error"}, {"reason", reason}}); }
    void discard(int id, bool disconnected = false) {
        request({{"@type", "discardCall"}, {"call_id", id}, {"is_disconnected", disconnected},
                 {"is_video", true}, {"duration", 0}, {"connection_id", "0"}});
    }
    void shutdown() {
        cancelPending = true;
        if (callId) discard(callId);
        if (stopMedia) stopMedia();
        callId = 0; callStarting = false;
        request({{"@type", "close"}});
    }
    void command(const Json &input) {
        const auto method = input["method"].string_value();
        if (method == "ping") {
            return;
        } else if (method == "status") {
            emit(Object{{"event", "status"}, {"authorization", auth}, {"call_id", callId},
                        {"media_source", mediaEnabled ? mediaSource : "unavailable"}});
        } else if (method == "close") {
            shutdown();
        } else if (method == "logout") {
            if (callId) discard(callId);
            if (stopMedia) stopMedia();
            callId = 0; callStarting = false; page.clear(); contacts.clear(); avatars.clear();
            request({{"@type", "logOut"}});
        } else if (method == "login.password" && auth == "password") {
            auto password = input["password"].string_value();
            if (password.empty() || password.size() > 1024) return error("invalid_password_input");
            request({{"@type", "checkAuthenticationPassword"}, {"password", password}}, "password");
        } else if (method == "contacts" && auth == "ready") {
            const auto offset = number(input["offset"]);
            if (offset < 0 || offset > 10000) return error("invalid_page");
            // Avatars are sent again for each page: the face keeps only a bounded cache.
            pageOffset = offset; ++generation; page.clear(); avatars.clear();
            if (!loadedContacts) request({{"@type", "getContacts"}}, "contacts:" + std::to_string(generation));
            else loadPage();
        } else if (method == "call.start" && auth == "ready") {
            const auto id = number(input["user_id"]);
            const auto found = page.find(id);
            if (!mediaEnabled) return error("media_adapter_unavailable");
            if (callId || callStarting) return error("call_busy");
            if (found == page.end() || !found->second.eligible()) return error("contact_unavailable");
            callStarting = true; cancelPending = false;
            request({{"@type", "createCall"}, {"user_id", double(id)}, {"protocol", protocol}, {"is_video", true}}, "create_call");
        } else if (method == "call.accept") {
            if (!mediaEnabled) return error("media_adapter_unavailable");
            if (!callId || outgoing || input["call_id"].int_value() != callId) return error("no_incoming_call");
            request({{"@type", "acceptCall"}, {"call_id", callId}, {"protocol", protocol}}, "accept_call");
        } else if (method == "call.hangup" || method == "call.decline") {
            if (callStarting && !callId) {
                cancelPending = true;
            } else if (callId && input["call_id"].int_value() == callId) {
                discard(callId);
                if (stopMedia) stopMedia();
            } else error("no_matching_call");
        } else if ((method == "call.mute" || method == "call.camera") && callId) {
            if (!input["enabled"].is_bool()) return error("invalid_control");
            if (method == "call.mute" && mute) mute(input["enabled"].bool_value());
            if (method == "call.camera" && camera) camera(input["enabled"].bool_value());
        } else if (method == "call.stats" && callId && mediaStats) {
            emit(mediaStats());
        } else error("invalid_command_or_state");
    }

    void update(const Json &value) {
        const auto kind = type(value), extra = value["@extra"].string_value();
        if (kind == "error") {
            // Recency and avatars are best effort: fall back quietly.
            if (extra == "recent:" + std::to_string(generation)) { loadedContacts = true; loadPage(); return; }
            if (extra.rfind("recent:", 0) == 0 || extra.rfind("a:", 0) == 0 || extra.rfind("p:", 0) == 0) return;
            if (extra == "create_call") callStarting = false;
            emit(Object{{"event", "error"}, {"reason", "telegram_request_failed"},
                        {"code", value["code"].int_value()}, {"operation", safeOperation(extra)}});
        } else if (kind == "updateAuthorizationState") {
            const auto state = value["authorization_state"];
            const auto stateType = type(state);
            if (stateType != "authorizationStateReady") {
                if (stopMedia) stopMedia();
                callId = 0; callStarting = false; page.clear(); contacts.clear(); avatars.clear(); loadedContacts = false;
            }
            if (stateType == "authorizationStateWaitTdlibParameters") send(parameters);
            else if (stateType == "authorizationStateWaitPhoneNumber") {
                auth = "sign_in"; emitAuth();
                request({{"@type", "requestQrCodeAuthentication"}, {"other_user_ids", Array{}}}, "qr");
            } else if (stateType == "authorizationStateWaitOtherDeviceConfirmation") {
                auth = "qr";
                emit(Object{{"event", "authorization"}, {"state", auth}, {"link", state["link"]}});
            } else if (stateType == "authorizationStateWaitPassword") {
                auth = "password";
                emit(Object{{"event", "authorization"}, {"state", auth}, {"hint", state["password_hint"]}});
            } else if (stateType == "authorizationStateReady") {
                auth = "loading_account"; emitAuth(); request({{"@type", "getMe"}}, "self");
                request({{"@type", "setOption"}, {"name", "disable_top_chats"},
                         {"value", Object{{"@type", "optionValueBoolean"}, {"value", true}}}});
            } else {
                auth = stateType == "authorizationStateClosed" ? "closed" :
                       stateType == "authorizationStateLoggingOut" ? "logging_out" :
                       stateType == "authorizationStateClosing" ? "closing" : "unsupported_authorization";
                if (stateType == "authorizationStateLoggingOut") loggedOut = true;
                if (stopMedia) stopMedia();
                callId = 0; callStarting = false; page.clear(); contacts.clear(); avatars.clear(); loadedContacts = false;
                emitAuth(); closed = auth == "closed";
            }
        } else if (kind == "user" && extra == "self") {
            self = number(value["id"]);
            if (self) { auth = "ready"; emitAuth(); }
        } else if (kind == "users" && extra == "contacts:" + std::to_string(generation)) {
            contacts.clear();
            for (const auto &id : value["user_ids"].array_items()) {
                if (contacts.size() == 10000) break;
                if (number(id) != self) contacts.push_back(number(id));
            }
            // Most recent conversations first; a private chat's id is its user's id.
            request({{"@type", "getChats"}, {"chat_list", Object{{"@type", "chatListMain"}}}, {"limit", 200}},
                    "recent:" + std::to_string(generation));
        } else if (kind == "chats" && extra == "recent:" + std::to_string(generation)) {
            rankContacts(value["chat_ids"]);
            loadedContacts = true; loadPage();
        } else if (kind == "file" && extra.rfind("a:", 0) == 0) {
            const auto id = number(Json(extra.substr(2)));
            if (value["local"]["is_downloading_completed"].bool_value() && avatarFile && avatars.count(id))
                avatarFile(id, value["local"]["path"].string_value());
        } else if (kind == "user" && callId && extra == "p:" + std::to_string(callId) && number(value["id"]) == peer) {
            // Who is calling, so the person at the robot can decide before accepting.
            peerName = displayName(value);
            requestAvatar(peer, value["profile_photo"]);
            lastCall["name"] = peerName; emit(lastCall);
        } else if (kind == "user" || kind == "userFullInfo") {
            receiveContact(value, extra);
        } else if (kind == "updateCall") {
            receiveCall(value["call"]);
        } else if (kind == "callId" && extra == "create_call") {
            callStarting = false;
            if (cancelPending) discard(value["id"].int_value());
            else if (!callId) { callId = value["id"].int_value(); outgoing = true; }
        } else if (kind == "updateNewCallSignalingData") {
            if (callId && value["call_id"].int_value() == callId && receiveSignaling)
                receiveSignaling(value["data"].string_value());
        }
    }

private:
    struct Contact {
        std::string name;
        bool known = false, regular = false, callable = false, video = false;
        bool eligible() const { return known && regular && callable && video; }
    };
    std::vector<int64_t> contacts;
    std::map<int64_t, Contact> page;
    std::set<int64_t> avatars;
    int pageOffset = 0, generation = 0;
    bool loadedContacts = false;
    int peerCall = 0;
    int64_t peer = 0;
    std::string peerName;
    Object lastCall;
    void emitAuth() { emit(Object{{"event", "authorization"}, {"state", auth}}); }
    static std::string displayName(const Json &user) {
        auto name = user["first_name"].string_value() + " " + user["last_name"].string_value();
        if (name.size() > 256) {
            size_t end = 256;
            while (end && (uint8_t(name[end]) & 0xc0) == 0x80) --end;
            name.resize(end);
        }
        return name;
    }
    std::string safeOperation(const std::string &tag) {
        for (const auto *known : {"qr", "password", "create_call", "accept_call", "contacts"})
            if (tag == known) return known;
        return "internal";
    }
    void rankContacts(const Json &chatIds) {
        std::map<int64_t, size_t> rank;
        for (const auto &chat : chatIds.array_items()) {
            const auto id = number(chat);
            if (id > 0 && !rank.count(id)) rank.emplace(id, rank.size());
        }
        auto position = [&](int64_t id) { auto found = rank.find(id); return found == rank.end() ? rank.size() : found->second; };
        std::stable_sort(contacts.begin(), contacts.end(), [&](int64_t a, int64_t b) { return position(a) < position(b); });
    }
    void requestAvatar(int64_t id, const Json &photo) {
        const auto small = photo["small"];
        if (!avatarFile || !small.is_object() || avatars.count(id)) return;
        avatars.insert(id);
        if (small["local"]["is_downloading_completed"].bool_value()) avatarFile(id, small["local"]["path"].string_value());
        else request({{"@type", "downloadFile"}, {"file_id", small["id"]}, {"priority", 1}, {"synchronous", true}},
                     "a:" + std::to_string(id));
    }
    void loadPage() {
        for (int i = pageOffset; i < std::min(int(contacts.size()), pageOffset + 6); ++i) {
            const auto id = contacts[i]; page.emplace(id, Contact{});
            const auto tag = std::to_string(generation) + ":" + std::to_string(id);
            request({{"@type", "getUser"}, {"user_id", double(id)}}, "u:" + tag);
            request({{"@type", "getUserFullInfo"}, {"user_id", double(id)}}, "f:" + tag);
        }
        emitPage();
    }
    void emitPage() {
        Array rows;
        for (int i = pageOffset; i < std::min(int(contacts.size()), pageOffset + 6); ++i) {
            const auto id = contacts[i]; const auto &contact = page.at(id);
            if (!contact.known || contact.regular)
                rows.emplace_back(Object{{"id", double(id)}, {"name", contact.name},
                                         {"available", contact.eligible()}});
        }
        emit(Object{{"event", "contacts"}, {"offset", pageOffset}, {"total", int(contacts.size())}, {"users", rows}});
    }
    void receiveContact(const Json &value, const std::string &tag) {
        const auto prefix = (type(value) == "user" ? "u:" : "f:") + std::to_string(generation) + ":";
        if (tag.rfind(prefix, 0) != 0) return;
        const auto id = number(Json(tag.substr(prefix.size())));
        auto found = page.find(id);
        if (found == page.end()) return;
        auto &contact = found->second;
        if (type(value) == "user") {
            contact.name = displayName(value);
            contact.regular = type(value["type"]) == "userTypeRegular" && id != self;
            contact.known = true;
            if (contact.regular) requestAvatar(id, value["profile_photo"]);
        } else {
            contact.callable = value["can_be_called"].bool_value();
            contact.video = value["supports_video_calls"].bool_value();
        }
        emitPage();
    }
    void receiveCall(const Json &call) {
        const int id = call["id"].int_value();
        const auto state = call["state"];
        const auto stateType = type(state);
        const bool terminal = stateType == "callStateDiscarded" || stateType == "callStateError";
        if (!id) return;
        if (cancelPending && call["is_outgoing"].bool_value() && !terminal) {
            discard(id);
            return;
        }
        if (callId && id != callId) {
            if (!terminal) discard(id);
            return;
        }
        if (!callId && terminal) return;
        if (!callId && stateType == "callStateHangingUp") return;
        if (peerCall != id) {
            // A contact on the current page is named at once; getUser also fetches the photo.
            peerCall = id; peer = number(call["user_id"]); peerName.clear();
            const auto known = page.find(peer);
            if (known != page.end() && known->second.known) peerName = known->second.name;
            request({{"@type", "getUser"}, {"user_id", double(peer)}}, "p:" + std::to_string(id));
        }
        callId = id; callStarting = false; outgoing = call["is_outgoing"].bool_value();
        Object event{{"event", "call"}, {"call_id", id}, {"state", stateType},
                     {"outgoing", outgoing}, {"user_id", call["user_id"]}, {"name", peerName}, {"is_video", call["is_video"]},
                     {"media_source", mediaEnabled ? mediaSource : "unavailable"}};
        if (stateType == "callStateReady") {
            event["emojis"] = state["emojis"];
            if (startMedia && mediaEnabled) startMedia(state, outgoing);
            else { discard(id, true); error("media_adapter_unavailable"); }
        }
        lastCall = event; emit(event);
        if (terminal) {
            if (stopMedia) stopMedia();
            callId = 0;
        }
    }
};
}
