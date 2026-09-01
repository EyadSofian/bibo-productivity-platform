// capture_bench — measures Windows screen-capture backends on real hardware.
//
// ADR 0003 may not pick a backend from literature. This produces the numbers:
// per-frame acquisition latency (p50/p95/max), achieved FPS against a 15 FPS
// target, dropped/timeout frames, and process CPU time.
//
// Backends
//   dxgi : IDXGIOutputDuplication::AcquireNextFrame (Desktop Duplication)
//   wgc  : Windows.Graphics.Capture + Direct3D11CaptureFramePool (free-threaded)
//
// Both hand back a D3D11 texture in DXGI_FORMAT_B8G8R8A8_UNORM, which maps
// directly onto livekit::VideoBufferType::BGRA — so the cost measured here is
// acquisition only, with no colour conversion in the path.
//
// Build (from an MSVC environment):
//   cl /std:c++20 /EHsc /O2 capture_bench.cpp \
//      d3d11.lib dxgi.lib windowsapp.lib /Fe:capture_bench.exe
//
// Usage: capture_bench [dxgi|wgc|both] [frames] [target_fps]

#include <windows.h>

#include <d3d11.h>
#include <dxgi1_2.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowsapp.lib")

using Clock = std::chrono::steady_clock;
using Micros = std::chrono::microseconds;

namespace {

struct Stats {
  std::vector<double> samples_ms;
  int timeouts = 0;
  int captured = 0;
  double wall_ms = 0.0;
  int width = 0;
  int height = 0;
  std::string note;
};

double Percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0.0;
  std::sort(v.begin(), v.end());
  const size_t idx = static_cast<size_t>(p * (v.size() - 1));
  return v[idx];
}

void Report(const char* name, const Stats& s, int target_fps) {
  std::printf("\n=== %s ===\n", name);
  if (s.captured == 0) {
    std::printf("  FAILED: %s\n", s.note.empty() ? "no frames captured" : s.note.c_str());
    return;
  }
  const double fps = s.captured / (s.wall_ms / 1000.0);
  std::printf("  resolution      : %dx%d\n", s.width, s.height);
  std::printf("  frames captured : %d\n", s.captured);
  std::printf("  timeouts        : %d\n", s.timeouts);
  std::printf("  wall clock      : %.1f ms\n", s.wall_ms);
  std::printf("  achieved FPS    : %.2f  (target %d)\n", fps, target_fps);
  std::printf("  acquire p50     : %.3f ms\n", Percentile(s.samples_ms, 0.50));
  std::printf("  acquire p95     : %.3f ms\n", Percentile(s.samples_ms, 0.95));
  std::printf("  acquire max     : %.3f ms\n", Percentile(s.samples_ms, 1.00));
  if (!s.note.empty()) std::printf("  note            : %s\n", s.note.c_str());
}

void ReportCpu(const char* label) {
  FILETIME create{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(GetCurrentProcess(), &create, &exit, &kernel, &user)) return;
  auto to_ms = [](FILETIME ft) {
    ULARGE_INTEGER u{};
    u.LowPart = ft.dwLowDateTime;
    u.HighPart = ft.dwHighDateTime;
    return static_cast<double>(u.QuadPart) / 10000.0;  // 100ns -> ms
  };
  std::printf("\n[%s] process CPU: kernel %.1f ms + user %.1f ms\n", label, to_ms(kernel), to_ms(user));
}

bool CreateDevice(ID3D11Device** device, ID3D11DeviceContext** context) {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  const HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                       D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
                                       D3D11_SDK_VERSION, device, nullptr, context);
  return SUCCEEDED(hr);
}

// ---------------------------------------------------------------- DXGI ------

Stats RunDxgi(int frames, int target_fps) {
  Stats s;
  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  if (!CreateDevice(&device, &context)) {
    s.note = "D3D11CreateDevice failed";
    return s;
  }

  IDXGIDevice* dxgi_device = nullptr;
  IDXGIAdapter* adapter = nullptr;
  IDXGIOutput* output = nullptr;
  IDXGIOutput1* output1 = nullptr;
  IDXGIOutputDuplication* dupl = nullptr;

  auto cleanup = [&] {
    if (dupl) dupl->Release();
    if (output1) output1->Release();
    if (output) output->Release();
    if (adapter) adapter->Release();
    if (dxgi_device) dxgi_device->Release();
    if (context) context->Release();
    if (device) device->Release();
  };

  if (FAILED(device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi_device))) ||
      FAILED(dxgi_device->GetAdapter(&adapter)) || FAILED(adapter->EnumOutputs(0, &output)) ||
      FAILED(output->QueryInterface(__uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1)))) {
    s.note = "failed to reach IDXGIOutput1";
    cleanup();
    return s;
  }
  if (FAILED(output1->DuplicateOutput(device, &dupl))) {
    s.note = "DuplicateOutput failed (needs a non-elevated session on the active desktop)";
    cleanup();
    return s;
  }

  DXGI_OUTDUPL_DESC desc{};
  dupl->GetDesc(&desc);
  s.width = static_cast<int>(desc.ModeDesc.Width);
  s.height = static_cast<int>(desc.ModeDesc.Height);

  const auto frame_budget = Micros(1'000'000 / target_fps);
  const auto started = Clock::now();
  auto next_tick = started;

  for (int i = 0; i < frames; ++i) {
    next_tick += frame_budget;

    DXGI_OUTDUPL_FRAME_INFO info{};
    IDXGIResource* resource = nullptr;

    const auto t0 = Clock::now();
    // Desktop Duplication only signals on change; 1000ms covers a static screen.
    const HRESULT hr = dupl->AcquireNextFrame(1000, &info, &resource);
    const auto t1 = Clock::now();

    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      s.timeouts++;
    } else if (SUCCEEDED(hr)) {
      s.samples_ms.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
      s.captured++;
      if (resource) resource->Release();
      dupl->ReleaseFrame();
    } else {
      s.note = "AcquireNextFrame failed mid-run (hr=0x" + std::to_string(static_cast<unsigned>(hr)) + ")";
      break;
    }

    if (Clock::now() < next_tick) std::this_thread::sleep_until(next_tick);
  }

  s.wall_ms = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
  if (s.timeouts > 0 && s.note.empty()) {
    s.note = "timeouts are idle-screen frames: Desktop Duplication delivers only on change";
  }
  cleanup();
  return s;
}

// ----------------------------------------------------------------- WGC ------

Stats RunWgc(int frames, int target_fps) {
  Stats s;
  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  if (!CreateDevice(&device, &context)) {
    s.note = "D3D11CreateDevice failed";
    return s;
  }

  if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported()) {
    s.note = "GraphicsCaptureSession::IsSupported() == false";
    if (context) context->Release();
    if (device) device->Release();
    return s;
  }

  IDXGIDevice* dxgi_device = nullptr;
  device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi_device));

  winrt::com_ptr<::IInspectable> inspectable;
  CreateDirect3D11DeviceFromDXGIDevice(dxgi_device, inspectable.put());
  auto d3d_device =
      inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();

  // Capture the primary monitor.
  auto interop = winrt::get_activation_factory<winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
                                               ::IGraphicsCaptureItemInterop>();
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
  const HMONITOR monitor = MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
  const HRESULT hr = interop->CreateForMonitor(
      monitor, winrt::guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
      winrt::put_abi(item));
  if (FAILED(hr) || !item) {
    s.note = "IGraphicsCaptureItemInterop::CreateForMonitor failed";
    if (dxgi_device) dxgi_device->Release();
    if (context) context->Release();
    if (device) device->Release();
    return s;
  }

  const auto size = item.Size();
  s.width = size.Width;
  s.height = size.Height;

  auto pool = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      d3d_device, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2,
      size);
  auto session = pool.CreateCaptureSession(item);
  session.StartCapture();

  const auto frame_budget = Micros(1'000'000 / target_fps);
  const auto started = Clock::now();
  auto next_tick = started;

  for (int i = 0; i < frames; ++i) {
    next_tick += frame_budget;

    const auto t0 = Clock::now();
    auto frame = pool.TryGetNextFrame();
    const auto t1 = Clock::now();

    if (frame) {
      s.samples_ms.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
      s.captured++;
      frame.Close();
    } else {
      s.timeouts++;
    }

    if (Clock::now() < next_tick) std::this_thread::sleep_until(next_tick);
  }

  s.wall_ms = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
  if (s.timeouts > 0 && s.note.empty()) {
    s.note = "TryGetNextFrame is non-blocking; empty polls mean the pool had no new frame yet";
  }

  session.Close();
  pool.Close();
  if (dxgi_device) dxgi_device->Release();
  if (context) context->Release();
  if (device) device->Release();
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  const std::string which = argc > 1 ? argv[1] : "both";
  const int frames = argc > 2 ? std::atoi(argv[2]) : 150;
  const int target_fps = argc > 3 ? std::atoi(argv[3]) : 15;

  winrt::init_apartment(winrt::apartment_type::multi_threaded);

  std::printf("capture_bench: backend=%s frames=%d target_fps=%d\n", which.c_str(), frames,
              target_fps);

  if (which == "dxgi" || which == "both") {
    const auto s = RunDxgi(frames, target_fps);
    Report("DXGI Desktop Duplication", s, target_fps);
    ReportCpu("dxgi");
  }
  if (which == "wgc" || which == "both") {
    const auto s = RunWgc(frames, target_fps);
    Report("Windows Graphics Capture", s, target_fps);
    ReportCpu("wgc");
  }
  return 0;
}
