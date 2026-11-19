佳剪 · 离线前景抠像（Windows x64）

foreground.exe 从标准输入逐帧读取 320×320 RGB24，输出同尺寸灰度透明度蒙版。
模型针对显著人物和物体。运行时不联网，不需要 Python。

U²-NetP 模型来自 U²-Net（Apache License 2.0）
https://github.com/xuebinqin/U-2-Net
ONNX 权重使用 rembg 发布的转换版本
https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx
u2netp.onnx SHA-256 309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8

ONNX Runtime CPU 1.20.1（MIT），取自官方 NuGet 包 Microsoft.ML.OnnxRuntime
https://www.nuget.org/packages/Microsoft.ML.OnnxRuntime/1.20.1
runtime.nupkg SHA-256 9c32108e9a1c78b090a95c2a219f244dd5f067d4caf68fb0f967103f3f20839c
随本目录附上模型、运行库许可证及第三方声明。

ONNX Runtime 依赖的 MSVCP140、MSVCP140_1、VCRUNTIME140、VCRUNTIME140_1 DLL
取自 Visual Studio 2022 Community 的 x64 Microsoft.VC143.CRT 可再发行目录。
Microsoft 可再发行文件说明与分发清单
https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution
https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files

重编推理程序时，在 Visual Studio x64 开发者命令提示符下执行
cl /O2 /MT /EHsc /std:c++17 /I<NuGet解压目录>\build\native\include src\native\foreground.cpp /Fe:vendor\foreground\foreground.exe
