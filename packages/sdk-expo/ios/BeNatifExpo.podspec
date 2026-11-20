require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BeNatifExpo'
  s.version        = package['version']
  s.summary        = 'On-device image generation for @be-natif/expo (stable-diffusion.cpp on Metal).'
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'Natif'
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/adanzweig/natif.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = "*.{swift,h}"
  s.public_header_files = "natif_sd.h"
  s.vendored_frameworks = 'NatifSD.xcframework'
  s.frameworks = 'Metal', 'MetalKit', 'Foundation', 'Accelerate'
  s.libraries = 'c++'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
