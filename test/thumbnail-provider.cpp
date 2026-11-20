#include <windows.h>
#include <thumbcache.h>
#include <propsys.h>
#include <shlwapi.h>
#include <wrl/client.h>
#include <cstdio>

using Microsoft::WRL::ComPtr;
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    HMODULE dll = LoadLibraryW(L"tools\\project-thumbnail\\ProjectThumbnail.dll");
    if (!dll) return 2;
    auto get = reinterpret_cast<LPFNGETCLASSOBJECT>(GetProcAddress(dll,"DllGetClassObject"));
    CLSID id;
    CLSIDFromString(L"{1D514B20-D8CF-47F5-A5A1-EB81A6848B97}", &id);
    ComPtr<IClassFactory> factory;
    if (!get || FAILED(get(id, IID_PPV_ARGS(&factory)))) return 3;
    ComPtr<IStream> file;
    if (FAILED(SHCreateStreamOnFileEx(argv[1], STGM_READ | STGM_SHARE_DENY_NONE, 0, FALSE, nullptr, &file))) return 4;
    ComPtr<IInitializeWithStream> init;
    ComPtr<IThumbnailProvider> provider;
    HBITMAP handle = nullptr;
    WTS_ALPHATYPE alpha;
    if (FAILED(factory->CreateInstance(nullptr, IID_PPV_ARGS(&init))) || FAILED(init->Initialize(file.Get(), STGM_READ)) ||
        FAILED(init.As(&provider)) || FAILED(provider->GetThumbnail(32, &handle, &alpha))) return 5;
    BITMAP bitmap{};
    if (!GetObjectW(handle,sizeof(bitmap),&bitmap) || !bitmap.bmBits) return 6;
    auto rgb = static_cast<BYTE*>(bitmap.bmBits);
    bool correct = bitmap.bmWidth == 32 && bitmap.bmHeight == 16 && rgb[2] > 180 && rgb[1] < 90 && alpha == WTSAT_RGB;
    DeleteObject(handle);
    if (!correct) return 7;
    puts("Explorer provider decoded the project stream into a 32 x 16 red bitmap.");
    return 0;
}
