#include "capture_session.h"

// clang-format off
#include <windows.h>

#include <d3d11.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
// clang-format on

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

namespace engosoft::media {
namespace {

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgdx = winrt::Windows::Graphics::DirectX;
namespace wgdx11 = winrt::Windows::Graphics::DirectX::Direct3D11;

using DxgiInterfaceAccess = ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
using Clock = std::chrono::steady_clock;

// Scales the captured desktop into the published resolution on the GPU.
//
// This is not a micro-optimisation. Handing the encoder a native-resolution
// frame instead would mean copying 1920x1080 BGRA (8.3 MB) across the FFI
// boundary 15 times a second and letting libwebrtc downscale on the CPU. Doing
// the resize on the GPU cuts the copy to 3.7 MB per frame and moves the
// filtering off the CPU entirely, which is what the agent CPU budget requires.
//
// A fullscreen triangle, so there is no vertex buffer and no input layout. The
// oversized triangle's UVs run 0..2; multiplying by uv_scale maps the visible
// half onto the frame's valid content region, which can be smaller than the
// frame pool's texture after a display resolution change.
constexpr char kShaderSource[] = R"HLSL(
cbuffer Params : register(b0) { float2 uv_scale; float2 pad_; };

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

VSOut VSMain(uint vid : SV_VertexID) {
  VSOut o;
  float2 uv = float2((vid << 1) & 2, vid & 2);
  o.pos = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
  o.uv = uv * uv_scale;
  return o;
}

Texture2D src : register(t0);
SamplerState smp : register(s0);

float4 PSMain(VSOut i) : SV_TARGET {
  // Alpha forced opaque: WGC surfaces can carry a zero alpha channel, and a
  // transparent frame reaching a compositing viewer renders as black.
  return float4(src.Sample(smp, i.uv).rgb, 1.0);
}
)HLSL";

struct alignas(16) ShaderParams {
  float uv_scale_x = 1.0f;
  float uv_scale_y = 1.0f;
  float pad0 = 0.0f;
  float pad1 = 0.0f;
};

BOOL CALLBACK CollectMonitor(HMONITOR monitor, HDC, LPRECT, LPARAM param) {
  reinterpret_cast<std::vector<HMONITOR>*>(param)->push_back(monitor);
  return TRUE;
}

// Monitors in a stable order with the primary first, so display_index 0 always
// means the primary display. EnumDisplayMonitors makes no ordering promise.
std::vector<HMONITOR> EnumerateMonitors() {
  std::vector<HMONITOR> monitors;
  EnumDisplayMonitors(nullptr, nullptr, CollectMonitor, reinterpret_cast<LPARAM>(&monitors));

  std::stable_sort(monitors.begin(), monitors.end(), [](HMONITOR a, HMONITOR b) {
    MONITORINFO ia{};
    MONITORINFO ib{};
    ia.cbSize = sizeof(ia);
    ib.cbSize = sizeof(ib);
    if (!GetMonitorInfoW(a, &ia) || !GetMonitorInfoW(b, &ib)) return false;
    const bool a_primary = (ia.dwFlags & MONITORINFOF_PRIMARY) != 0;
    const bool b_primary = (ib.dwFlags & MONITORINFOF_PRIMARY) != 0;
    if (a_primary != b_primary) return a_primary;
    if (ia.rcMonitor.left != ib.rcMonitor.left) return ia.rcMonitor.left < ib.rcMonitor.left;
    return ia.rcMonitor.top < ib.rcMonitor.top;
  });
  return monitors;
}

}  // namespace

const char* ToString(CaptureStatus status) {
  switch (status) {
    case CaptureStatus::kOk: return "ok";
    case CaptureStatus::kUnsupported: return "unsupported";
    case CaptureStatus::kItemFailed: return "item_failed";
    case CaptureStatus::kDisplayGone: return "display_gone";
    case CaptureStatus::kDeviceLost: return "device_lost";
    case CaptureStatus::kInternalError: return "internal_error";
  }
  return "internal_error";
}

FailureReason ToFailureReason(CaptureStatus status) {
  switch (status) {
    case CaptureStatus::kOk: return FailureReason::kNone;
    case CaptureStatus::kUnsupported: return FailureReason::kCaptureUnsupported;
    case CaptureStatus::kItemFailed: return FailureReason::kCaptureFailed;
    case CaptureStatus::kDisplayGone: return FailureReason::kDisplayGone;
    case CaptureStatus::kDeviceLost: return FailureReason::kCaptureFailed;
    case CaptureStatus::kInternalError: return FailureReason::kInternalError;
  }
  return FailureReason::kInternalError;
}

struct CaptureSession::Impl {
  CaptureConfig config;
  FrameCallback on_frame;
  Metrics* metrics = nullptr;

  // --- D3D11, touched only under gpu_mutex ---------------------------------
  std::mutex gpu_mutex;
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext> context;
  winrt::com_ptr<ID3D11VertexShader> vertex_shader;
  winrt::com_ptr<ID3D11PixelShader> pixel_shader;
  winrt::com_ptr<ID3D11SamplerState> sampler;
  winrt::com_ptr<ID3D11Buffer> params_buffer;

  // Source-sized, shader-readable copy of the capture surface.
  winrt::com_ptr<ID3D11Texture2D> source_copy;
  winrt::com_ptr<ID3D11ShaderResourceView> source_srv;
  UINT source_width = 0;
  UINT source_height = 0;

  // Target-sized render target plus its CPU-readable staging copy.
  winrt::com_ptr<ID3D11Texture2D> scaled;
  winrt::com_ptr<ID3D11RenderTargetView> scaled_rtv;
  winrt::com_ptr<ID3D11Texture2D> staging;

  // --- WGC -----------------------------------------------------------------
  wgdx11::IDirect3DDevice winrt_device{nullptr};
  wgc::GraphicsCaptureItem item{nullptr};
  wgc::Direct3D11CaptureFramePool pool{nullptr};
  wgc::GraphicsCaptureSession session{nullptr};
  winrt::event_token frame_token{};
  winrt::event_token closed_token{};
  winrt::Windows::Graphics::SizeInt32 pool_size{0, 0};

  // --- handoff to the pacing thread ----------------------------------------
  std::mutex frame_mutex;
  std::vector<std::uint8_t> pending;  // tightly packed BGRA at target size
  std::uint64_t pending_seq = 0;

  std::thread pacer;
  HANDLE wake = nullptr;  // set by Stop so the pacer never sleeps out its tick

  std::atomic<bool> running{false};
  std::atomic<int> target_fps{15};
  std::atomic<bool> blackout{false};
  std::atomic<CaptureStatus> status{CaptureStatus::kOk};

  // Source-rate limiter. WGC delivers at the desktop's change rate — measured
  // at ~60 Hz on an active desktop in ADR 0003 — and doing the GPU work plus a
  // readback for every one of those would cost four times what the published
  // rate needs.
  Clock::time_point last_processed{};

  int target_width() const { return config.width; }
  int target_height() const { return config.height; }
  std::size_t frame_bytes() const {
    return static_cast<std::size_t>(config.width) * static_cast<std::size_t>(config.height) * 4u;
  }

  // First failure wins: a device loss that then cascades into an item failure
  // should still report the device loss.
  void Fail(CaptureStatus reason) {
    CaptureStatus expected = CaptureStatus::kOk;
    status.compare_exchange_strong(expected, reason);
  }

  bool EnsureDevice();
  bool EnsurePipeline();
  bool EnsureSourceTextures(UINT width, UINT height);
  bool RenderAndReadback(ID3D11Texture2D* source, UINT source_w, UINT source_h, UINT content_w,
                         UINT content_h);
  void OnFrameArrived(const wgc::Direct3D11CaptureFramePool& sender);
  void PacerLoop();
};

bool CaptureSession::Impl::EnsureDevice() {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
                                      D3D_FEATURE_LEVEL_10_1};
  // BGRA_SUPPORT is required for interop with the WinRT Direct3D device.
  const UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags, levels,
                                 ARRAYSIZE(levels), D3D11_SDK_VERSION, device.put(), nullptr,
                                 context.put());
  if (FAILED(hr)) {
    // WARP keeps capture working where there is no usable GPU driver — a fresh
    // VM, or a session with the display adapter disabled.
    hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags, levels, ARRAYSIZE(levels),
                           D3D11_SDK_VERSION, device.put(), nullptr, context.put());
  }
  return SUCCEEDED(hr) && device != nullptr && context != nullptr;
}

bool CaptureSession::Impl::EnsurePipeline() {
  winrt::com_ptr<ID3DBlob> vs_blob;
  winrt::com_ptr<ID3DBlob> ps_blob;
  winrt::com_ptr<ID3DBlob> vs_errors;
  winrt::com_ptr<ID3DBlob> ps_errors;

  const UINT compile_flags = D3DCOMPILE_OPTIMIZATION_LEVEL3 | D3DCOMPILE_ENABLE_STRICTNESS;
  if (FAILED(D3DCompile(kShaderSource, sizeof(kShaderSource) - 1, "scaler.hlsl", nullptr, nullptr,
                        "VSMain", "vs_4_0", compile_flags, 0, vs_blob.put(), vs_errors.put()))) {
    return false;
  }
  if (FAILED(D3DCompile(kShaderSource, sizeof(kShaderSource) - 1, "scaler.hlsl", nullptr, nullptr,
                        "PSMain", "ps_4_0", compile_flags, 0, ps_blob.put(), ps_errors.put()))) {
    return false;
  }

  if (FAILED(device->CreateVertexShader(vs_blob->GetBufferPointer(), vs_blob->GetBufferSize(),
                                        nullptr, vertex_shader.put())) ||
      FAILED(device->CreatePixelShader(ps_blob->GetBufferPointer(), ps_blob->GetBufferSize(),
                                       nullptr, pixel_shader.put()))) {
    return false;
  }

  D3D11_SAMPLER_DESC sampler_desc{};
  // Linear filtering: a 1.5x downscale with point sampling drops every third
  // row, which shreds small text — the one thing a screen share must keep
  // readable.
  sampler_desc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sampler_desc.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
  sampler_desc.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
  sampler_desc.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  sampler_desc.MaxLOD = D3D11_FLOAT32_MAX;
  if (FAILED(device->CreateSamplerState(&sampler_desc, sampler.put()))) return false;

  D3D11_BUFFER_DESC cb{};
  cb.ByteWidth = sizeof(ShaderParams);
  cb.Usage = D3D11_USAGE_DYNAMIC;
  cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  cb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  if (FAILED(device->CreateBuffer(&cb, nullptr, params_buffer.put()))) return false;

  D3D11_TEXTURE2D_DESC target{};
  target.Width = static_cast<UINT>(target_width());
  target.Height = static_cast<UINT>(target_height());
  target.MipLevels = 1;
  target.ArraySize = 1;
  target.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  target.SampleDesc.Count = 1;
  target.Usage = D3D11_USAGE_DEFAULT;
  target.BindFlags = D3D11_BIND_RENDER_TARGET;
  if (FAILED(device->CreateTexture2D(&target, nullptr, scaled.put()))) return false;
  if (FAILED(device->CreateRenderTargetView(scaled.get(), nullptr, scaled_rtv.put()))) return false;

  D3D11_TEXTURE2D_DESC readback = target;
  readback.Usage = D3D11_USAGE_STAGING;
  readback.BindFlags = 0;
  readback.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  if (FAILED(device->CreateTexture2D(&readback, nullptr, staging.put()))) return false;

  return true;
}

bool CaptureSession::Impl::EnsureSourceTextures(UINT width, UINT height) {
  if (source_copy != nullptr && source_width == width && source_height == height) return true;

  source_srv = nullptr;
  source_copy = nullptr;
  source_width = 0;
  source_height = 0;

  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  // A copy rather than an SRV over the frame pool's own texture: WGC does not
  // document the pool's bind flags, and a GPU-local copy costs far less than a
  // capture path that breaks on some driver.
  if (FAILED(device->CreateTexture2D(&desc, nullptr, source_copy.put()))) return false;
  if (FAILED(device->CreateShaderResourceView(source_copy.get(), nullptr, source_srv.put()))) {
    source_copy = nullptr;
    return false;
  }
  source_width = width;
  source_height = height;
  return true;
}

bool CaptureSession::Impl::RenderAndReadback(ID3D11Texture2D* source, UINT source_w, UINT source_h,
                                             UINT content_w, UINT content_h) {
  if (source_w == 0 || source_h == 0 || content_w == 0 || content_h == 0) return false;
  if (!EnsureSourceTextures(source_w, source_h)) return false;

  context->CopyResource(source_copy.get(), source);

  ShaderParams params;
  params.uv_scale_x = static_cast<float>(content_w) / static_cast<float>(source_w);
  params.uv_scale_y = static_cast<float>(content_h) / static_cast<float>(source_h);

  D3D11_MAPPED_SUBRESOURCE mapped_cb{};
  if (FAILED(context->Map(params_buffer.get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped_cb))) {
    return false;
  }
  std::memcpy(mapped_cb.pData, &params, sizeof(params));
  context->Unmap(params_buffer.get(), 0);

  // Letterbox rather than stretch. A 16:10 or portrait display squeezed into a
  // 16:9 track would misrepresent what the person is actually looking at.
  const float target_w = static_cast<float>(target_width());
  const float target_h = static_cast<float>(target_height());
  const float content_aspect = static_cast<float>(content_w) / static_cast<float>(content_h);
  float draw_w = target_w;
  float draw_h = target_w / content_aspect;
  if (draw_h > target_h) {
    draw_h = target_h;
    draw_w = target_h * content_aspect;
  }

  D3D11_VIEWPORT viewport{};
  viewport.TopLeftX = (target_w - draw_w) * 0.5f;
  viewport.TopLeftY = (target_h - draw_h) * 0.5f;
  viewport.Width = draw_w;
  viewport.Height = draw_h;
  viewport.MinDepth = 0.0f;
  viewport.MaxDepth = 1.0f;

  const float black[4] = {0.0f, 0.0f, 0.0f, 1.0f};
  context->ClearRenderTargetView(scaled_rtv.get(), black);

  ID3D11RenderTargetView* rtvs[] = {scaled_rtv.get()};
  ID3D11ShaderResourceView* srvs[] = {source_srv.get()};
  ID3D11SamplerState* samplers[] = {sampler.get()};
  ID3D11Buffer* buffers[] = {params_buffer.get()};

  context->OMSetRenderTargets(1, rtvs, nullptr);
  context->RSSetViewports(1, &viewport);
  context->IASetInputLayout(nullptr);
  context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  context->VSSetShader(vertex_shader.get(), nullptr, 0);
  context->VSSetConstantBuffers(0, 1, buffers);
  context->PSSetShader(pixel_shader.get(), nullptr, 0);
  context->PSSetShaderResources(0, 1, srvs);
  context->PSSetSamplers(0, 1, samplers);
  context->Draw(3, 0);

  // Unbind before the readback copy; leaving the render target bound while it
  // is used as a copy source raises a debug-layer hazard.
  ID3D11ShaderResourceView* no_srv[] = {nullptr};
  context->PSSetShaderResources(0, 1, no_srv);
  context->OMSetRenderTargets(0, nullptr, nullptr);

  context->CopyResource(staging.get(), scaled.get());

  D3D11_MAPPED_SUBRESOURCE mapped{};
  const HRESULT hr = context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr)) {
    if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
      Fail(CaptureStatus::kDeviceLost);
    }
    return false;
  }

  {
    std::lock_guard<std::mutex> lock(frame_mutex);
    pending.resize(frame_bytes());
    const std::size_t row_bytes = static_cast<std::size_t>(target_width()) * 4u;
    const auto* src = static_cast<const std::uint8_t*>(mapped.pData);
    std::uint8_t* dst = pending.data();
    // Row by row. A staging texture's RowPitch is padded to a driver-chosen
    // alignment, so a single bulk copy of RowPitch*height renders skewed.
    for (int y = 0; y < target_height(); ++y) {
      std::memcpy(dst + static_cast<std::size_t>(y) * row_bytes,
                  src + static_cast<std::size_t>(y) * mapped.RowPitch, row_bytes);
    }
    ++pending_seq;
  }

  context->Unmap(staging.get(), 0);
  return true;
}

void CaptureSession::Impl::OnFrameArrived(const wgc::Direct3D11CaptureFramePool& sender) {
  if (!running.load(std::memory_order_acquire)) return;

  wgc::Direct3D11CaptureFrame frame{nullptr};
  try {
    frame = sender.TryGetNextFrame();
  } catch (const winrt::hresult_error&) {
    Fail(CaptureStatus::kInternalError);
    return;
  }
  if (!frame) return;

  // Blackout is enforced here, before a single pixel is read off the GPU. A
  // blackout applied further downstream would mean the real desktop had already
  // been copied into process memory.
  if (blackout.load(std::memory_order_acquire)) {
    frame.Close();
    return;
  }

  const int fps = std::clamp(target_fps.load(std::memory_order_acquire), 1, 60);
  const auto now = Clock::now();
  const auto min_interval =
      std::chrono::microseconds(static_cast<long long>(1'000'000.0 / fps * 0.9));
  if (last_processed.time_since_epoch().count() != 0 && now - last_processed < min_interval) {
    // Source frames above the published rate are discarded before any GPU work.
    // Not counted as drops: nothing was owed to the viewer.
    frame.Close();
    return;
  }
  last_processed = now;

  try {
    const auto content = frame.ContentSize();
    auto access = frame.Surface().as<DxgiInterfaceAccess>();
    winrt::com_ptr<ID3D11Texture2D> texture;
    if (FAILED(access->GetInterface(__uuidof(ID3D11Texture2D), texture.put_void()))) {
      frame.Close();
      Fail(CaptureStatus::kInternalError);
      return;
    }

    D3D11_TEXTURE2D_DESC desc{};
    texture->GetDesc(&desc);
    const UINT content_w =
        std::min<UINT>(static_cast<UINT>(std::max<std::int32_t>(content.Width, 0)), desc.Width);
    const UINT content_h =
        std::min<UINT>(static_cast<UINT>(std::max<std::int32_t>(content.Height, 0)), desc.Height);

    {
      std::lock_guard<std::mutex> lock(gpu_mutex);
      if (running.load(std::memory_order_acquire) && device != nullptr) {
        RenderAndReadback(texture.get(), desc.Width, desc.Height, content_w, content_h);
      }
    }

    // The frame must be released before Recreate, or the pool still owns it.
    texture = nullptr;
    frame.Close();

    if (content.Width != pool_size.Width || content.Height != pool_size.Height) {
      // The display changed resolution. Recreating the pool at the new size is
      // the documented recovery; the next FrameArrived carries the new size.
      pool_size = content;
      sender.Recreate(winrt_device, wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
    }
  } catch (const winrt::hresult_error&) {
    Fail(CaptureStatus::kInternalError);
  }
}

void CaptureSession::Impl::PacerLoop() {
  std::vector<std::uint8_t> current(frame_bytes(), 0);
  std::vector<std::uint8_t> black(frame_bytes(), 0);
  // Opaque black. A half-transparent blackout is not a blackout.
  for (std::size_t i = 3; i < black.size(); i += 4) black[i] = 0xFF;

  std::uint64_t current_seq = 0;
  bool have_real_frame = false;
  bool blackout_already_emitted = false;
  auto next = Clock::now();

  while (running.load(std::memory_order_acquire)) {
    const int fps = std::clamp(target_fps.load(std::memory_order_acquire), 1, 60);
    next += std::chrono::microseconds(1'000'000 / fps);

    const auto now = Clock::now();
    if (next > now) {
      const auto wait_ms = std::chrono::duration_cast<std::chrono::milliseconds>(next - now).count();
      // A waitable event rather than sleep_for, so Stop interrupts the tick
      // instead of waiting it out — emergency stop has a 500 ms budget.
      if (WaitForSingleObject(wake, static_cast<DWORD>(std::max<long long>(wait_ms, 0))) ==
          WAIT_OBJECT_0) {
        break;
      }
    } else {
      // Fell behind (a long GPU stall, or the machine slept). Re-base rather
      // than firing a burst of catch-up frames at the encoder.
      next = now;
    }
    if (!running.load(std::memory_order_acquire)) break;

    const bool blacked_out = blackout.load(std::memory_order_acquire);
    bool repeated = true;

    if (blacked_out) {
      // Every blackout frame after the first is identical by construction.
      repeated = blackout_already_emitted;
      blackout_already_emitted = true;
    } else {
      blackout_already_emitted = false;
      std::lock_guard<std::mutex> lock(frame_mutex);
      if (pending_seq != current_seq && pending.size() == current.size()) {
        // O(1) handoff. The callback runs outside this lock, so a slow encoder
        // submission cannot stall the WGC threadpool thread.
        current.swap(pending);
        current_seq = pending_seq;
        repeated = false;
        have_real_frame = true;
      }
      // Nothing captured yet: publish nothing rather than a frame of grey.
      if (!have_real_frame) continue;
    }

    FrameView view;
    view.data = blacked_out ? black.data() : current.data();
    view.width = target_width();
    view.height = target_height();
    view.stride = target_width() * 4;
    view.repeated = repeated;

    if (on_frame) on_frame(view);
  }
}

CaptureSession::CaptureSession() : impl_(std::make_unique<Impl>()) {}

CaptureSession::~CaptureSession() { Stop(); }

bool CaptureSession::IsSupported() {
  try {
    return wgc::GraphicsCaptureSession::IsSupported();
  } catch (const winrt::hresult_error&) {
    return false;
  }
}

int CaptureSession::DisplayCount() { return static_cast<int>(EnumerateMonitors().size()); }

CaptureStatus CaptureSession::Start(const CaptureConfig& config, FrameCallback on_frame,
                                    Metrics* metrics) {
  if (impl_->running.load(std::memory_order_acquire)) return CaptureStatus::kInternalError;

  if (!IsSupported()) {
    // No silent fallback to DXGI. Desktop Duplication has no capture indicator,
    // and a monitoring product that can record without showing it is the exact
    // failure this design exists to prevent (ADR 0003).
    return CaptureStatus::kUnsupported;
  }

  impl_->config = config;
  impl_->config.width = std::max(config.width, 16);
  impl_->config.height = std::max(config.height, 16);
  impl_->on_frame = std::move(on_frame);
  impl_->metrics = metrics;
  impl_->target_fps.store(std::clamp(config.fps, 1, 60), std::memory_order_release);
  impl_->blackout.store(false, std::memory_order_release);
  impl_->status.store(CaptureStatus::kOk, std::memory_order_release);
  impl_->last_processed = {};
  impl_->pending_seq = 0;

  if (!impl_->EnsureDevice()) {
    Stop();
    return CaptureStatus::kInternalError;
  }
  if (!impl_->EnsurePipeline()) {
    Stop();
    return CaptureStatus::kInternalError;
  }

  const auto monitors = EnumerateMonitors();
  if (monitors.empty()) {
    Stop();
    return CaptureStatus::kDisplayGone;
  }
  const int index = std::clamp(config.display_index, 0, static_cast<int>(monitors.size()) - 1);

  impl_->wake = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (impl_->wake == nullptr) {
    Stop();
    return CaptureStatus::kInternalError;
  }

  try {
    auto dxgi_device = impl_->device.as<IDXGIDevice>();
    winrt::com_ptr<::IInspectable> inspectable;
    if (FAILED(CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.get(), inspectable.put()))) {
      Stop();
      return CaptureStatus::kInternalError;
    }
    impl_->winrt_device = inspectable.as<wgdx11::IDirect3DDevice>();

    auto interop =
        winrt::get_activation_factory<wgc::GraphicsCaptureItem, ::IGraphicsCaptureItemInterop>();
    if (FAILED(interop->CreateForMonitor(monitors[static_cast<std::size_t>(index)],
                                         winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                         winrt::put_abi(impl_->item))) ||
        !impl_->item) {
      Stop();
      return CaptureStatus::kItemFailed;
    }

    impl_->pool_size = impl_->item.Size();
    impl_->pool = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
        impl_->winrt_device, wgdx::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, impl_->pool_size);

    Impl* impl = impl_.get();
    impl_->frame_token = impl_->pool.FrameArrived(
        [impl](const wgc::Direct3D11CaptureFramePool& sender,
               const winrt::Windows::Foundation::IInspectable&) { impl->OnFrameArrived(sender); });

    impl_->closed_token = impl_->item.Closed(
        [impl](const wgc::GraphicsCaptureItem&, const winrt::Windows::Foundation::IInspectable&) {
          // The monitor was unplugged or the session ended. Recorded, not acted
          // on: tearing capture down from inside its own event handler would
          // deadlock revocation. The owner polls status().
          impl->Fail(CaptureStatus::kDisplayGone);
        });

    impl_->session = impl_->pool.CreateCaptureSession(impl_->item);
    impl_->session.IsCursorCaptureEnabled(config.capture_cursor);
    // IGraphicsCaptureSession3::IsBorderRequired(false) exists and is
    // deliberately never called. The system capture border is the tamper-proof
    // signal that monitoring is active; suppressing it is excluded by policy,
    // not missed by oversight.

    impl_->running.store(true, std::memory_order_release);
    impl_->session.StartCapture();
    impl_->pacer = std::thread([impl] { impl->PacerLoop(); });
  } catch (const winrt::hresult_error&) {
    Stop();
    return CaptureStatus::kItemFailed;
  }

  if (metrics != nullptr) {
    metrics->SetBackend(CaptureBackend::kWgc);
    metrics->SetBorderEnabled(true);
    metrics->SetResolution(impl_->config.width, impl_->config.height);
  }
  return CaptureStatus::kOk;
}

void CaptureSession::Stop() {
  if (!impl_) return;

  impl_->running.store(false, std::memory_order_release);
  if (impl_->wake != nullptr) SetEvent(impl_->wake);

  // Revoke first. Event revocation waits for an in-flight handler to finish, so
  // after this no further frame can be processed. gpu_mutex is deliberately not
  // held here — taking it would deadlock against a handler that already has it.
  try {
    if (impl_->pool != nullptr && impl_->frame_token.value != 0) {
      impl_->pool.FrameArrived(impl_->frame_token);
      impl_->frame_token = {};
    }
    if (impl_->item != nullptr && impl_->closed_token.value != 0) {
      impl_->item.Closed(impl_->closed_token);
      impl_->closed_token = {};
    }
    if (impl_->session != nullptr) {
      impl_->session.Close();
      impl_->session = nullptr;
    }
    if (impl_->pool != nullptr) {
      impl_->pool.Close();
      impl_->pool = nullptr;
    }
  } catch (const winrt::hresult_error&) {
    // Already torn down by the system; nothing useful to do while stopping.
  }
  impl_->item = nullptr;
  impl_->winrt_device = nullptr;

  if (impl_->pacer.joinable()) impl_->pacer.join();

  if (impl_->wake != nullptr) {
    CloseHandle(impl_->wake);
    impl_->wake = nullptr;
  }

  {
    std::lock_guard<std::mutex> lock(impl_->gpu_mutex);
    impl_->staging = nullptr;
    impl_->scaled_rtv = nullptr;
    impl_->scaled = nullptr;
    impl_->source_srv = nullptr;
    impl_->source_copy = nullptr;
    impl_->source_width = 0;
    impl_->source_height = 0;
    impl_->params_buffer = nullptr;
    impl_->sampler = nullptr;
    impl_->pixel_shader = nullptr;
    impl_->vertex_shader = nullptr;
    impl_->context = nullptr;
    impl_->device = nullptr;
  }

  {
    std::lock_guard<std::mutex> lock(impl_->frame_mutex);
    impl_->pending.clear();
    impl_->pending.shrink_to_fit();
    impl_->pending_seq = 0;
  }

  // Released only after the pacer has joined, so the callback can never run
  // against a destroyed target.
  impl_->on_frame = nullptr;
}

bool CaptureSession::running() const {
  return impl_ && impl_->running.load(std::memory_order_acquire);
}

CaptureStatus CaptureSession::status() const {
  if (!impl_) return CaptureStatus::kInternalError;
  return impl_->status.load(std::memory_order_acquire);
}

void CaptureSession::SetTargetFps(int fps) {
  if (!impl_) return;
  impl_->target_fps.store(std::clamp(fps, 1, 60), std::memory_order_release);
}

void CaptureSession::SetBlackout(bool enabled) {
  if (!impl_) return;
  impl_->blackout.store(enabled, std::memory_order_release);
}

bool CaptureSession::BorderEnabled() const { return true; }

}  // namespace engosoft::media
