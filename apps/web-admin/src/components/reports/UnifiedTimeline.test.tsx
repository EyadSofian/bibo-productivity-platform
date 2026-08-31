import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type {
  ActivityResponse,
  BrowserVisit,
  KeystrokeBucket,
  OsStateReport,
  ScreenshotMeta,
} from "../../api/types";
import { UnifiedTimeline } from "./UnifiedTimeline";

const DAY_START = 1788134400;
const DAY_END = DAY_START + 86400;
const H = 3600;

const states: OsStateReport = {
  totals: {
    active_s: 2 * H, idle_s: H, suspended_s: 0, offline_s: 0, covered_s: 3 * H, elapsed_s: 86400,
  },
  first_activity: DAY_START + 9 * H,
  last_activity: DAY_START + 11 * H,
  intervals: [
    { state: "active", ts: DAY_START + 9 * H, duration_s: 2 * H },
    { state: "idle", ts: DAY_START + 11 * H, duration_s: H },
  ],
};

const activity: ActivityResponse = {
  samples: [
    { ts: DAY_START + 9 * H, app_name: "Visual Studio Code", window_title: "main.rs", duration_s: H },
  ],
  breakdown: [{ app_name: "Visual Studio Code", duration_s: H }],
};

const buckets: KeystrokeBucket[] = [{ ts_bucket: DAY_START + 9 * H, count: 120 }];

const visits: BrowserVisit[] = [
  {
    ts: DAY_START + 10 * H, url: "https://docs.example.test/a", domain: "docs.example.test",
    page_title: "Docs", browser: "chrome", duration_s: 600,
  },
];

const shots: ScreenshotMeta[] = [
  { client_uuid: "shot-1", ts: DAY_START + 9 * H + 300, byte_size: 1, width: 1, height: 1, display_id: 0 },
];

function renderTimeline(over: Partial<React.ComponentProps<typeof UnifiedTimeline>> = {}) {
  return render(
    <UnifiedTimeline
      from={DAY_START}
      to={DAY_END}
      states={states}
      activity={activity}
      buckets={buckets}
      visits={visits}
      shots={shots}
      {...over}
    />,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  document.documentElement.dir = "ltr";
});

describe("UnifiedTimeline", () => {
  it("draws a lane for each source that has data", () => {
    const { container } = renderTimeline();
    const labels = [...container.querySelectorAll(".ad-tl__lanelabel")].map((el) => el.textContent);
    expect(labels).toEqual(["Device state", "Applications", "Websites", "Input", "Screenshots"]);
  });

  it("omits a lane whose source is empty rather than showing an empty row", () => {
    const { container } = renderTimeline({ visits: [], buckets: [], shots: [] });
    const labels = [...container.querySelectorAll(".ad-tl__lanelabel")].map((el) => el.textContent);
    expect(labels).toEqual(["Device state", "Applications"]);
  });

  it("says nothing was reported instead of drawing an all-offline band", () => {
    renderTimeline({ states: null, activity: null, buckets: [], visits: [], shots: [] });
    expect(screen.getByText(/nothing was reported/i)).toBeTruthy();
  });

  it("keeps the state band gapless across the window", () => {
    const { container } = renderTimeline();
    const track = container.querySelector(".ad-tl__track");
    const blocks = [...track!.querySelectorAll(".ad-tl__block")] as HTMLElement[];
    // Offline before, active, idle, offline after.
    expect(blocks.length).toBe(4);
    const first = blocks[0].style.getPropertyValue("inset-inline-start");
    expect(first).toBe("0%");
  });

  it("shows details on hover, including the window title", () => {
    const { container } = renderTimeline();
    const appLane = container.querySelectorAll(".ad-tl__lane")[1];
    const block = appLane.querySelector(".ad-tl__block") as HTMLElement;
    fireEvent.mouseEnter(block);
    expect(screen.getByText("Visual Studio Code")).toBeTruthy();
    expect(screen.getByText("main.rs")).toBeTruthy();

    fireEvent.mouseLeave(block);
    expect(screen.queryByText("main.rs")).toBeNull();
  });

  it("seeks to the moment that was clicked", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ onSeek });
    const appLane = container.querySelectorAll(".ad-tl__lane")[1];
    fireEvent.click(appLane.querySelector(".ad-tl__block")!);
    expect(onSeek).toHaveBeenCalledWith(DAY_START + 9 * H);
  });

  it("seeks from the keyboard so the timeline is not mouse-only", () => {
    const onSeek = vi.fn();
    const { container } = renderTimeline({ onSeek });
    const marker = container.querySelector(".ad-tl__marker") as HTMLElement;
    expect(marker.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(marker, { key: "Enter" });
    expect(onSeek).toHaveBeenCalledWith(shots[0].ts);

    onSeek.mockClear();
    fireEvent.keyDown(marker, { key: " " });
    expect(onSeek).toHaveBeenCalledWith(shots[0].ts);

    onSeek.mockClear();
    fireEvent.keyDown(marker, { key: "a" });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("is not interactive when there is nowhere to seek to", () => {
    const { container } = renderTimeline({ onSeek: undefined });
    const block = container.querySelector(".ad-tl__block") as HTMLElement;
    expect(block.getAttribute("role")).toBeNull();
    expect(block.getAttribute("tabindex")).toBeNull();
  });

  it("gives interactive blocks an accessible name", () => {
    const { container } = renderTimeline({ onSeek: vi.fn() });
    const block = container.querySelector(".ad-tl__block") as HTMLElement;
    expect(block.getAttribute("aria-label")).toBeTruthy();
  });

  // The axis must read earliest-first in Arabic too. Mirroring a clock axis
  // puts the end of the day on the left, which misreads at a glance.
  it("keeps time running left-to-right under RTL", async () => {
    await i18n.changeLanguage("ar");
    document.documentElement.dir = "rtl";
    const { container } = renderTimeline();

    const frame = container.querySelector(".ad-tl__frame") as HTMLElement;
    expect(frame.getAttribute("dir")).toBe("ltr");

    // And the earlier tick is still positioned before the later one.
    const ticks = [...container.querySelectorAll(".ad-tl__tick")] as HTMLElement[];
    const positions = ticks.map((tick) => parseFloat(tick.style.left));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("translates the lane labels", async () => {
    await i18n.changeLanguage("ar");
    const { container } = renderTimeline();
    const labels = [...container.querySelectorAll(".ad-tl__lanelabel")].map((el) => el.textContent);
    expect(labels[0]).toBe("حالة الجهاز");
    expect(labels).not.toContain("Device state");
  });

  it("states plainly that input is a count only", () => {
    renderTimeline();
    expect(screen.getByText(/count of keypresses only/i)).toBeTruthy();
  });

  // A two-second window focus is common; collapsing it to zero width would
  // make it invisible and unclickable.
  it("gives a very short block a usable minimum width", () => {
    const { container } = renderTimeline({
      activity: {
        samples: [
          { ts: DAY_START + 9 * H, app_name: "Finder", window_title: "", duration_s: 2 },
        ],
        breakdown: [],
      },
    });
    const appLane = container.querySelectorAll(".ad-tl__lane")[1];
    const block = appLane.querySelector(".ad-tl__block") as HTMLElement;
    expect(parseFloat(block.style.width)).toBeGreaterThan(0);
  });
});
