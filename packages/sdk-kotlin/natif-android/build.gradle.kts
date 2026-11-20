plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "com.benatif"
    compileSdk = 36
    ndkVersion = "27.1.12297006"

    defaultConfig {
        minSdk = 26
        consumerProguardFiles("consumer-rules.pro")
        ndk {
            // 64-bit only: 3–4 GB models can't be mapped in a 32-bit address space.
            // arm64-v8a covers phones; add "x86_64" for emulators (longer native build).
            abiFilters += listOf("arm64-v8a")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DANDROID_STL=c++_shared",
                    "-DCMAKE_BUILD_TYPE=Release",
                    // Keep the llama.cpp build from saturating the machine: at most 4 compile jobs.
                    "-DCMAKE_JOB_POOLS=compile=4",
                    "-DCMAKE_JOB_POOL_COMPILE=compile",
                )
                cppFlags += listOf("-std=c++17")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(project(":natif-core"))
    implementation(libs.coroutines.android)
}
