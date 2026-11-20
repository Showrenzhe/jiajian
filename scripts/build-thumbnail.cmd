@echo off
setlocal
set "locator=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%I in (`"%locator%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "vsroot=%%I"
if not defined vsroot exit /b 1
call "%vsroot%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
pushd "%~dp0.."
if not exist "tools\project-thumbnail" mkdir "tools\project-thumbnail"
cl /nologo /O2 /MT /EHsc /std:c++17 /LD "src\native\project-thumbnail.cpp" /Fo"tools\project-thumbnail\provider.obj" /link /EXPORT:DllGetClassObject,PRIVATE /EXPORT:DllCanUnloadNow,PRIVATE /IMPLIB:"tools\project-thumbnail\provider.lib" /OUT:"tools\project-thumbnail\ProjectThumbnail.dll" ole32.lib windowscodecs.lib crypt32.lib gdi32.lib uuid.lib
if errorlevel 1 exit /b 1
if /i "%~1"=="test" cl /nologo /O2 /MT /EHsc /std:c++17 "test\thumbnail-provider.cpp" /Fo"tools\project-thumbnail\test.obj" /link /OUT:"tools\project-thumbnail\verify.exe" ole32.lib shlwapi.lib gdi32.lib uuid.lib
exit /b %errorlevel%
