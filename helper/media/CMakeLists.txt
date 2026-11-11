cmake_minimum_required(VERSION 3.16)
project(telejibo_helper LANGUAGES C CXX)

set(TG_OWT_SPECIAL_TARGET jibo CACHE STRING "" FORCE)
set(TG_OWT_USE_X11 OFF CACHE BOOL "" FORCE)
set(TG_OWT_USE_PIPEWIRE OFF CACHE BOOL "" FORCE)
set(TG_OWT_BUILD_AUDIO_BACKENDS OFF CACHE BOOL "" FORCE)
set(TG_OWT_OPENSSL_INCLUDE_PATH "${TDLIB_PREFIX}/include" CACHE STRING "" FORCE)
set(TG_OWT_OPUS_INCLUDE_PATH "${MEDIA_PREFIX}/include/opus" CACHE STRING "" FORCE)
set(TG_OWT_FFMPEG_INCLUDE_PATH "${MEDIA_PREFIX}/include" CACHE STRING "" FORCE)
set(TG_OWT_LIBJPEG_INCLUDE_PATH "${MEDIA_PREFIX}/include" CACHE STRING "" FORCE)
set(TG_OWT_OPENH264_INCLUDE_PATH "${MEDIA_PREFIX}/include" CACHE STRING "" FORCE)
set(TG_OWT_LIBVPX_INCLUDE_PATH "${MEDIA_PREFIX}/include" CACHE STRING "" FORCE)
add_subdirectory("${MEDIA_SOURCE}/tg_owt" webrtc)

set(tg "${MEDIA_SOURCE}/tgcalls/tgcalls")
# Build the native one-to-one engine and its production relay implementation.
# Group calls and desktop camera/screen capture are outside this application.
file(GLOB core_sources "${tg}/*.cpp" "${tg}/v2/*.cpp" "${tg}/utils/*.cpp")
list(FILTER core_sources EXCLUDE REGEX "InstanceV2ReferenceImpl.cpp$")
add_library(jibo_tgcalls STATIC ${core_sources} "${tg}/third-party/json11.cpp" platform.cpp)
target_compile_features(jibo_tgcalls PUBLIC cxx_std_20)
target_compile_definitions(jibo_tgcalls PUBLIC TGCALLS_USE_STD_OPTIONAL)
target_include_directories(jibo_tgcalls PUBLIC "${tg}" "${MEDIA_PREFIX}/include" "${TDLIB_PREFIX}/include")
target_link_libraries(jibo_tgcalls PUBLIC tg_owt)

add_library(jibo_media INTERFACE)
target_link_libraries(jibo_media INTERFACE jibo_tgcalls
    "${MEDIA_PREFIX}/lib/libopenh264.a"
    "${MEDIA_PREFIX}/lib/libvpx.a"
    "${MEDIA_PREFIX}/lib/libopus.a"
    "${MEDIA_PREFIX}/lib/libavformat.a"
    "${MEDIA_PREFIX}/lib/libavcodec.a"
    "${MEDIA_PREFIX}/lib/libavutil.a"
    "${MEDIA_PREFIX}/lib/libjpeg.a"
    "${TDLIB_PREFIX}/lib/libssl.a"
    "${TDLIB_PREFIX}/lib/libcrypto.a"
    "${TDLIB_PREFIX}/lib/libz.a"
    pthread dl m)

add_executable(telegram-helper helper.cpp)
target_link_libraries(telegram-helper PRIVATE jibo_media "${TDLIB_LIBRARY}")
set_target_properties(telegram-helper PROPERTIES BUILD_WITH_INSTALL_RPATH TRUE INSTALL_RPATH "$ORIGIN")

add_executable(video-frame-test ../tests/video-frame-test.cpp)
target_include_directories(video-frame-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(video-frame-test PRIVATE jibo_media)

add_executable(account-test ../tests/account-test.cpp "${tg}/third-party/json11.cpp")
target_compile_features(account-test PRIVATE cxx_std_20)
target_include_directories(account-test PRIVATE "${tg}" "${CMAKE_CURRENT_SOURCE_DIR}")
