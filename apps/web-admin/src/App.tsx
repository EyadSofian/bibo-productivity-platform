import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { BusinessProvider } from "./app/useBusinesses";
import { ThemeProvider } from "./app/theme";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AuthProvider } from "./auth/AuthContext";
import { SignIn } from "./auth/SignIn";
import { SignUp } from "./auth/SignUp";

// The shell loads at once; each page is its own chunk.
const Overview = lazy(() => import("./pages/Overview"));
const Employees = lazy(() => import("./pages/Employees"));
const EmployeeDay = lazy(() => import("./pages/EmployeeDay"));
const LiveMonitor = lazy(() => import("./pages/LiveMonitor"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Devices = lazy(() => import("./pages/Devices"));
const Settings = lazy(() => import("./pages/Settings"));

function PageFallback() {
  return (
    <div className="page" role="status" aria-busy="true" style={{ placeItems: "center", minHeight: "40vh" }}>
      <span className="spinner" />
    </div>
  );
}

const page = (node: ReactNode) => <Suspense fallback={<PageFallback />}>{node}</Suspense>;

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, "")}>
          <Routes>
            <Route path="/login" element={<SignIn />} />
            <Route path="/signup" element={<SignUp />} />
            <Route element={<ProtectedRoute />}>
              <Route
                element={
                  <BusinessProvider>
                    <AppShell />
                  </BusinessProvider>
                }
              >
                <Route index element={page(<Overview />)} />
                <Route path="employees" element={page(<Employees />)} />
                <Route path="employees/:id" element={page(<EmployeeDay />)} />
                <Route path="live" element={page(<LiveMonitor />)} />
                <Route path="tasks" element={page(<Tasks />)} />
                <Route path="devices" element={page(<Devices />)} />
                <Route path="settings" element={page(<Settings />)} />
                <Route path="monitoring" element={<Navigate to="/settings?tab=schedules" replace />} />
                <Route path="organization" element={<Navigate to="/settings?tab=organization" replace />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
