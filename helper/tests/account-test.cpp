// SPDX-License-Identifier: GPL-3.0-or-later
// Deterministic controller tests. Synthetic TDLib objects; no live login/call.
#include "account.h"
#include <algorithm>
#include <cstdio>
#include <stdexcept>
using namespace jibo;
void check(bool result, const char *label) { if (!result) throw std::runtime_error(label); }
int main() {
    std::vector<Json> requests, events;
    Account account([&](Json value) { requests.push_back(value); }, [&](Json value) { events.push_back(value); },
                    Object{{"@type", "setTdlibParameters"}, {"api_hash", "private-api-sentinel"}},
                    Object{{"@type", "callProtocol"}, {"library_versions", Array{"13.0.0"}}}, true);
    int stops = 0, starts = 0;
    account.stopMedia = [&] { ++stops; };
    account.startMedia = [&](const Json&, bool) { ++starts; };
    auto auth = [&](std::string state, Object fields = {}) {
        fields["@type"] = state;
        account.update(Object{{"@type", "updateAuthorizationState"}, {"authorization_state", fields}});
    };
    int generation = 1;
    auto user = [&](int id, std::string kind) {
        account.update(Object{{"@type", "user"}, {"id", id}, {"first_name", "Test"}, {"type", Object{{"@type", kind}}},
                              {"@extra", "u:" + std::to_string(generation) + ":" + std::to_string(id)}});
    };
    auto full = [&](int id, bool callable) {
        account.update(Object{{"@type", "userFullInfo"}, {"can_be_called", callable}, {"supports_video_calls", true},
                              {"@extra", "f:" + std::to_string(generation) + ":" + std::to_string(id)}});
    };
    auto call = [&](int id, std::string state, bool outgoing = false, Object extra = {}, bool video = true) {
        extra["@type"] = state;
        account.update(Object{{"@type", "updateCall"}, {"call", Object{{"id", id}, {"user_id", 6},
            {"is_video", video}, {"is_outgoing", outgoing}, {"state", extra}}}});
    };
    try {
        auth("authorizationStateWaitTdlibParameters");
        check(type(requests.back()) == "setTdlibParameters", "parameters request");
        auth("authorizationStateWaitPhoneNumber");
        check(type(requests.back()) == "requestQrCodeAuthentication", "QR request");
        auth("authorizationStateWaitOtherDeviceConfirmation", {{"link", "tg://old-qr"}});
        auth("authorizationStateWaitOtherDeviceConfirmation", {{"link", "tg://new-qr"}});
        check(events.back()["link"].string_value() == "tg://new-qr", "QR renewal");
        auth("authorizationStateWaitPassword", {{"password_hint", "hint"}});
        check(events.back()["link"].is_null(), "QR hidden on password state");
        account.command(Object{{"method", "login.password"}, {"password", "private-password-sentinel"}});
        check(type(requests.back()) == "checkAuthenticationPassword", "password request");
        auth("authorizationStateReady");
        account.update(Object{{"@type", "user"}, {"id", 1}, {"@extra", "self"}});
        account.command(Object{{"method", "contacts"}, {"offset", 0}});
        std::vector<std::pair<int64_t, std::string>> avatars;
        account.avatarFile = [&](int64_t id, const std::string &path) { avatars.emplace_back(id, path); };
        account.update(Object{{"@type", "users"}, {"user_ids", Array{1, 2, 3, 4, 5, 6}}, {"@extra", "contacts:1"}});
        check(type(requests.back()) == "getChats" && requests.back()["@extra"].string_value() == "recent:1", "recent chats requested");
        // Group chats have negative ids; private chats are ordered by recency.
        account.update(Object{{"@type", "chats"}, {"chat_ids", Array{6, -100, 5}}, {"@extra", "recent:1"}});
        // The page is sent at once, before any names: whoever searches it must wait for `complete`.
        check(events.back()["event"].string_value() == "contacts" && !events.back()["complete"].bool_value(), "a new page is incomplete");
        user(2, "userTypeBot"); full(2, true);
        user(3, "userTypeDeleted"); full(3, true);
        user(4, "userTypeRegular"); full(4, false);
        auto photo = [](int file, bool done) { return Object{{"small", Object{{"id", file},
            {"local", Object{{"is_downloading_completed", done}, {"path", done ? "/state/files/photo.jpg" : ""}}}}}}; };
        account.update(Object{{"@type", "user"}, {"id", 5}, {"first_name", "Test"}, {"type", Object{{"@type", "userTypeRegular"}}},
                              {"profile_photo", photo(50, true)}, {"@extra", "u:1:5"}});
        full(5, true);
        account.update(Object{{"@type", "user"}, {"id", 6}, {"first_name", "Test"}, {"type", Object{{"@type", "userTypeRegular"}}},
                              {"profile_photo", photo(60, false)}, {"@extra", "u:1:6"}});
        check(std::any_of(requests.begin(), requests.end(), [](const Json &r) { return type(r) == "downloadFile" && r["file_id"].int_value() == 60; }), "avatar download requested");
        full(6, true);
        check(events.back()["complete"].bool_value(), "a page is complete once every contact is answered");
        account.update(Object{{"@type", "file"}, {"local", Object{{"is_downloading_completed", true}, {"path", "/state/files/six.jpg"}}}, {"@extra", "a:6"}});
        check(avatars.size() == 2 && avatars[0].first == 5 && avatars[1] == std::make_pair(int64_t(6), std::string("/state/files/six.jpg")), "avatars forwarded once each");
        const auto ordered = events.back()["users"].array_items();
        check(ordered.size() == 3 && number(ordered[0]["id"]) == 6 && number(ordered[1]["id"]) == 5 && number(ordered[2]["id"]) == 4, "most recent conversations first");
        int available = 0;
        for (const auto &row : events.back()["users"].array_items()) {
            check(number(row["id"]) != 1 && number(row["id"]) != 2 && number(row["id"]) != 3, "contact type filtering");
            if (row["available"].bool_value()) ++available;
        }
        check(available == 2, "privacy filtering");
        // The face keeps a bounded avatar cache, so each page load sends its avatars again.
        account.command(Object{{"method", "contacts"}, {"offset", 0}}); generation = 2;
        account.update(Object{{"@type", "user"}, {"id", 5}, {"first_name", "Test"}, {"type", Object{{"@type", "userTypeRegular"}}},
                              {"profile_photo", photo(50, true)}, {"@extra", "u:2:5"}});
        check(avatars.size() == 3 && avatars[2].first == 5, "avatars sent again for a reloaded page");
        full(5, true); user(4, "userTypeRegular"); full(4, false); user(6, "userTypeRegular"); full(6, true);
        check(!events.back()["complete"].bool_value(), "a page waits for contacts not yet answered");
        // A failed lookup counts as answered, quietly, so the page still completes.
        for (const auto *tag : {"u:2:2", "f:2:2", "u:2:3", "f:2:3", "u:1:2"})
            account.update(Object{{"@type", "error"}, {"code", 400}, {"message", "failed"}, {"@extra", tag}});
        check(events.back()["event"].string_value() == "contacts" && events.back()["complete"].bool_value(), "failed lookups complete the page");
        account.command(Object{{"method", "call.start"}, {"user_id", 4}});
        check(events.back()["reason"].string_value() == "contact_unavailable", "unavailable contact rejected");
        account.command(Object{{"method", "call.start"}, {"user_id", 6}});
        check(type(requests.back()) == "createCall", "outgoing request");
        account.command(Object{{"method", "call.hangup"}});
        call(77, "callStatePending", true);
        check(type(requests.back()) == "discardCall" && account.callId == 0, "cancel before call id");
        account.update(Object{{"@type", "callId"}, {"id", 77}, {"@extra", "create_call"}});
        check(type(requests.back()) == "discardCall" && account.callId == 0, "late create reply canceled");
        call(80, "callStatePending", false, {}, false);
        check(account.callId == 80 && !events.back()["is_video"].bool_value(), "incoming initially lacks video flag; await explicit acceptance");
        check(events.back()["name"].string_value() == "Test " && type(requests.back()) == "getUser" &&
              requests.back()["@extra"].string_value() == "p:80", "caller named from the page, then looked up");
        account.update(Object{{"@type", "user"}, {"id", 6}, {"first_name", "Caller"}, {"last_name", "Six"},
                              {"type", Object{{"@type", "userTypeRegular"}}}, {"@extra", "p:80"}});
        check(events.back()["call_id"].int_value() == 80 && events.back()["state"].string_value() == "callStatePending" &&
              events.back()["name"].string_value() == "Caller Six", "caller name sent with the call");
        account.update(Object{{"@type", "user"}, {"id", 6}, {"first_name", "Stale"}, {"@extra", "p:77"}});
        check(events.back()["name"].string_value() == "Caller Six", "earlier call's lookup ignored");
        account.command(Object{{"method", "call.accept"}, {"call_id", 80}});
        check(type(requests.back()) == "acceptCall", "foreground accept");
        call(81, "callStatePending");
        check(requests.back()["call_id"].int_value() == 81 && account.callId == 80, "second call busy");
        call(80, "callStateReady", false, {{"encryption_key", "private-call-key-sentinel"},
            {"servers", Array{Object{{"password", "private-relay-sentinel"}}}}, {"emojis", Array{"test"}}});
        check(starts == 1 && events.back()["emojis"].array_items().size() == 1, "ready bridge and fingerprint");
        int beforeStop = stops;
        auth("authorizationStateWaitPhoneNumber");
        check(account.callId == 0 && stops > beforeStop, "revocation stops engine");
        account.update(Object{{"@type", "error"}, {"message", "private-error-sentinel"}, {"code", 400}});
        for (const auto &event : events) {
            for (const auto *secret : {"private-api-sentinel", "private-password-sentinel", "private-call-key-sentinel",
                                      "private-relay-sentinel", "private-error-sentinel"})
                check(event.dump().find(secret) == std::string::npos, "private values stay native");
        }
        Account disabled([](Json){}, [&](Json value) { events.push_back(value); }, Object{}, Object{}, false);
        disabled.auth = "ready";
        disabled.command(Object{{"method", "call.start"}, {"user_id", 6}});
        check(events.back()["reason"].string_value() == "media_adapter_unavailable", "synthetic media requires explicit opt-in");
        puts("{\"account_controller\":\"passed\",\"transport\":\"synthetic TDLib objects; no network\"}");
        return 0;
    } catch (const std::exception &error) {
        std::fprintf(stderr, "account test failed: %s\n", error.what()); return 1;
    }
}
