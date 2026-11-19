佳剪离线人声分离

vocals.onnx 是 Open-Unmix UMX-HQ 的双声道人声模型，44.1 kHz。
上游实现与权重来源 https://github.com/sigsep/open-unmix-pytorch
ONNX 发布页 https://huggingface.co/edgetools/umx-hq
模型 SHA-256 3d05709ff7197bbd4a33aee759e4e82002acb491f41c94770227ab57507b6ccb
许可见 OPEN-UNMIX-LICENSE.txt。推理依赖同一安装目录 vendor/foreground 下的 ONNX Runtime。
vocals.exe 源码位于 src/native/vocals.cpp，使用 MSVC x64、/O2 /MT /EHsc /std:c++17、ONNX Runtime 1.20.1 C 头文件构建。
