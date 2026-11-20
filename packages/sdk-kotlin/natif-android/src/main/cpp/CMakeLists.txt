cmake_minimum_required(VERSION 3.22.1)
project(natif LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# llama.cpp, pinned. Bump the tag and the hash together.
# To build offline or against a local checkout: -DFETCHCONTENT_SOURCE_DIR_LLAMA=/path/to/llama.cpp
set(NATIF_LLAMA_TAG "b12500")
FetchContent_Declare(
    llama
    URL https://github.com/ggml-org/llama.cpp/archive/refs/tags/${NATIF_LLAMA_TAG}.tar.gz
    URL_HASH SHA256=0d8e687f293fb0d8cc9fefdd2ffd3d121aa27e9578a719edb577a970c3a49303
)

# Only the core library: no tools, server, tests, common, network.
set(LLAMA_BUILD_COMMON   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_APP      OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENSSL        OFF CACHE BOOL "" FORCE)
set(LLAMA_ALL_WARNINGS   OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS    OFF CACHE BOOL "" FORCE)   # link llama/ggml statically into libnatif.so
set(GGML_NATIVE          OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP          OFF CACHE BOOL "" FORCE)   # ggml's own thread pool
set(GGML_LLAMAFILE       ON  CACHE BOOL "" FORCE)
# CPU backend only for now. GPU (Vulkan / OpenCL-Adreno) is a TODO: it needs per-device testing.
set(GGML_VULKAN          OFF CACHE BOOL "" FORCE)
set(GGML_OPENCL          OFF CACHE BOOL "" FORCE)

if(ANDROID_ABI STREQUAL "arm64-v8a")
    # ARMv8.2 dot product + fp16: every arm64 SoC since ~2018 (Cortex-A55/A75). Older A53-only
    # phones don't have enough RAM to pass model selection anyway.
    set(GGML_CPU_ARM_ARCH "armv8.2-a+dotprod+fp16" CACHE STRING "" FORCE)
endif()

FetchContent_MakeAvailable(llama)

add_library(natif SHARED natif_jni.cpp)
target_link_libraries(natif PRIVATE llama ggml android log)
target_compile_options(natif PRIVATE -O3 -fvisibility=hidden)
# 16 KB page size support (required for Play Store targets on Android 15+).
target_link_options(natif PRIVATE "-Wl,-z,max-page-size=16384")
