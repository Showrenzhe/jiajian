// Isolated Windows Explorer thumbnail provider for .sdworkbench project streams.
#define NOMINMAX
#include <windows.h>
#include <thumbcache.h>
#include <propsys.h>
#include <wincodec.h>
#include <wincrypt.h>
#include <wrl.h>
#include <algorithm>
#include <atomic>
#include <new>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

// {1D514B20-D8CF-47F5-A5A1-EB81A6848B97}
constexpr CLSID providerId = {0x1d514b20,0xd8cf,0x47f5,{0xa5,0xa1,0xeb,0x81,0xa6,0x84,0x8b,0x97}};
static std::atomic<long> objects{0}, locks{0};
constexpr DWORD maxJpeg = 256 * 1024;

static bool consume(const std::string& json, size_t& pos, const char* token) {
    pos = json.find_first_not_of(" \t\r\n", pos);
    if (pos == std::string::npos || json.compare(pos, strlen(token), token) != 0) return false;
    pos += strlen(token);
    return true;
}

static HRESULT readJpeg(IStream* stream, std::vector<BYTE>& bytes) {
    // The writer puts the cover first. Never load the rest of the project or
    // follow a path supplied by a document opened in Explorer.
    std::string json;
    size_t start = 0;
    char buffer[4096];
    while (json.size() < (maxJpeg + 2) / 3 * 4 + sizeof(buffer)) {
        ULONG length = 0;
        HRESULT hr = stream->Read(buffer, sizeof(buffer), &length);
        if (FAILED(hr)) return hr;
        if (!length) break;
        const size_t previous = json.size();
        json.append(buffer, length);
        if (!start) {
            size_t pos = 0;
            if (!consume(json, pos, "{") || !consume(json, pos, "\"thumbnail\"") ||
                !consume(json, pos, ":") || !consume(json, pos, "\"data:image/jpeg;base64,")) {
                if (json.size() < 128 && hr == S_OK) continue;
                return WINCODEC_ERR_BADIMAGE;
            }
            start = pos;
        }
        size_t end = json.find('"', std::max(previous, start));
        if (end == std::string::npos) continue;
        if (end <= start || end - start > (maxJpeg + 2) / 3 * 4) return WINCODEC_ERR_BADIMAGE;
        DWORD count = static_cast<DWORD>(end - start), written = maxJpeg;
        bytes.resize(maxJpeg);
        if (!CryptStringToBinaryA(json.data()+start, count, CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT,
            bytes.data(), &written, nullptr, nullptr) || written < 4) return WINCODEC_ERR_BADIMAGE;
        if (bytes[0] != 0xff || bytes[1] != 0xd8) return WINCODEC_ERR_BADIMAGE;
        bytes.resize(written);
        return S_OK;
    }
    return WINCODEC_ERR_BADIMAGE;
}

static HRESULT makeThumbnail(IStream* stream, UINT edge, HBITMAP* result) {
    std::vector<BYTE> jpeg;
    HRESULT hr = readJpeg(stream, jpeg);
    if (FAILED(hr)) return hr;
    ComPtr<IWICImagingFactory> factory;
    ComPtr<IWICStream> source;
    ComPtr<IWICBitmapDecoder> decoder;
    ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory))) ||
        FAILED(hr = factory->CreateStream(&source)) ||
        FAILED(hr = source->InitializeFromMemory(jpeg.data(), static_cast<DWORD>(jpeg.size()))) ||
        FAILED(hr = factory->CreateDecoder(GUID_ContainerFormatJpeg, nullptr, &decoder)) ||
        FAILED(hr = decoder->Initialize(source.Get(), WICDecodeMetadataCacheOnDemand)) ||
        FAILED(hr = decoder->GetFrame(0, &frame))) return hr;
    UINT width, height;
    if (FAILED(hr = frame->GetSize(&width, &height))) return hr;
    if (!width || !height || std::max(width,height) > 512) return WINCODEC_ERR_BADIMAGE;
    const UINT longest = std::max(width,height);
    const UINT size = std::min(longest, edge);
    width = std::max(1u, width * size / longest);
    height = std::max(1u, height * size / longest);
    ComPtr<IWICBitmapScaler> scaler;
    ComPtr<IWICFormatConverter> pixels;
    if (FAILED(hr = factory->CreateBitmapScaler(&scaler)) ||
        FAILED(hr = scaler->Initialize(frame.Get(), width, height, WICBitmapInterpolationModeFant)) ||
        FAILED(hr = factory->CreateFormatConverter(&pixels)) ||
        FAILED(hr = pixels->Initialize(scaler.Get(), GUID_WICPixelFormat32bppBGR, WICBitmapDitherTypeNone,
            nullptr, 0, WICBitmapPaletteTypeCustom))) return hr;
    BITMAPINFO info{};
    info.bmiHeader = {sizeof(BITMAPINFOHEADER), static_cast<LONG>(width), -static_cast<LONG>(height), 1, 32, BI_RGB};
    void* data = nullptr;
    HBITMAP bitmap = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &data, nullptr, 0);
    if (!bitmap) return E_OUTOFMEMORY;
    hr = pixels->CopyPixels(nullptr, width * 4, width * height * 4, static_cast<BYTE*>(data));
    if (FAILED(hr)) DeleteObject(bitmap);
    else *result = bitmap;
    return hr;
}

class Provider final : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IInitializeWithStream, IThumbnailProvider> {
    ComPtr<IStream> stream;
public:
    Provider() { ++objects; }
    ~Provider() { --objects; }
    IFACEMETHODIMP Initialize(IStream* input, DWORD) override {
        if (!input) return E_INVALIDARG;
        if (stream) return HRESULT_FROM_WIN32(ERROR_ALREADY_INITIALIZED);
        stream = input;
        return S_OK;
    }
    IFACEMETHODIMP GetThumbnail(UINT size, HBITMAP* bitmap, WTS_ALPHATYPE* alpha) override {
        if (!bitmap || !alpha) return E_POINTER;
        *bitmap = nullptr;
        *alpha = WTSAT_UNKNOWN;
        if (!stream || !size) return E_INVALIDARG;
        HRESULT hr = stream->Seek({}, STREAM_SEEK_SET, nullptr);
        if (FAILED(hr)) return hr;
        try { hr = makeThumbnail(stream.Get(), size, bitmap); }
        catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
        if (SUCCEEDED(hr)) *alpha = WTSAT_RGB;
        return hr;
    }
};

class Factory final : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IClassFactory> {
public:
    Factory() { ++objects; }
    ~Factory() { --objects; }
    IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        auto provider = Make<Provider>();
        return provider ? provider->QueryInterface(iid, out) : E_OUTOFMEMORY;
    }
    IFACEMETHODIMP LockServer(BOOL lock) override { locks += lock ? 1 : -1; return S_OK; }
};

STDAPI DllCanUnloadNow() {
    return objects == 0 && locks == 0 ? S_OK : S_FALSE;
}
STDAPI DllGetClassObject(REFCLSID clsid, REFIID iid, void** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (clsid != providerId) return CLASS_E_CLASSNOTAVAILABLE;
    auto factory = Make<Factory>();
    return factory ? factory->QueryInterface(iid, out) : E_OUTOFMEMORY;
}
