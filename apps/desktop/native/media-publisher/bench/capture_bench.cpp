// capture_bench — measures Windows screen-capture backends on real hardware.
//
// ADR 0003 may not pick a backend from literature. This produces the numbers:
// frames actually delivered over a fixed wall-clock window, inter-arrival
// latency (p50/p95/max), and process CPU.
//
// Backends
//   dxgi : IDXGIOutputDuplication::AcquireNextFrame (Desktop Duplication)
//   wgc  : Windows.Graphics.Capture + Direct3D11CaptureFramePool, driven by the
//          FrameArrived event (NOT polled — polling measures the harness)
//
// Both hand back DXGI_FORMAT_B8G8R8A8_UNORM, which maps directly onto
// livekit::VideoBufferType::BGRA, so no colour conversion sits in the path.
//
// Fairness notes, learned the hard way:
//   * Both APIs are CHANGE-DRIVEN. On an idle desktop neither delivers frames,
//     so an idle measurement says nothing. This harness therefore runs its own
//     deterministic activity driver — a window repainting at ~60 Hz — so both
//     backends see identical, non-idle conditions.
//   * Both runs are duration-based, not frame-count-based, so neither backend
//     is credited for a shorter wall clock.
//   * GetProcessTimes is cumulative, so run one backend per process.
//
// Build (from an MSVC environment):
//   cl /std:c++20 /EHsc /O2 capture_bench.cpp
//      d3d11.lib dxgi.lib windowsapp.lib user32.lib gdi32.lib
//      /Fe:capture_bench.exe
//
// Usage: capture_bench [dxgi|wgc] [seconds] [--idle]
//   --idle  disable the activity driver, to show idle-desktop behaviour

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
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowsapp.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

using Clock = std::chrono::steady_clock;

namespace {

struct Stats {
  std::vector<double> interarrival_ms;
  int delivered = 0;
  int empty_waits = 0;
  double wall_ms = 0.0;
  int width = 0;
  int height = 0;
  std::string note;
};

double Percentile(std::vector<double> v, double p) {
  if (v.empty()) return 0.0;
  std::sort(v.begin(), v.end());
  return v[static_cast<size_t>(p * (v.size() - 1))];
}

void Report(const char* name, const Stats& s) {
  std::printf("\n=== %s ===\n", name);
  if (s.delivered == 0) {
    std::printf("  FAILED/NO FRAMES: %s\n", s.note.empty() ? "none delivered" : s.note.c_str());
    return;
  }
  std::printf("  resolution        : %dx%d\n", s.width, s.height);
  std::printf("  wall clock        : %.1f ms\n", s.wall_ms);
  std::printf("  frames delivered  : %d\n", s.delivered);
  std::printf("  effective FPS     : %.2f\n", s.delivered / (s.wall_ms / 1000.0));
  std::printf("  empty waits       : %d\n", s.empty_waits);
  std::printf("  inter-arrival p50 : %.3f ms\n", Percentile(s.interarrival_ms, 0.50));
  std::printf("  inter-arrival p95 : %.3f ms\n", Percentile(s.interarrival_ms, 0.95));
  std::printf("  inter-arrival max : %.3f ms\n", Percentile(s.interarrival_ms, 1.00));
  if (!s.note.empty()) std::printf("  note              : %s\n", s.note.c_str());
}

void ReportCpu(double wall_ms) {
  FILETIME c{}, e{}, k{}, u{};
  if (!GetProcessTimes(GetCurrentProcess(), &c, &e, &k, &u)) return;
  auto ms = [](FILETIME ft) {
    ULARGE_INTEGER x{};
    x.LowPart = ft.dwLowDateTime;
    x.HighPart = ft.dwHighDateTime;
    return static_cast<double>(x.QuadPart) / 10000.0;
  };
  const double total = ms(k) + ms(u);
  std::printf("  process CPU       : %.1f ms (kernel %.1f + user %.1f)\n", total, ms(k), ms(u));
  if (wall_ms > 0) {
    std::printf("  CPU share of core : %.1f percent\n", 100.0 * total / wall_ms);
  }
}

// -------------------------------------------------------- activity driver ---
// Both capture APIs only produce frames when the screen changes, so an idle
// measurement is meaningless. This drives a constant, identical workload.

class ActivityDriver {
 public:
  void Start() {
    thread_ = std::thread([this] { Run(); });
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
  }
  void Stop() {
    running_ = false;
    if (thread_.joinable()) thread_.join();
  }

 private:
  static LRESULT CALLBACK WndProc(HWND h, UINT msg, WPARAM w, LPARAM l) {
    if (msg == WM_PAINT) {
      PAINTSTRUCT ps{};
      HDC dc = BeginPaint(h, &ps);
      static int tick = 0;
      ++tick;
      HBRUSH brush =
          CreateSolidBrush(RGB((tick * 7) & 0xFF, (tick * 13) & 0xFF, (tick * 3) & 0xFF));
      FillRect(dc, &ps.rcPaint, brush);
      DeleteObject(brush);
      EndPaint(h, &ps);
      return 0;
    }
    if (msg == WM_DESTROY) {
      PostQuitMessage(0);
      return 0;
    }
    return DefWindowProcW(h, msg, w, l);
  }

  void Run() {
    WNDCLASSEXW wc{sizeof(wc)};
    wc.lpfnWndProc = WndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"CaptureBenchActivity";
    RegisterClassExW(&wc);

    hwnd_ = CreateWindowExW(WS_EX_TOPMOST, wc.lpszClassName, L"capture_bench activity",
                            WS_POPUP | WS_VISIBLE, 40, 40, 480, 270, nullptr, nullptr,
                            wc.hInstance, nullptr);
    if (!hwnd_) return;

    MSG msg{};
    auto next = Clock::now();
    while (running_) {
      while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
      InvalidateRect(hwnd_, nullptr, FALSE);
      UpdateWindow(hwnd_);
      next += std::chrono::microseconds(16667);  // ~60 Hz
      std::this_thread::sleep_until(next);
    }
    DestroyWindow(hwnd_);
    hwnd_ = nullptr;
  }

  std::thread thread_;
  std::atomic<bool> running_{true};
  HWND hwnd_ = nullptr;
};

bool CreateDevice(ID3D11Device** device, ID3D11DeviceContext** context) {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  return SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                     D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
                                     D3D11_SDK_VERSION, device, nullptr, context));
}

// ---------------------------------------------------------------- DXGI ------

Stats RunDxgi(int seconds) {
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

  if (FAILED(device->QueryInterface(__uuidof(IDXGIDevice),
                                    reinterpret_cast<void**>(&dxgi_device))) ||
      FAILED(dxgi_device->GetAdapter(&adapter)) || FAILED(adapter->EnumOutputs(0, &output)) ||
      FAILED(output->QueryInterface(__uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1)))) {
    s.note = "failed to reach IDXGIOutput1";
    cleanup();
    return s;
  }
  if (FAILED(output1->DuplicateOutput(device, &dupl))) {
    s.note = "DuplicateOutput failed (needs the active interactive desktop)";
    cleanup();
    return s;
  }

  DXGI_OUTDUPL_DESC desc{};
  dupl->GetDesc(&desc);
  s.width = static_cast<int>(desc.ModeDesc.Width);
  s.height = static_cast<int>(desc.ModeDesc.Height);

  const auto started = Clock::now();
  const auto deadline = started + std::chrono::seconds(seconds);
  auto last = started;

  while (Clock::now() < deadline) {
    DXGI_OUTDUPL_FRAME_INFO info{};
    IDXGIResource* resource = nullptr;
    const HRESULT hr = dupl->AcquireNextFrame(100, &info, &resource);

    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      s.empty_waits++;
      continue;
    }
    if (FAILED(hr)) {
      s.note = "AcquireNextFrame failed mid-run";
      if (resource) resource->Release();
      break;
    }

    // LastPresentTime == 0 means only the pointer moved, not a new desktop image.
    if (info.LastPresentTime.QuadPart != 0) {
      const auto now = Clock::now();
      s.interarrival_ms.push_back(std::chrono::duration<double, std::milli>(now - last).count());
      last = now;
      s.delivered++;
    } else {
      s.empty_waits++;
    }
    if (resource) resource->Release();
    dupl->ReleaseFrame();
  }

  s.wall_ms = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
  if (s.note.empty()) {
    s.note = "empty waits = 100ms timeouts plus pointer-only updates (LastPresentTime==0)";
  }
  cleanup();
  return s;
}

// ----------------------------------------------------------------- WGC ------

Stats RunWgc(int seconds) {
  Stats s;
  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  if (!CreateDevice(&device, &context)) {
    s.note = "D3D11CreateDevice failed";
    return s;
  }
  auto release_d3d = [&] {
    if (context) context->Release();
    if (device) device->Release();
  };

  if (!winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported()) {
    s.note = "GraphicsCaptureSession::IsSupported() == false";
    release_d3d();
    return s;
  }

  IDXGIDevice* dxgi_device = nullptr;
  device->QueryInterface(__uuidof(IDXGIDevice), reinterpret_cast<void**>(&dxgi_device));
  winrt::com_ptr<::IInspectable> inspectable;
  CreateDirect3D11DeviceFromDXGIDevice(dxgi_device, inspectable.put());
  auto d3d_device =
      inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();

  auto interop =
      winrt::get_activation_factory<winrt::Windows::Graphics::Capture::GraphicsCaptureItem,
                                    ::IGraphicsCaptureItemInterop>();
  winrt::Windows::Graphics::Capture::GraphicsCaptureItem item{nullptr};
  const HMONITOR monitor = MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
  if (FAILED(interop->CreateForMonitor(
          monitor, winrt::guid_of<winrt::Windows::Graphics::Capture::GraphicsCaptureItem>(),
          winrt::put_abi(item))) ||
      !item) {
    s.note = "IGraphicsCaptureItemInterop::CreateForMonitor failed";
    if (dxgi_device) dxgi_device->Release();
    release_d3d();
    return s;
  }

  const auto size = item.Size();
  s.width = size.Width;
  s.height = size.Height;

  auto pool = winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
      d3d_device, winrt::Windows::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2,
      size);

  std::mutex mu;
  std::atomic<int> delivered{0};
  std::vector<double> intervals;
  auto last = Clock::now();

  // Event-driven: CreateFreeThreaded dispatches this on a threadpool thread, so
  // no message pump is needed and the measurement reflects the API rather than
  // a poll loop.
  const auto token = pool.FrameArrived(
      [&](winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool const& sender,
          winrt::Windows::Foundation::IInspectable const&) {
        auto frame = sender.TryGetNextFrame();
        if (!frame) return;
        const auto now = Clock::now();
        {
          std::lock_guard<std::mutex> lock(mu);
          intervals.push_back(std::chrono::duration<double, std::milli>(now - last).count());
          last = now;
        }
        frame.Close();
        delivered.fetch_add(1, std::memory_order_relaxed);
      });

  auto session = pool.CreateCaptureSession(item);
  // The cursor must be visible in the published stream, and the system capture
  // border is deliberately left ON — it is the tamper-proof monitoring
  // indicator the product requires.
  session.IsCursorCaptureEnabled(true);

  const auto started = Clock::now();
  session.StartCapture();
  std::this_thread::sleep_for(std::chrono::seconds(seconds));
  s.wall_ms = std::chrono::duration<double, std::milli>(Clock::now() - started).count();

  session.Close();
  pool.FrameArrived(token);
  pool.Close();

  {
    std::lock_guard<std::mutex> lock(mu);
    s.interarrival_ms = intervals;
  }
  s.delivered = delivered.load();
  s.note = "event-driven via FrameArrived; capture border left enabled";

  if (dxgi_device) dxgi_device->Release();
  release_d3d();
  return s;
}

}  // namespace

int main(int argc, char** argv) {
  const std::string which = argc > 1 ? argv[1] : "dxgi";
  const int seconds = argc > 2 ? std::atoi(argv[2]) : 10;
  bool idle = false;
  for (int i = 1; i < argc; ++i) {
    if (std::string(argv[i]) == "--idle") idle = true;
  }

  winrt::init_apartment(winrt::apartment_type::multi_threaded);

  std::printf("capture_bench: backend=%s seconds=%d activity_driver=%s\n", which.c_str(), seconds,
              idle ? "OFF (idle desktop)" : "ON (60Hz repaint)");

  ActivityDriver driver;
  if (!idle) driver.Start();

  Stats s;
  const char* label = "";
  if (which == "dxgi") {
    s = RunDxgi(seconds);
    label = "DXGI Desktop Duplication";
  } else if (which == "wgc") {
    s = RunWgc(seconds);
    label = "Windows Graphics Capture (FrameArrived)";
  } else {
    std::printf("unknown backend, use dxgi or wgc\n");
    if (!idle) driver.Stop();
    return 2;
  }

  if (!idle) driver.Stop();

  Report(label, s);
  ReportCpu(s.wall_ms);
  return 0;
}
