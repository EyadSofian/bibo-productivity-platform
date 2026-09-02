# media-publisher — the Windows media sidecar.
#
# Two targets, split along the LiveKit dependency:
#
#   media_publisher_core   metrics + json + capture + IPC. Depends on the
#                          Windows SDK only, so its tests build and run on a
#                          machine that has never fetched the LiveKit SDK.
#   media_publisher        the sidecar executable. Adds the LiveKit publisher
#                          and main(), and needs the SDK.
#
# The LiveKit C++ SDK is consumed as the upstream prebuilt binary release, not
# built from source: it ships a CMake package with an imported target, so there
# is no vcpkg step and no libwebrtc compile. Fetch it with
#   tools/fetch-livekit-sdk.ps1
# which pins the archive by SHA256.

cmake_minimum_required(VERSION 3.21)
project(media_publisher LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "media-publisher targets Windows only (Windows Graphics Capture).")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

# The LiveKit release links the dynamic CRT; mismatching it produces a binary
# that links and then crashes crossing the DLL boundary.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")

option(MEDIA_PUBLISHER_BUILD_TESTS "Build the media-publisher unit tests" ON)
option(MEDIA_PUBLISHER_BUILD_BENCH "Build the capture backend benchmark" OFF)

# --- Version of the LiveKit SDK this tree is written against -----------------
# Bumping this means re-reading the headers: the publisher is written against
# exact signatures, not against the README example.
set(LIVEKIT_SDK_VERSION "1.10.0" CACHE STRING "Pinned LiveKit C++ SDK release")
set(LIVEKIT_SDK_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/livekit-sdk-windows-x64-${LIVEKIT_SDK_VERSION}"
    CACHE PATH "Root of the extracted LiveKit C++ SDK binary release")

# -----------------------------------------------------------------------------
# core: everything that does not touch the LiveKit SDK
# -----------------------------------------------------------------------------
add_library(media_publisher_core STATIC
  src/metrics.cpp
  src/json.cpp
  src/capture_session.cpp
  src/agent_ipc.cpp
)

target_include_directories(media_publisher_core PUBLIC src)

target_compile_definitions(media_publisher_core PUBLIC
  UNICODE
  _UNICODE
  NOMINMAX                 # or windows.h's min/max macros break std::min
  WIN32_LEAN_AND_MEAN
)

target_link_libraries(media_publisher_core PUBLIC
  d3d11
  dxgi
  d3dcompiler
  windowsapp               # the C++/WinRT activation surface
  psapi
  user32
)

if(MSVC)
  target_compile_options(media_publisher_core PRIVATE /W4 /permissive- /EHsc /utf-8)
endif()

# -----------------------------------------------------------------------------
# the sidecar executable
# -----------------------------------------------------------------------------
if(EXISTS "${LIVEKIT_SDK_DIR}/lib/cmake/LiveKit/LiveKitConfig.cmake")
  find_package(LiveKit REQUIRED CONFIG PATHS "${LIVEKIT_SDK_DIR}/lib/cmake/LiveKit" NO_DEFAULT_PATH)

  add_executable(media_publisher
    src/main.cpp
    src/livekit_publisher.cpp
  )
  target_link_libraries(media_publisher PRIVATE media_publisher_core LiveKit::livekit)
  if(MSVC)
    target_compile_options(media_publisher PRIVATE /W4 /permissive- /EHsc /utf-8)
  endif()

  # The SDK is a pair of DLLs; put them beside the executable so it runs from
  # the build tree without a PATH edit.
  add_custom_command(TARGET media_publisher POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${LIVEKIT_SDK_DIR}/bin/livekit.dll" "$<TARGET_FILE_DIR:media_publisher>"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${LIVEKIT_SDK_DIR}/bin/livekit_ffi.dll" "$<TARGET_FILE_DIR:media_publisher>"
    COMMENT "Copying the LiveKit runtime next to media_publisher"
  )
else()
  # Deliberately not a hard error: the core library and its tests are useful on
  # their own, and the message says exactly how to get the rest.
  message(WARNING
    "LiveKit SDK ${LIVEKIT_SDK_VERSION} not found under ${LIVEKIT_SDK_DIR}.\n"
    "  Only media_publisher_core and its tests will be built.\n"
    "  Fetch the SDK with: pwsh -File tools/fetch-livekit-sdk.ps1")
endif()

# -----------------------------------------------------------------------------
# tests
# -----------------------------------------------------------------------------
if(MEDIA_PUBLISHER_BUILD_TESTS)
  enable_testing()

  add_executable(metrics_test tests/metrics_test.cpp)
  target_link_libraries(metrics_test PRIVATE media_publisher_core)
  add_test(NAME metrics COMMAND metrics_test)

  add_executable(json_test tests/json_test.cpp)
  target_link_libraries(json_test PRIVATE media_publisher_core)
  add_test(NAME json COMMAND json_test)

  add_executable(ipc_test tests/ipc_test.cpp)
  target_link_libraries(ipc_test PRIVATE media_publisher_core)
  add_test(NAME ipc COMMAND ipc_test)

  if(MSVC)
    foreach(test_target metrics_test json_test ipc_test)
      target_compile_options(${test_target} PRIVATE /W4 /permissive- /EHsc /utf-8)
    endforeach()
  endif()
endif()

if(MEDIA_PUBLISHER_BUILD_BENCH)
  add_executable(capture_bench bench/capture_bench.cpp)
  target_link_libraries(capture_bench PRIVATE d3d11 dxgi windowsapp user32 gdi32)
  if(MSVC)
    target_compile_options(capture_bench PRIVATE /EHsc /utf-8)
  endif()
endif()
