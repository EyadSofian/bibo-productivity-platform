import { Room, RoomEvent, Track } from "livekit-client";
import { livekitTransport } from "../src/media/livekitTransport";

// Real WebRTC through the production adapter, using synthetic moving pixels.
// Kept outside src so it is never a route or feature in the deployed admin app.
const button = document.querySelector<HTMLButtonElement>("button")!;
const output = document.querySelector<HTMLElement>("pre")!;
const video = document.querySelector<HTMLVideoElement>("video")!;
const canvas = document.querySelector<HTMLCanvasElement>("canvas")!;
const ctx = canvas.getContext("2d")!;
const report = (message: string) => { output.textContent += `${message}\n`; };
const until = async (predicate: () => boolean, label: string, ms = 15000) => {
  const deadline = performance.now() + ms;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};

button.onclick = async () => {
  button.disabled = true;
  output.textContent = "";
  let credentials: { room: string; url: string; publisher: string; viewer: string } | undefined;
  let disconnect: (() => void) | undefined;
  const publisher = new Room();
  let localStream: MediaStream | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let lost = false;
  let stopSucceeded = false;
  try {
    const response = await fetch("/start", { method: "POST" });
    if (!response.ok) throw new Error(`Room creation returned ${response.status}`);
    credentials = await response.json();
    const c = credentials!;
    report("PASS: real SFU room created by backend provider");
    disconnect = await livekitTransport.connect({ token: c.viewer, room: c.room, url: c.url }, {
      onStream(stream) { video.srcObject = stream; void video.play().catch(() => {}); },
      onStreamLost() { lost = true; video.srcObject = null; },
      onState(state) { report(`Viewer: ${state}`); if (state === "closed") closed = true; },
      onError() { report("Transport error"); },
    });
    await publisher.connect(c.url, c.publisher);
    if (!publisher.localParticipant.permissions?.canPublish || publisher.localParticipant.permissions?.canSubscribe || publisher.localParticipant.permissions?.canPublishData) {
      throw new Error("SFU publisher permissions exceed scope");
    }
    report("PASS: SFU accepts restricted publisher token");
    let frame = 0;
    timer = setInterval(() => {
      ctx.fillStyle = frame % 30 < 15 ? "#186ddd" : "#de8a12";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "white"; ctx.font = "32px sans-serif";
      ctx.fillText(`Synthetic frame ${frame++}`, 30, 100);
    }, 66);
    localStream = canvas.captureStream(15);
    await publisher.localParticipant.publishTrack(localStream.getVideoTracks()[0], { source: Track.Source.ScreenShare, videoCodec: "h264", simulcast: false });
    await until(() => video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames >= 15, "decode 15 remote frames");
    report(`PASS: browser decoded ${video.getVideoPlaybackQuality().totalVideoFrames} H.264 frames at ${video.videoWidth}×${video.videoHeight}`);
    // Read the decoded remote video, not the source canvas. Changing pixel values
    // prove advancing media rather than just a subscribed-but-frozen track.
    const probe = document.createElement("canvas"); probe.width = 1; probe.height = 1;
    const pixels = probe.getContext("2d", { willReadFrequently: true })!;
    const colours = new Set<string>();
    for (let i = 0; i < 25; i++) {
      pixels.drawImage(video, 0, 0, 1, 1);
      colours.add(Array.from(pixels.getImageData(0, 0, 1, 1).data).join(","));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (colours.size < 2) throw new Error("Received video is frozen");
    report(`PASS: remote decoded pixels change (${colours.size} samples)`);
    let publisherDisconnected = false;
    publisher.on(RoomEvent.Disconnected, () => { publisherDisconnected = true; });
    const stopped = await fetch("/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: c.room }) });
    if (!stopped.ok) throw new Error(`Room deletion returned ${stopped.status}`);
    stopSucceeded = true;
    await until(() => closed && lost && publisherDisconnected, "server-driven disconnect and video removal");
    report("PASS: backend stop disconnects both peers and clears the viewer");
    report("RESULT: PASS — real SFU + H.264 + production browser transport. Actual Windows screen capture remains a separate check.");
    document.body.dataset.result = "passed";
  } catch (error) {
    report(`RESULT: FAIL — ${error instanceof Error ? error.message : "Unknown failure"}`);
    document.body.dataset.result = "failed";
  } finally {
    if (timer) clearInterval(timer);
    localStream?.getTracks().forEach(track => track.stop());
    disconnect?.(); await publisher.disconnect(); video.srcObject = null;
    if (credentials && !stopSucceeded) {
      await fetch("/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: credentials.room }) }).catch(() => {});
    }
    button.disabled = false;
  }
};
