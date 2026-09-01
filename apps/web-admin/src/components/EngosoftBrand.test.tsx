import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EngosoftBrand } from "./EngosoftBrand";

describe("EngosoftBrand", () => {
  it("exposes the product name to assistive technology", () => {
    render(<EngosoftBrand />);
    expect(screen.getByLabelText("Engosoft Workforce")).toBeTruthy();
  });

  it("renders the Engosoft wordmark in the full lockup", () => {
    render(<EngosoftBrand />);
    expect(screen.getByText("ENGO")).toBeTruthy();
    expect(screen.getByText("SOFT")).toBeTruthy();
  });

  it("keeps the compact rail mark free of duplicate visible words", () => {
    const { container } = render(<EngosoftBrand compact />);
    expect(container.querySelector(".engosoft-brand__wordmark")).toBeNull();
    expect(container.querySelector(".engosoft-brand--compact")).toBeTruthy();
  });
});
