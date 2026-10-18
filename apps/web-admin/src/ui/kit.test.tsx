import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { DayNav, UsageList } from "./kit";
import { addDays } from "../lib/day";

beforeAll(() => i18n.changeLanguage("en"));

describe("UsageList", () => {
  const items = [
    { key: "a", name: "github.com", seconds: 600, detail: [{ key: "p", primary: "Pull requests", value: "10m", href: "https://github.com/pulls" }] },
    { key: "b", name: "Slack", seconds: 300 },
  ];

  it("shows each item's share of the total", () => {
    render(<UsageList items={items} total={900} format={(s) => `${s}s`} emptyTitle="none" />);
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("33%")).toBeTruthy();
  });

  it("expands an item to reveal its detail rows", () => {
    render(<UsageList items={items} total={900} format={(s) => `${s}s`} emptyTitle="none" />);
    expect(screen.queryByText("Pull requests")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /github\.com/ }));
    expect(screen.getByRole("link", { name: "Pull requests" }).getAttribute("rel")).toContain("noopener");
  });

  it("says so when there is nothing to list", () => {
    render(<UsageList items={[]} total={0} format={String} emptyTitle="Nothing yet" />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });
});

describe("DayNav", () => {
  it("cannot move past today", () => {
    render(<DayNav value={new Date()} onChange={() => {}} />);
    expect((screen.getByRole("button", { name: "Next day" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("steps one day back", () => {
    const onChange = vi.fn();
    const today = new Date();
    render(<DayNav value={today} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    expect(onChange.mock.calls[0][0].toDateString()).toBe(addDays(today, -1).toDateString());
  });
});
