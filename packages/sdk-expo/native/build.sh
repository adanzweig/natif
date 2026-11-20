#!/usr/bin/env bash
# Rebuilds the native image libraries vendored in this package (not stored in git):
#   ios/NatifSD.xcframework            (iOS device + Apple Silicon simulator, Metal)
#   android/src/main/jniLibs/arm64-v8a/libnatif_sd.so   (CPU)
# Needs: Xcode, cmake, Android NDK 27+. Usage: native/build.sh [work-dir]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(dirname "$HERE")"
WORK="${1:-$HOME/.cache/natif-sd}"; SD_TAG="master-1106-532d2c1"
NDK="${ANDROID_NDK_HOME:-$HOME/Library/Android/sdk/ndk/27.1.12297006}"
mkdir -p "$WORK"; cd "$WORK"
[ -d src ] || git clone --depth 1 --branch "$SD_TAG" --recurse-submodules https://github.com/leejet/stable-diffusion.cpp src
cp src/thirdparty/stb_image_write.h "$HERE/"
COMMON=(-DSD_METAL=ON -DSD_BUILD_EXAMPLES=OFF -DSD_WEBP=OFF -DSD_WEBM=OFF -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF)
ios() { # $1 dir  $2 sdk  $3 min-version flag
  cmake -S src -B "build-$1" -G Xcode -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT="$2" -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=16.4 -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO "${COMMON[@]}"
  cmake --build "build-$1" --config Release -j 10
  xcrun --sdk "$2" clang++ -std=c++17 -O2 -arch arm64 -isysroot "$(xcrun --sdk "$2" --show-sdk-path)" "$3" \
    -I src/include -I "$HERE" -c "$HERE/natif_sd.cpp" -o "build-$1/natif_sd.o"
  libtool -static -o "build-$1/libnatif_sd.a" "build-$1/natif_sd.o" $(find "build-$1" -name "*.a" -path "*Release*")
  strip -S -x "build-$1/libnatif_sd.a"
}
ios ios iphoneos -miphoneos-version-min=16.4
ios sim iphonesimulator -mios-simulator-version-min=16.4
mkdir -p hdr && cp "$HERE/natif_sd.h" hdr/
rm -rf "$PKG/ios/NatifSD.xcframework"
xcodebuild -create-xcframework -library build-ios/libnatif_sd.a -headers hdr -library build-sim/libnatif_sd.a -headers hdr \
  -output "$PKG/ios/NatifSD.xcframework"
cp "$HERE/natif_sd.h" "$PKG/ios/natif_sd.h"

mkdir -p android && cp "$HERE/android.cmake" android/CMakeLists.txt
cmake -S android -B build-android -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-28 -DCMAKE_BUILD_TYPE=Release -DSD_SRC="$PWD/src" -DBRIDGE="$HERE" -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16
cmake --build build-android -j 10
mkdir -p "$PKG/android/src/main/jniLibs/arm64-v8a"
"$NDK"/toolchains/llvm/prebuilt/*/bin/llvm-strip --strip-unneeded -o "$PKG/android/src/main/jniLibs/arm64-v8a/libnatif_sd.so" build-android/libnatif_sd.so
echo "done"
