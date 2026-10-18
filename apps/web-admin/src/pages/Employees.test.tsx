import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS, renderPage } from "../test/render";

vi.mock("../api/endpoints", () => ({
  listMyBusinesses: vi.fn(),
  listBusinessEmployees: vi.fn(),
  reportEmployees: vi.fn(),
  listOrganization: vi.fn(),
  getBusinessJoinCode: vi.fn(),
  rotateBusinessJoinCode: vi.fn(),
  createEmployee: vi.fn(),
  createBusiness: vi.fn(),
  assignEmployeeOrganization: vi.fn(),
}));

import * as api from "../api/endpoints";
import Employees from "./Employees";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listMyBusinesses).mockResolvedValue({ businesses: [BUSINESS] });
  vi.mocked(api.listBusinessEmployees).mockResolvedValue({
    employees: [
      { id: "e1", email: "", username: "omar", display_name: "Omar Adel", department_id: null, department_name: "", job_role_id: null, job_role_name: "" },
      { id: "e2", email: "sara@engosoft.com", display_name: "Sara Nabil", department_id: "d1", department_name: "Sales", job_role_id: null, job_role_name: "" },
    ],
  });
  vi.mocked(api.reportEmployees).mockResolvedValue({ employees: [] });
  vi.mocked(api.getBusinessJoinCode).mockResolvedValue({ join_code: "example-join-code" });
  vi.mocked(api.listOrganization).mockResolvedValue({
    departments: [{ id: "d1", business_id: BUSINESS.id, name: "Sales", description: "", created_at: "", updated_at: "" }],
    job_roles: [],
  });
});

describe("Employees", () => {
  it("shows the private join code to the owner", async () => {
    await renderPage(<Employees />);
    expect(await screen.findByText("example-join-code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy join code" })).toBeTruthy();
  });
  it("filters by name and by department", async () => {
    await renderPage(<Employees />);
    expect(await screen.findByText("Omar Adel")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "sara" } });
    expect(screen.queryByText("Omar Adel")).toBeNull();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Department" }), { target: { value: "d1" } });
    expect(screen.queryByText("Omar Adel")).toBeNull();
    expect(screen.getByText("Sara Nabil")).toBeTruthy();
  });

  it("adds an employee with a lowercased username and shows the login once", async () => {
    vi.mocked(api.createEmployee).mockResolvedValue({} as never);
    await renderPage(<Employees />);
    fireEvent.click(await screen.findByRole("button", { name: "Add employee" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Mona Ali" } });
    fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "Mona" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "s3cretpass" } });
    fireEvent.submit(screen.getByLabelText("Full name").closest("form")!);
    await waitFor(() =>
      expect(api.createEmployee).toHaveBeenCalledWith({
        display_name: "Mona Ali",
        email: undefined,
        username: "mona",
        password: "s3cretpass",
        business_id: BUSINESS.id,
      }),
    );
    expect(await screen.findByText("Employee added")).toBeTruthy();
    expect(screen.getByText("mona")).toBeTruthy();
  });

  it("refuses a short password before calling the server", async () => {
    await renderPage(<Employees />);
    fireEvent.click(await screen.findByRole("button", { name: "Add employee" }));
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Mona Ali" } });
    fireEvent.change(screen.getByLabelText("Email or username"), { target: { value: "mona" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "short" } });
    fireEvent.submit(screen.getByLabelText("Full name").closest("form")!);
    expect(await screen.findByText("Use at least 8 characters for the password.")).toBeTruthy();
    expect(api.createEmployee).not.toHaveBeenCalled();
  });
});
