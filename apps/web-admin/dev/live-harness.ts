// Dev-only harness. Not part of the production build: Vite's build input is
// index.html, so nothing here ships.
//
// It exists so the live player can be worked on -- and demonstrated -- with no
// SFU and no Windows machine, by driving the real transport code from a canvas.
import { SyntheticTransport } from "../src/media/syntheticTransport";
import { releaseStream } from "../src/media/transport";

const video = document.getElementById("video") as HTMLVideoElement;
const stateEl = document.getElementById("state") as HTMLElement;
const tracksEl = document.getElementById("tracks") as HTMLElement;

let teardown: (() => void) | null = null;
let stream: MediaStream | null = null;

async function start() {
  if (teardown) return;
  const transport = new SyntheticTransport({ width: 1280, height: 720, fps: 15 });
  teardown = await transport.connect(
    { token: "harness", room: "harness" },
    {
      onStream: (s) => {
        stream = s;
        video.srcObject = s;
        tracksEl.textContent = String(s.getTracks().length);
        void video.play().catch(() => {});
      },
      onState: (s) => {
        stateEl.textContent = s;
      },
      onError: (e) => {
        stateEl.textContent = `failed: ${e.message}`;
      },
    },
  );
}

function stop() {
  teardown?.();
  teardown = null;
  video.srcObject = null;
  releaseStream(stream);
  stream = null;
  tracksEl.textContent = "0";
}

document.getElementById("start")!.addEventListener("click", () => void start());
document.getElementById("stop")!.addEventListener("click", stop);
void start();
