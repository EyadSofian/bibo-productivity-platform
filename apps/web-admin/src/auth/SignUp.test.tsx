import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";

vi.mock("../api/endpoints", () => ({
  listPublicBusinesses: vi.fn(),
  registerEmployee: vi.fn(),
  register: vi.fn(),
  createBusiness: vi.fn(),
}));
vi.mock("./AuthContext", () => ({ useAuth: () => ({ setSession: vi.fn() }) }));

import * as api from "../api/endpoints";
import { SignUp } from "./SignUp";

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(api.listPublicBusinesses).mockResolvedValue({
    businesses: [{ business_id: "biz-1", name: "Engosoft", owner_name: "Owner" }],
  });
  vi.mocked(api.registerEmployee).mockResolvedValue({ status: "joined" });
});

describe("employee signup", () => {
  it("joins the selected company immediately with its private code", async () => {
    render(<MemoryRouter><SignUp /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Mona Ali" } });
    fireEvent.change(await screen.findByLabelText("Company"), { target: { value: "biz-1" } });
    fireEvent.change(screen.getByLabelText(/^Join code/), { target: { value: "join-secret" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "mona@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "safe-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Join now" }));
    await waitFor(() => expect(api.registerEmployee).toHaveBeenCalledWith({
      business_id: "biz-1",
      join_code: "join-secret",
      email: "mona@example.com",
      password: "safe-password",
      display_name: "Mona Ali",
    }));
    expect(await screen.findByText("You've joined your company")).toBeTruthy();
    expect(api.register).not.toHaveBeenCalled();
  });
});
