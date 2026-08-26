import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import type { Department, Employee, JobRole } from "../api/types";
import { Organization } from "./Organization";

const endpointMocks = vi.hoisted(() => ({
  listOrganization: vi.fn(),
  listBusinessEmployees: vi.fn(),
  saveDepartment: vi.fn(),
  saveJobRole: vi.fn(),
  deleteOrganizationItem: vi.fn(),
  assignEmployeeOrganization: vi.fn(),
}));

vi.mock("../api/endpoints", () => endpointMocks);
vi.mock("../useBusinesses", () => ({
  useBusinesses: () => ({ selectedId: "business-1", loading: false }),
}));

const department: Department = {
  id: "department-1", business_id: "business-1", name: "Engineering", description: "Product delivery",
  created_at: "2026-08-26T00:00:00Z", updated_at: "2026-08-26T00:00:00Z",
};
const role: JobRole = {
  id: "role-1", business_id: "business-1", name: "Developer", description: "Software engineering",
  created_at: "2026-08-26T00:00:00Z", updated_at: "2026-08-26T00:00:00Z",
};
const employee: Employee = {
  id: "employee-1", email: "amina@example.com", display_name: "Amina Farouk", username: undefined,
  department_id: null, department_name: "", job_role_id: null, job_role_name: "",
};

beforeEach(async () => {
  Object.values(endpointMocks).forEach((mock) => mock.mockReset());
  endpointMocks.listOrganization.mockResolvedValue({ departments: [department], job_roles: [role] });
  endpointMocks.listBusinessEmployees.mockResolvedValue({ employees: [employee] });
  await i18n.changeLanguage("en");
});

describe("Organization", () => {
  it("creates a department inside the selected business", async () => {
    endpointMocks.saveDepartment.mockResolvedValue({ department });
    render(<Organization />);
    expect((await screen.findAllByText("Engineering")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "New department" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Customer Success" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(endpointMocks.saveDepartment).toHaveBeenCalledWith(null, {
      business_id: "business-1", name: "Customer Success", description: "",
    }));
  });

  it("assigns a department without changing the employee's job role", async () => {
    endpointMocks.assignEmployeeOrganization.mockResolvedValue({ employee: {
      ...employee, department_id: department.id, department_name: department.name,
    } });
    render(<Organization />);
    const select = await screen.findByRole("combobox", { name: "Department for Amina Farouk" });
    fireEvent.change(select, { target: { value: department.id } });

    await waitFor(() => expect(endpointMocks.assignEmployeeOrganization).toHaveBeenCalledWith(
      "business-1", "employee-1", "department-1", null,
    ));
  });
});
