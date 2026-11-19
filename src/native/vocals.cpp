// MSVC x64 /O2 /MT /EHsc /std:c++17, ONNX Runtime 1.20.1 C headers.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <vector>
#include "onnxruntime_c_api.h"

using Complex = std::complex<float>;
constexpr int bins = 2049, fftSize = 4096, hop = 1024, channels = 2;
constexpr float pi = 3.14159265358979323846f;

void fft(std::vector<Complex>& data, bool inverse) {
  for (int i = 1, j = 0; i < fftSize; ++i) {
    int bit = fftSize >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) std::swap(data[i], data[j]);
  }
  for (int length = 2; length <= fftSize; length <<= 1) {
    const auto root = std::polar(1.f, (inverse ? 2.f : -2.f) * pi / length);
    for (int start = 0; start < fftSize; start += length) {
      Complex phase{1, 0};
      for (int k = 0; k < length / 2; ++k) {
        const auto a = data[start + k], b = data[start + k + length / 2] * phase;
        data[start + k] = a + b;
        data[start + k + length / 2] = a - b;
        phase *= root;
      }
    }
  }
  if (inverse) for (auto& value : data) value /= fftSize;
}

int reflect(int sample, int length) {
  if (length <= 1) return 0;
  const int period = 2 * (length - 1);
  sample = std::abs(sample) % period;
  return sample < length ? sample : period - sample;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 4) return 2;
  try {
    const auto folder = std::filesystem::absolute(argv[0]).parent_path();
    const auto dll = folder.parent_path() / L"foreground" / L"onnxruntime.dll";
    const auto module = LoadLibraryExW(dll.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!module) throw std::runtime_error("Missing bundled ONNX Runtime.");
    const auto getApi = reinterpret_cast<decltype(&OrtGetApiBase)>(GetProcAddress(module, "OrtGetApiBase"));
    const auto* api = getApi ? getApi()->GetApi(ORT_API_VERSION) : nullptr;
    if (!api) throw std::runtime_error("Unsupported ONNX Runtime.");
    auto check = [api](OrtStatus* status) {
      if (status) { std::runtime_error error(api->GetErrorMessage(status)); api->ReleaseStatus(status); throw error; }
    };
    OrtEnv* env = nullptr; OrtSessionOptions* options = nullptr; OrtSession* session = nullptr; OrtMemoryInfo* memory = nullptr;
    check(api->CreateEnv(ORT_LOGGING_LEVEL_ERROR, "JiajianVocals", &env));
    check(api->CreateSessionOptions(&options));
    check(api->SetIntraOpNumThreads(options, 3));
    check(api->SetInterOpNumThreads(options, 1));
    check(api->CreateSession(env, argv[1], options, &session));
    check(api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memory));
    std::ifstream input(argv[2], std::ios::binary | std::ios::ate);
    std::ofstream output(argv[3], std::ios::binary | std::ios::trunc);
    const auto byteCount = static_cast<std::streamoff>(input.tellg());
    if (!input || !output || byteCount < 8 || byteCount % 8) throw std::runtime_error("Invalid 44100 Hz stereo float PCM.");
    const auto samples = byteCount / 8;
    std::array<float, fftSize> window{};
    for (int k = 0; k < fftSize; ++k) window[k] = .5f * (1.f - std::cos(2.f * pi * k / fftSize));
    std::vector<Complex> buffer(fftSize);
    constexpr int block = 192 * hop, context = 32 * hop;
    for (std::streamoff offset = 0; offset < samples; offset += block) {
      const auto first = std::max<std::streamoff>(0, offset - context);
      const int length = static_cast<int>(std::min<std::streamoff>(samples, offset + block + context) - first);
      const int frames = 1 + length / hop;
      std::vector<float> wave(length * channels), separated(length * channels), normalization(length);
      input.seekg(first * 8);
      if (!input.read(reinterpret_cast<char*>(wave.data()), wave.size() * sizeof(float))) throw std::runtime_error("Cannot read audio.");
      std::vector<float> mag(channels * bins * frames);
      std::vector<Complex> spectra(channels * frames * bins);
      for (int c = 0; c < channels; ++c) for (int f = 0; f < frames; ++f) {
        const int start = f * hop - fftSize / 2;
        for (int k = 0; k < fftSize; ++k) buffer[k] = wave[reflect(start + k, length) * channels + c] * window[k];
        fft(buffer, false);
        for (int k = 0; k < bins; ++k) {
          spectra[(c * frames + f) * bins + k] = buffer[k];
          mag[(c * bins + k) * frames + f] = std::abs(buffer[k]);
        }
      }
      const int64_t shape[]{1, channels, bins, frames};
      OrtValue* tensor = nullptr; OrtValue* prediction = nullptr;
      check(api->CreateTensorWithDataAsOrtValue(memory, mag.data(), mag.size() * sizeof(float), shape, 4,
        ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &tensor));
      const char* inputs[]{"mag"}; const char* outputs[]{"estimate"};
      const OrtValue* values[]{tensor};
      check(api->Run(session, nullptr, inputs, values, 1, outputs, 1, &prediction));
      float* estimates = nullptr;
      check(api->GetTensorMutableData(prediction, reinterpret_cast<void**>(&estimates)));
      for (int c = 0; c < channels; ++c) for (int f = 0; f < frames; ++f) {
        const int start = f * hop - fftSize / 2;
        for (int k = 0; k < bins; ++k) {
          const int index = (c * bins + k) * frames + f;
          const float mask = std::clamp(estimates[index] / std::max(mag[index], 1e-8f), 0.f, 1.f);
          buffer[k] = spectra[(c * frames + f) * bins + k] * mask;
          if (k > 0 && k < bins - 1) buffer[fftSize - k] = std::conj(buffer[k]);
        }
        fft(buffer, true);
        for (int k = std::max(0, -start); k < fftSize && start + k < length; ++k) {
          separated[(start + k) * channels + c] += buffer[k].real() * window[k];
          if (!c) normalization[start + k] += window[k] * window[k];
        }
      }
      api->ReleaseValue(prediction); api->ReleaseValue(tensor);
      const auto count = std::min<std::streamoff>(samples - offset, block);
      const int begin = static_cast<int>(offset - first);
      for (int n = begin; n < begin + count; ++n) for (int c = 0; c < channels; ++c)
        separated[n * channels + c] /= std::max(normalization[n], 1e-8f);
      if (!output.write(reinterpret_cast<const char*>(&separated[begin * channels]), count * 8)) throw std::runtime_error("Cannot write separated audio.");
    }
    api->ReleaseMemoryInfo(memory); api->ReleaseSession(session); api->ReleaseSessionOptions(options); api->ReleaseEnv(env);
    return output.flush() ? 0 : 1;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
