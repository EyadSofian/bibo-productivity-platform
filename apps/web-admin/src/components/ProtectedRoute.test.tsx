import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import { ProtectedRoute } from "./ProtectedRoute";
import { tokenStore } from "../api/tokenStore";
import type { Tokens, User } from "../api/types";

const tokens: Tokens = { access_token: "access-1", refresh_token: "refresh-1", expires_in: 900 };
const user: User = {
  id: "u1",
  email: "owner@example.com",
  display_name: "Owner",
  account_type: "manager",
};

function LoginProbe() {
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "";
  return <div data-testid="login">login:{from}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<div data-testid="dashboard">dashboard</div>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  tokenStore.clear();
});

describe("ProtectedRoute", () => {
  it("redirects an unauthenticated visitor to /login", () => {
    renderAt("/dashboard");

    expect(screen.getByTestId("login")).toBeDefined();
    expect(screen.queryByTestId("dashboard")).toBeNull();
  });

  it("remembers where the visitor was headed", () => {
    renderAt("/dashboard");

    expect(screen.getByTestId("login").textContent).toBe("login:/dashboard");
  });

  it("renders the guarded route for a signed-in owner", () => {
    tokenStore.setSession(tokens, user);

    renderAt("/dashboard");

    expect(screen.getByTestId("dashboard")).toBeDefined();
    expect(screen.queryByTestId("login")).toBeNull();
  });
});
