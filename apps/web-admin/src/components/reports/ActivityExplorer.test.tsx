import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import { ActivityExplorer } from "./ActivityExplorer";

beforeEach(async () => { await i18n.changeLanguage("en"); });

describe("ActivityExplorer", () => {
  it("finds exact URLs and opens the matching recorded moment", () => {
    const onPlay = vi.fn();
    render(<ActivityExplorer
      activity={{ samples: [{ ts: 1000, app_name: "Chrome", window_title: "Work", duration_s: 60 }], breakdown: [{ app_name: "Chrome", duration_s: 60 }] }}
      visits={[
        { ts: 2000, url: "https://example.com/first", domain: "example.com", page_title: "First", browser: "Chrome", duration_s: 30 },
        { ts: 3000, url: "https://example.com/second", domain: "example.com", page_title: "Second", browser: "Chrome", duration_s: 90 },
      ]}
      onPlay={onPlay}
    />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "second" } });
    expect(screen.getByText("https://example.com/second")).toBeTruthy();
    expect(screen.queryByText("https://example.com/first")).toBeNull();
    expect(screen.getByText("1m")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Watch video" }));
    expect(onPlay).toHaveBeenCalledWith(3000, null, "https://example.com/second");
  });
});
