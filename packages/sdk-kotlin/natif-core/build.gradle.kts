plugins {
    alias(libs.plugins.kotlin.jvm)
    `java-library`
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.coroutines.core)
    api(libs.serialization.json)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}

// The model catalog is generated from TypeScript (packages/sdk-core/contract/catalog.json) and
// shipped as a resource, never hand-copied. Builds outside the monorepo can pass
// -Pbenatif.catalog=/path/to/catalog.json.
val catalogFile = providers.gradleProperty("benatif.catalog")
    .orElse(layout.projectDirectory.file("../../sdk-core/contract/catalog.json").asFile.path)

tasks.processResources {
    from(catalogFile) {
        into("com/benatif")
        rename { "catalog.json" }
    }
}

tasks.test {
    useJUnit()
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
