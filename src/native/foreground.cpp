// Build with MSVC x64: cl /O2 /MT /EHsc /std:c++17 /I<ONNX Runtime include directory> foreground.cpp
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <vector>
#include "onnxruntime_c_api.h"

// Fixed rawvideo protocol: RGB24 320x320 frames in, one Gray8 alpha frame out.
int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  try {
    wchar_t location[32768];
    DWORD size = GetModuleFileNameW(nullptr, location, 32768);
    if (!size || size >= 32768) throw std::runtime_error("Cannot locate inference executable.");
    const auto directory = std::filesystem::path(location).parent_path();
    auto module = LoadLibraryExW((directory / L"onnxruntime.dll").c_str(), nullptr,
      LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) throw std::runtime_error("Cannot load bundled ONNX Runtime.");
    auto getApiBase = reinterpret_cast<decltype(&OrtGetApiBase)>(GetProcAddress(module, "OrtGetApiBase"));
    if (!getApiBase) throw std::runtime_error("Missing ONNX Runtime entry point.");
    const OrtApi* api = getApiBase()->GetApi(ORT_API_VERSION);
    if (!api) throw std::runtime_error("Unsupported ONNX Runtime version.");
    auto check = [api](OrtStatus* status) {
      if (status) {
        std::runtime_error error(api->GetErrorMessage(status));
        api->ReleaseStatus(status);
        throw error;
      }
    };
    OrtEnv* env = nullptr;
    OrtSessionOptions* options = nullptr;
    OrtSession* session = nullptr;
    OrtMemoryInfo* memory = nullptr;
    check(api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "Jiajian", &env));
    check(api->CreateSessionOptions(&options));
    check(api->SetIntraOpNumThreads(options, 3));
    check(api->SetInterOpNumThreads(options, 1));
    check(api->SetSessionGraphOptimizationLevel(options, ORT_ENABLE_ALL));
    check(api->CreateSession(env, argv[1], options, &session));
    check(api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memory));
    OrtAllocator* allocator = nullptr;
    check(api->GetAllocatorWithDefaultOptions(&allocator));
    char* input = nullptr;
    char* output = nullptr;
    check(api->SessionGetInputName(session, 0, allocator, &input));
    check(api->SessionGetOutputName(session, 0, allocator, &output));
    constexpr int pixels = 320 * 320;
    std::vector<unsigned char> rgb(pixels * 3), alpha(pixels);
    std::vector<float> normalized(pixels * 3);
    const float means[3] = {.485f, .456f, .406f}, deviations[3] = {.229f, .224f, .225f};
    const int64_t dimensions[4] = {1, 3, 320, 320};
    OrtValue* tensor = nullptr;
    check(api->CreateTensorWithDataAsOrtValue(memory, normalized.data(), normalized.size() * sizeof(float),
      dimensions, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &tensor));
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    for (;;) {
      const size_t read = std::fread(rgb.data(), 1, rgb.size(), stdin);
      if (!read && std::feof(stdin)) break;
      if (read != rgb.size()) throw std::runtime_error("Incomplete input frame.");
      const auto peak = std::max<unsigned char>(1, *std::max_element(rgb.begin(), rgb.end()));
      for (int c = 0; c < 3; ++c) for (int i = 0; i < pixels; ++i)
        normalized[c * pixels + i] = (static_cast<float>(rgb[3 * i + c]) / peak - means[c]) / deviations[c];
      const char* inputNames[] = {input};
      const char* outputNames[] = {output};
      const OrtValue* inputs[] = {tensor};
      OrtValue* prediction = nullptr;
      check(api->Run(session, nullptr, inputNames, inputs, 1, outputNames, 1, &prediction));
      float* mask = nullptr;
      check(api->GetTensorMutableData(prediction, reinterpret_cast<void**>(&mask)));
      const auto bounds = std::minmax_element(mask, mask + pixels);
      const float low = *bounds.first, range = *bounds.second - low;
      for (int i = 0; i < pixels; ++i) alpha[i] = range > 1.e-6f
        ? static_cast<unsigned char>(std::lround(std::clamp((mask[i] - low) / range, 0.f, 1.f) * 255)) : 0;
      api->ReleaseValue(prediction);
      if (std::fwrite(alpha.data(), 1, alpha.size(), stdout) != alpha.size() || std::fflush(stdout))
        throw std::runtime_error("Cannot write alpha frame.");
    }
    api->ReleaseValue(tensor);
    allocator->Free(allocator, input);
    allocator->Free(allocator, output);
    api->ReleaseMemoryInfo(memory);
    api->ReleaseSession(session);
    api->ReleaseSessionOptions(options);
    api->ReleaseEnv(env);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
